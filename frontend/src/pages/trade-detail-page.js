
import { initializeApp } from 'firebase/app'
import { firebaseConfig }  from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, getTrade, completeTrade, cancelTrade, markTradePaid, disputeTrade, leaveTradeFeedback, editTradeFeedback, listPaymentMethods, resolveDispute } from '../api.js'
import { showAlert, showConfirm, showFeedbackModal, showDisputeModal } from '../modal.js'
import { initChat } from '../chat.js'
import { avatarPathFromProfile, avatarPathFromNumber } from '../avatar.js'
import { getPresenceBadgeState } from '../presence.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

let currentUser = null
let currentTrade = null
let usdPrices = null
let statusCountdownTimer = null
let paymentMethodNameMap = null

const COIN_TO_GECKO = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
}

async function getUsdPrices() {
  if (usdPrices) return usdPrices
  const ids = Object.values(COIN_TO_GECKO).join(',')
  const query = `?ids=${encodeURIComponent(ids)}`
  const candidates = [`/api/wallet/prices${query}`, `/wallet/prices${query}`]

  for (const url of candidates) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      usdPrices = await res.json()
      return usdPrices
    } catch {

    }
  }

  return {}
}

async function getUsdPriceForCoin(coin) {
  const prices = await getUsdPrices()
  const geckoId = COIN_TO_GECKO[String(coin || '').toUpperCase()]
  if (!geckoId) return null
  const price = Number(prices?.[geckoId]?.usd || 0)
  return price > 0 ? price : null
}

function prettifyPaymentMethodId(raw) {
  return String(raw || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

async function resolvePaymentMethodName(cardId) {
  const raw = String(cardId || '').trim()
  if (!raw) return '—'

  if (!paymentMethodNameMap) {
    try {
      const methods = await listPaymentMethods()
      paymentMethodNameMap = new Map(
        (methods || []).map((method) => [String(method.id || '').toLowerCase(), method.name || method.id || ''])
      )
    } catch {
      paymentMethodNameMap = new Map()
    }
  }

  return paymentMethodNameMap.get(raw.toLowerCase()) || prettifyPaymentMethodId(raw)
}

function clearStatusCountdownTimer() {
  if (!statusCountdownTimer) return
  clearInterval(statusCountdownTimer)
  statusCountdownTimer = null
}

function formatMinutesLeft(expiresAt) {
  const expiry = Number(expiresAt || 0)
  if (!Number.isFinite(expiry) || expiry <= 0) return '—'

  const secondsLeft = Math.max(0, expiry - Math.floor(Date.now() / 1000))
  if (secondsLeft <= 0) return 'Expired'

  const minutesLeft = Math.ceil(secondsLeft / 60)
  return `${minutesLeft} min left`
}

function bindStatusCountdown(expiresAt) {
  clearStatusCountdownTimer()
  const label = document.getElementById('trade-status-countdown')
  if (!label) return

  const refresh = () => {
    label.textContent = formatMinutesLeft(expiresAt)
  }

  refresh()
  statusCountdownTimer = setInterval(refresh, 30 * 1000)
}

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }
  currentUser = user
  document.getElementById('auth-loading')?.classList.add('hidden')

  let profile
  try { profile = await upsertUser() } catch { profile = { email: user.email } }

  const navAuth = document.getElementById('nav-auth')
  const label   = profile?.username ? `@${profile.username}` : user.email
  const photo   = avatarPathFromProfile(profile)
  const initial = (profile?.first_name || profile?.username || label || '?').charAt(0).toUpperCase()
  navAuth.innerHTML = `
    <span id="nav-available-balance" class="nav-balance-sm" title="Available balance">Bal: --</span>
    <a href="/settings.html" class="nav-profile-link" title="Account Settings">
      <span class="nav-avatar-sm">${photo ? `<img src="${photo}" alt="" />` : initial}</span>
      <span class="nav-username-sm">${label}</span>
    </a>
    <button id="btn-logout" class="btn-sm">Sign Out</button>
  `
  navAuth.querySelector('#btn-logout').addEventListener('click', () => logOut())
  setupUnreadTradeNotifications({ user, navAuth })
  ensureDevBalanceTools()
  void refreshNavCombinedBalance()

  initChat(firebaseApp, currentUser.uid)
  await loadTrade()
})

document.addEventListener('trade-updated', async (e) => {
  const trade = e?.detail?.trade
  if (!trade?.id || !currentTrade?.id) return
  if (String(trade.id) !== String(currentTrade.id)) return

  currentTrade = { ...currentTrade, ...trade }
  await displayTrade()
  syncTradeChatState(partnerUsernameForChat(currentTrade))
})

async function loadTrade() {
  const params = new URLSearchParams(window.location.search)
  const tradeId = params.get('id')

  if (!tradeId) {
    document.getElementById('trade-detail-page').classList.remove('hidden')
    document.getElementById('trade-card-container').innerHTML = '<p class="error">No trade ID provided.</p>'
    return
  }

  try {
    currentTrade = await getTrade(tradeId)

    if (!currentTrade) {
      document.getElementById('trade-detail-page').classList.remove('hidden')
      document.getElementById('trade-card-container').innerHTML = '<p class="error">Trade not found.</p>'
      return
    }

    await displayTrade()
    document.getElementById('trade-detail-page').classList.remove('hidden')

    syncTradeChatState(partnerUsernameForChat(currentTrade))
  } catch (e) {
    document.getElementById('trade-detail-page').classList.remove('hidden')
    document.getElementById('trade-card-container').innerHTML = `<p class="error">Failed to load trade: ${e.message}</p>`
  }
}

async function displayTrade() {
  const t = currentTrade
  const isCreator = currentUser && t.creator_uid === currentUser.uid
  const isOfferOwner = currentUser && t.offer_owner_uid === currentUser.uid
  if (!isCreator && !isOfferOwner) {

    await displayModeratorTrade(t)
    return
  }

  const partnerUid  = isCreator ? t.offer_owner_uid : t.creator_uid
  const partnerName = isCreator ? (t.offer_owner_username || null) : (t.creator_username || null)
  const partnerAvatarNumber = isCreator ? t.offer_owner_avatar_number : t.creator_avatar_number
  const partnerLastActiveAt = Number(isCreator ? t.offer_owner_last_active_at : t.creator_last_active_at || 0)
  const partnerPresence = getPresenceBadgeState(partnerLastActiveAt)
  const partnerAvatarPath = avatarPathFromNumber(partnerAvatarNumber)
  const partnerDisplay = partnerName || (partnerUid ? partnerUid.slice(0, 8) + '…' : '—')

  const currency   = t.currency || ''
  const coin       = t.coin || ''
  const usdPrice = await getUsdPriceForCoin(coin)
  const fiatAmt    = t.fiat_amount   != null ? `${currency} ${Number(t.fiat_amount).toFixed(2)}`   : '—'
  const fiatAmtUsd = t.fiat_amount   != null ? `$${Number(t.fiat_amount).toFixed(2)} USD equiv`   : '—'
  const cryptoAmt  = t.crypto_amount != null ? `${Number(t.crypto_amount).toFixed(6)} ${coin}`     : '—'
  const cryptoAmtUsd = (t.crypto_amount != null && usdPrice)
    ? `$${(Number(t.crypto_amount) * usdPrice).toFixed(2)} USD equiv`
    : 'USD equiv unavailable'
  const cardName   = await resolvePaymentMethodName(t.card)

  const offerType = String(t.offer_type || '').toLowerCase()
  const isBuying = (isCreator && offerType === 'sell') || (!isCreator && offerType === 'buy')

  const summary = isBuying
    ? `You are buying <strong>${cryptoAmt}</strong> for <strong>${fiatAmt}</strong> via <strong>${escHtml(cardName)}</strong>`
    : `You are selling <strong>${cryptoAmt}</strong> for <strong>${fiatAmt}</strong> via <strong>${escHtml(cardName)}</strong>`

  const fiatAmtLabeled = cardName && cardName !== '—' ? `${fiatAmt} in ${cardName}` : fiatAmt
  const youSend    = isBuying ? fiatAmtLabeled : cryptoAmt
  const youReceive = isBuying ? cryptoAmt      : fiatAmtLabeled
  const youSendDetail = isBuying ? fiatAmtUsd : cryptoAmtUsd
  const youReceiveDetail = isBuying ? cryptoAmtUsd : fiatAmtUsd
  const sendColor  = isBuying ? 'var(--accent)' : 'var(--success)'
  const recvColor  = isBuying ? 'var(--success)' : 'var(--accent)'

  const partnerDisplayName = partnerName ? `@${partnerName}` : partnerDisplay
  document.getElementById('chat-partner-label').textContent = `Chat with ${partnerDisplayName}`

  const statusColors = { completed: 'rgba(34,197,94,0.15)', cancelled: 'rgba(239,68,68,0.15)', expired: 'rgba(168,85,247,0.15)', open: 'rgba(59,130,246,0.15)', pending: 'rgba(234,179,8,0.15)', disputed: 'rgba(239,68,68,0.15)', paid: 'rgba(234,179,8,0.15)' }
  const statusTextColors = { completed: 'var(--success)', cancelled: 'var(--danger)', expired: '#a855f7', open: '#3b82f6', pending: '#eab308', disputed: 'var(--danger)', paid: '#eab308' }
  const sBg = statusColors[t.status]      || 'rgba(59,130,246,0.15)'
  const sFg = statusTextColors[t.status]  || '#3b82f6'
  const showCountdown = ['open', 'pending'].includes(String(t.status || '').toLowerCase()) && Number(t.expires_at || 0) > 0

  const card = `
    <div style="display: flex; flex-direction: column; gap: 1.25rem;">
      <div style="display: flex; align-items: center; gap: 0.8rem;">
        <span class="trade-detail-avatar-wrap avatar-presence-wrap" title="${escHtml(partnerPresence.label)}">
          <img src="${escHtml(partnerAvatarPath)}" alt="" style="width: 44px; height: 44px; border-radius: 50%; object-fit: cover; box-shadow: 0 2px 8px rgba(0,0,0,0.15);" />
          <span class="avatar-presence-badge presence-${escHtml(partnerPresence.state)}" aria-hidden="true"></span>
        </span>
        <p style="font-weight: 600; margin: 0;">${escHtml(partnerDisplay)}</p>
      </div>

      <p style="font-size: 0.9375rem; margin: 0; padding: 0.75rem 1rem; background: var(--bg); border-radius: 8px; border: 1px solid var(--border); line-height: 1.5;">${summary}</p>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
        <div style="display: flex; flex-direction: column; gap: 0.25rem;">
          <span style="color: var(--muted); font-size: 0.82rem; font-weight: 500;">You send</span>
          <span style="font-weight: 700; font-size: 1.05rem; color: ${sendColor};">${youSend}</span>
          <span style="color: var(--muted); font-size: 0.8rem;">${youSendDetail}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 0.25rem;">
          <span style="color: var(--muted); font-size: 0.82rem; font-weight: 500;">You receive</span>
          <span style="font-weight: 700; font-size: 1.05rem; color: ${recvColor};">${youReceive}</span>
          <span style="color: var(--muted); font-size: 0.8rem;">${youReceiveDetail}</span>
        </div>
      </div>

      <button id="trade-fees-toggle" class="btn-secondary" style="align-self:flex-start;">Show fees summary</button>
      <div id="trade-fees-summary" class="hidden" style="margin-top:0.25rem;padding:0.85rem 0.95rem;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,0.03);font-size:0.88rem;">
        <div style="display:flex;flex-direction:column;gap:0.35rem;">
          <div style="display:flex;justify-content:space-between;gap:0.75rem;">
            <span style="color: var(--muted);">Escrow fee</span>
            <strong>0.05%</strong>
          </div>
          <div style="display:flex;justify-content:space-between;gap:0.75rem;">
            <span style="color: var(--muted);">Crypto sender</span>
            <strong>${isBuying ? 'Counterparty releases crypto' : 'You release crypto'}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;gap:0.75rem;">
            <span style="color: var(--muted);">Fiat side</span>
            <strong>${isBuying ? 'Counterparty receives fiat' : 'You receive fiat'}</strong>
          </div>
        </div>
      </div>
    </div>
  `

  const statusCard = `
    <div style="display: flex; flex-direction: column; gap: 0.75rem;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span style="color: var(--muted); font-size: 0.8rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;">Status</span>
        <span style="background: ${sBg}; color: ${sFg}; font-weight: 700; padding: 0.35rem 0.75rem; border-radius: 6px; font-size: 0.875rem; text-transform: capitalize;">${escHtml(t.status)}</span>
      </div>
      ${showCountdown ? `
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span style="color: var(--muted); font-size: 0.8rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;">Time Left</span>
        <span id="trade-status-countdown" style="color: var(--text); font-size: 0.85rem; font-weight: 600;">${formatMinutesLeft(t.expires_at)}</span>
      </div>` : ''}
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span style="color: var(--muted); font-size: 0.8rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;">Opened</span>
        <span style="color: var(--text); font-size: 0.85rem;">${new Date(t.created_at * 1000).toLocaleString()}</span>
      </div>
    </div>
  `

  document.getElementById('trade-card-container').innerHTML = card
  document.getElementById('trade-status-container').innerHTML = statusCard
  renderFeedbackSidebarCard(t)
  document.getElementById('trade-terms-text').textContent = t.terms || 'No terms specified.'
  if (showCountdown) bindStatusCountdown(t.expires_at)
  else clearStatusCountdownTimer()
  bindTradeFeesToggle()
  renderTradeActions(t, isBuying)
}

async function displayModeratorTrade(t) {
  const offerOwnerName = t.offer_owner_username || (t.offer_owner_uid ? `${t.offer_owner_uid.slice(0, 8)}…` : '—')
  const takerName = t.creator_username || (t.creator_uid ? `${t.creator_uid.slice(0, 8)}…` : '—')
  const offerOwnerAvatar = avatarPathFromNumber(t.offer_owner_avatar_number)
  const takerAvatar = avatarPathFromNumber(t.creator_avatar_number)

  const currency = t.currency || ''
  const coin = t.coin || ''
  const cardName = await resolvePaymentMethodName(t.card)
  const fiatAmt = t.fiat_amount != null ? `${currency} ${Number(t.fiat_amount).toFixed(2)}` : '—'
  const cryptoAmt = t.crypto_amount != null ? `${Number(t.crypto_amount).toFixed(6)} ${coin}` : '—'
  const raisedAt = t.dispute_raised_at ? new Date(Number(t.dispute_raised_at) * 1000).toLocaleString() : '—'
  const raisedByOfferOwner = !!t.dispute_raised_by_uid && t.dispute_raised_by_uid === t.offer_owner_uid
  const raisedByLabel = t.dispute_raised_by_uid ? (raisedByOfferOwner ? offerOwnerName : takerName) : '—'

  document.getElementById('chat-partner-label').textContent = 'Dispute Chat'

  const card = `
    <div style="display: flex; flex-direction: column; gap: 1.1rem;">
      <p class="muted" style="margin:0;padding:0.6rem 0.85rem;background:var(--bg);border-radius:8px;border:1px solid var(--border);">You're viewing this trade as a moderator.</p>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
        <div style="display:flex;align-items:center;gap:0.6rem;">
          <img src="${escHtml(offerOwnerAvatar)}" alt="" style="width:38px;height:38px;border-radius:50%;object-fit:cover;" />
          <div>
            <span style="color:var(--muted);font-size:0.78rem;display:block;">Offer Owner</span>
            <strong>${escHtml(offerOwnerName)}</strong>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:0.6rem;">
          <img src="${escHtml(takerAvatar)}" alt="" style="width:38px;height:38px;border-radius:50%;object-fit:cover;" />
          <div>
            <span style="color:var(--muted);font-size:0.78rem;display:block;">Taker</span>
            <strong>${escHtml(takerName)}</strong>
          </div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
        <div style="display: flex; flex-direction: column; gap: 0.25rem;">
          <span style="color: var(--muted); font-size: 0.82rem; font-weight: 500;">Fiat</span>
          <span style="font-weight: 700; font-size: 1.05rem;">${fiatAmt}</span>
          <span style="color: var(--muted); font-size: 0.8rem;">via ${escHtml(cardName)}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 0.25rem;">
          <span style="color: var(--muted); font-size: 0.82rem; font-weight: 500;">Crypto (escrowed)</span>
          <span style="font-weight: 700; font-size: 1.05rem;">${cryptoAmt}</span>
        </div>
      </div>

      <div style="padding:0.85rem 0.95rem;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,0.03);font-size:0.88rem;">
        <div style="display:flex;flex-direction:column;gap:0.35rem;">
          <div style="display:flex;justify-content:space-between;gap:0.75rem;">
            <span style="color: var(--muted);">Raised by</span>
            <strong>${escHtml(raisedByLabel)}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;gap:0.75rem;">
            <span style="color: var(--muted);">Raised at</span>
            <strong>${escHtml(raisedAt)}</strong>
          </div>
          ${t.dispute_reason_category ? `
          <div style="display:flex;justify-content:space-between;gap:0.75rem;">
            <span style="color: var(--muted);">Reason</span>
            <strong>${escHtml(t.dispute_reason_category)}</strong>
          </div>` : ''}
        </div>
        ${t.dispute_reason_text ? `
        <div style="margin-top:0.6rem;">
          <span style="color: var(--muted); display:block; margin-bottom:0.25rem;">Evidence</span>
          <p style="margin:0;white-space:pre-wrap;line-height:1.45;">${escHtml(t.dispute_reason_text)}</p>
        </div>` : ''}
      </div>
    </div>
  `

  const statusLabel = t.dispute_resolved ? 'Disputed — Resolved' : 'Disputed — Live'
  const statusCard = `
    <div style="display: flex; flex-direction: column; gap: 0.75rem;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span style="color: var(--muted); font-size: 0.8rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;">Status</span>
        <span style="background: rgba(239,68,68,0.15); color: var(--danger); font-weight: 700; padding: 0.35rem 0.75rem; border-radius: 6px; font-size: 0.875rem;">${escHtml(statusLabel)}</span>
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span style="color: var(--muted); font-size: 0.8rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;">Opened</span>
        <span style="color: var(--text); font-size: 0.85rem;">${new Date(t.created_at * 1000).toLocaleString()}</span>
      </div>
      ${t.dispute_resolved ? `
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span style="color: var(--muted); font-size: 0.8rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;">Awarded To</span>
        <span style="color: var(--text); font-size: 0.85rem;">${escHtml(t.dispute_winner_uid === t.offer_owner_uid ? offerOwnerName : takerName)}</span>
      </div>` : ''}
    </div>
  `

  document.getElementById('trade-card-container').innerHTML = card
  document.getElementById('trade-status-container').innerHTML = statusCard
  document.getElementById('trade-feedback-container').innerHTML = `
    <h3 style="margin:0 0 0.35rem;font-size:1rem;">Trade Feedback</h3>
    <p class="muted" style="margin:0;">Not shown in the moderator view.</p>
  `
  document.getElementById('trade-terms-text').textContent = t.terms || 'No terms specified.'
  clearStatusCountdownTimer()
  renderModeratorActions(t, offerOwnerName, takerName)
}

function renderModeratorActions(t, offerOwnerName, takerName) {
  const container = document.getElementById('trade-actions-container')
  const card = document.getElementById('trade-actions-card')
  if (!container) return

  if (t.dispute_resolved) {
    if (card) card.classList.add('hidden')
    container.innerHTML = ''
    return
  }

  if (card) card.classList.remove('hidden')
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:0.6rem;">
      <p class="muted" style="margin:0;">Award the escrowed crypto to whichever party the evidence supports. This releases funds immediately.</p>
      <div style="display:flex;gap:0.75rem;flex-wrap:wrap;">
        <button class="btn btn-success" data-award="${escHtml(t.offer_owner_uid)}" data-award-name="${escHtml(offerOwnerName)}">Award to ${escHtml(offerOwnerName)}</button>
        <button class="btn btn-success" data-award="${escHtml(t.creator_uid)}" data-award-name="${escHtml(takerName)}">Award to ${escHtml(takerName)}</button>
      </div>
    </div>
  `

  container.querySelectorAll('button[data-award]').forEach((btn) => {
    btn.addEventListener('click', () => handleAwardDispute(btn.dataset.award, btn.dataset.awardName, t.id))
  })
}

async function handleAwardDispute(winnerUid, winnerName, tradeId) {
  const ok = await showConfirm(`Award this trade's escrow to ${winnerName}? This releases the funds immediately and cannot be undone.`)
  if (!ok) return
  try {
    currentTrade = await resolveDispute(tradeId, winnerUid)
    await displayTrade()
  } catch (e) {
    await showAlert(`Resolve failed: ${e.message}`)
  }
}

function renderFeedbackSidebarCard(trade) {
  const container = document.getElementById('trade-feedback-container')
  if (!container) return

  const feedback = Array.isArray(trade.feedback) ? trade.feedback : []
  const myFeedback = feedback.find((entry) => entry.from_uid === currentUser.uid)
  const receivedFeedback = feedback.find((entry) => entry.to_uid === currentUser.uid && entry.from_uid !== currentUser.uid)
  const status = String(trade.status || '').toLowerCase()
  const isCompleted = status === 'completed'

  const isDisputeWinner = status === 'disputed' && !!trade.dispute_resolved && trade.dispute_winner_uid === currentUser.uid
  const canLeaveFeedback = isCompleted || isDisputeWinner

  const receivedMarkup = receivedFeedback
    ? `
      <div style="margin-top:0.55rem;padding:0.65rem 0.75rem;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,0.02);">
        <p class="muted" style="margin:0 0 0.25rem;">Feedback left for you</p>
        <p style="margin:0;font-weight:700;color:${receivedFeedback.positive ? 'var(--success)' : 'var(--danger)'};">${receivedFeedback.positive ? 'Positive' : 'Negative'}</p>
        <p style="margin:0.35rem 0 0;white-space:pre-wrap;line-height:1.45;">${escHtml(receivedFeedback.comment || '')}</p>
      </div>`
    : '<p class="muted" style="margin-top:0.55rem;">No feedback has been left for you yet.</p>'

  let placeholderText = 'Feedback opens after completion'
  if (status === 'disputed') {
    placeholderText = trade.dispute_resolved
      ? 'Only the dispute winner can leave feedback'
      : 'Feedback opens once the dispute is resolved'
  }
  let actionMarkup = `<button class="btn" style="margin-top:0.7rem;" disabled>${escHtml(placeholderText)}</button>`
  if (canLeaveFeedback) {
    actionMarkup = myFeedback
      ? `
        <div style="margin-top:0.65rem;">
          <p class="muted" style="margin:0;">Your feedback</p>
          <p style="margin:0.2rem 0 0;font-weight:700;color:${myFeedback.positive ? 'var(--success)' : 'var(--danger)'};">${myFeedback.positive ? 'Positive' : 'Negative'}</p>
          <p style="margin:0.35rem 0 0;white-space:pre-wrap;line-height:1.45;">${escHtml(myFeedback.comment || '')}</p>
          <button id="btn-edit-feedback-sidebar" class="btn" style="margin-top:0.7rem;">Edit Feedback</button>
        </div>`
      : '<button id="btn-leave-feedback-sidebar" class="btn" style="margin-top:0.7rem;">Leave Feedback</button>'
  }

  container.innerHTML = `
    <h3 style="margin:0 0 0.35rem;font-size:1rem;">Trade Feedback</h3>
    <p class="muted" style="margin:0;">View partner feedback and leave your own rating.</p>
    ${receivedMarkup}
    ${actionMarkup}
  `

  const btn = container.querySelector('#btn-leave-feedback-sidebar')
  if (btn) {
    btn.addEventListener('click', async () => {
      try {
        const result = await showFeedbackModal()
        if (!result) return
        btn.disabled = true
        currentTrade = await leaveTradeFeedback(trade.id, result.positive, result.comment)
        await displayTrade()
        syncTradeChatState(partnerUsernameForChat(currentTrade))
      } catch (e) {
        await showAlert(`Feedback failed: ${e.message}`)
        btn.disabled = false
      }
    })
  }

  const editBtn = container.querySelector('#btn-edit-feedback-sidebar')
  if (editBtn && myFeedback) {
    editBtn.addEventListener('click', async () => {
      try {
        const result = await showFeedbackModal({
          initialPositive: !!myFeedback.positive,
          initialComment: String(myFeedback.comment || ''),
          title: 'Edit Feedback',
          submitLabel: 'Save Changes',
        })
        if (!result) return
        editBtn.disabled = true
        currentTrade = await editTradeFeedback(trade.id, result.positive, result.comment)
        await displayTrade()
        syncTradeChatState(partnerUsernameForChat(currentTrade))
      } catch (e) {
        await showAlert(`Feedback update failed: ${e.message}`)
        editBtn.disabled = false
      }
    })
  }
}

function bindTradeFeesToggle() {
  const btn = document.getElementById('trade-fees-toggle')
  const panel = document.getElementById('trade-fees-summary')
  if (!btn || !panel) return
  btn.onclick = () => {
    const nowHidden = panel.classList.toggle('hidden')
    btn.textContent = nowHidden ? 'Show fees summary' : 'Hide fees summary'
  }
}

function partnerUsernameForChat(trade) {
  if (!currentUser) return null
  if (trade.creator_uid === currentUser.uid) return trade.offer_owner_username || null
  if (trade.offer_owner_uid === currentUser.uid) return trade.creator_username || null
  return null
}

function syncTradeChatState(partnerUsername) {
  document.dispatchEvent(new CustomEvent('open-chat', {
    detail: {
      tradeId: currentTrade.id,
      partnerUsername,
      trade: currentTrade,
    },
  }))
}

  async function renderTradeActions(t, isBuying) {
    const container = document.getElementById('trade-actions-container')
    const card = document.getElementById('trade-actions-card')
    if (!container) return

    const status = String(t.status || '').toLowerCase()

    const isTerminal = ['completed', 'cancelled', 'expired'].includes(status)
      || (status === 'disputed' && !!t.dispute_resolved)
    if (isTerminal) {
      if (card) card.classList.add('hidden')
      container.innerHTML = ''
      return
    }

    if (card) card.classList.remove('hidden')

    const buttons = []
    const disputedOpen = status === 'disputed' && !t.dispute_resolved

    if (isBuying && t.status === 'open') {
      buttons.push({ label: 'Mark as Paid', action: 'paid', cls: 'btn' })
    }
    if (isBuying && (t.status === 'open' || t.status === 'paid' || disputedOpen)) {
      buttons.push({ label: 'Cancel Trade', action: 'cancel', cls: 'btn-danger' })
    }
    if (!isBuying && (t.status === 'open' || t.status === 'paid' || disputedOpen)) {
      buttons.push({ label: 'Complete Trade', action: 'complete', cls: 'btn-success' })
    }
    if (t.status === 'paid') {
      buttons.push({ label: 'Open Dispute', action: 'dispute', cls: 'btn-warning' })
    }

    if (buttons.length === 0) {
      container.innerHTML = '<p class="muted">No actions available for your role at this stage.</p>'
      return
    }

    container.innerHTML = `<div style="display:flex;gap:0.75rem;flex-wrap:wrap;">${
      buttons.map(b => `<button class="btn ${b.cls}" data-action="${b.action}">${escHtml(b.label)}</button>`).join('')
    }</div>`

    container.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => handleTradeAction(btn.dataset.action, t.id))
    })
  }

  async function handleTradeAction(action, tradeId) {
    try {
      if (action === 'paid') {
        const ok = await showConfirm('Mark this trade as paid? The trade will no longer expire automatically.')
        if (!ok) return
        currentTrade = await markTradePaid(tradeId)
      } else if (action === 'complete') {
        const confirmMessage = String(currentTrade?.status || '').toLowerCase() === 'paid'
          ? 'Mark this trade as completed? This confirms you have received payment.'
          : 'Your trade counterparty has not marked this trade as paid yet. Are you still sure you want to release and complete this trade?'
        const ok = await showConfirm(confirmMessage)
        if (!ok) return
        currentTrade = await completeTrade(tradeId)
      } else if (action === 'cancel') {
        const ok = await showConfirm('Cancel this trade? This cannot be undone.')
        if (!ok) return
        const reason = await promptReason('Reason for cancellation (optional):')
        currentTrade = await cancelTrade(tradeId, reason || undefined)
      } else if (action === 'dispute') {
        const result = await showDisputeModal()
        if (!result) return
        currentTrade = await disputeTrade(tradeId, result.reasonCategory, result.reasonText)
      }
      await displayTrade()
      syncTradeChatState(partnerUsernameForChat(currentTrade))
    } catch (e) {
      await showAlert(`Action failed: ${e.message}`)
    }
  }

  async function promptReason(message) {
    return new Promise(resolve => {
      const overlay = document.createElement('div')
      overlay.className = 'modal-overlay'
      overlay.innerHTML = `
        <div class="modal-box" style="max-width:420px;">
          <p style="margin-bottom:0.75rem;">${escHtml(message)}</p>
          <textarea id="modal-reason-input" rows="3" style="width:100%;resize:vertical;padding:0.5rem;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:inherit;font-size:0.95rem;"></textarea>
          <div style="display:flex;gap:0.75rem;justify-content:flex-end;margin-top:0.75rem;">
            <button class="btn" id="modal-reason-skip">Skip</button>
            <button class="btn" id="modal-reason-ok">OK</button>
          </div>
        </div>
      `
      document.body.appendChild(overlay)
      const input = overlay.querySelector('#modal-reason-input')
      overlay.querySelector('#modal-reason-ok').addEventListener('click', () => { overlay.remove(); resolve(input.value.trim()) })
      overlay.querySelector('#modal-reason-skip').addEventListener('click', () => { overlay.remove(); resolve('') })
    })
  }

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

window.addEventListener('beforeunload', clearStatusCountdownTimer)
