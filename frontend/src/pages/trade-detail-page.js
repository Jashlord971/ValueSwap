// trade-detail-page.js — dedicated trade detail and chat page
import { initializeApp } from 'firebase/app'
import { firebaseConfig }  from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, getTrade, completeTrade, cancelTrade, markTradePaid, disputeTrade } from '../api.js'
import { showAlert, showConfirm } from '../modal.js'
import { initChat } from '../chat.js'
import { avatarPathFromProfile, avatarPathFromNumber } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

let currentUser = null
let currentTrade = null
let usdPrices = null
let statusCountdownTimer = null

const COIN_TO_GECKO = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  TRX: 'tron',
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
      // try next candidate
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

  const isCreator = currentUser && currentTrade.creator_uid === currentUser.uid
  const partnerUsername = isCreator
    ? (currentTrade.offer_owner_username || null)
    : (currentTrade.creator_username || null)
  syncTradeChatState(partnerUsername)
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

    // Initialize chat with partner username
    const isCreator = currentUser && currentTrade.creator_uid === currentUser.uid
    const partnerUsername = isCreator
      ? (currentTrade.offer_owner_username || null)
      : (currentTrade.creator_username || null)
    
    syncTradeChatState(partnerUsername)
  } catch (e) {
    document.getElementById('trade-detail-page').classList.remove('hidden')
    document.getElementById('trade-card-container').innerHTML = `<p class="error">Failed to load trade: ${e.message}</p>`
  }
}

async function displayTrade() {
  const t = currentTrade
  const isCreator = currentUser && t.creator_uid === currentUser.uid
  const partnerUid  = isCreator ? t.offer_owner_uid : t.creator_uid
  const partnerName = isCreator ? (t.offer_owner_username || null) : (t.creator_username || null)
  const partnerAvatarNumber = isCreator ? t.offer_owner_avatar_number : t.creator_avatar_number
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
  const cardName   = t.card || '—'

  // offer_type is the offer owner's perspective ("buy" = they buy crypto, "sell" = they sell crypto)
  // isBuying = current user is acquiring crypto in this trade
  const isBuying = (isCreator && t.offer_type === 'sell') || (!isCreator && t.offer_type === 'buy')

  const summary = isBuying
    ? `You are buying <strong>${cryptoAmt}</strong> for <strong>${fiatAmt}</strong> via <strong>${escHtml(cardName)}</strong>`
    : `You are selling <strong>${fiatAmt}</strong> of <strong>${escHtml(cardName)}</strong> for <strong>${cryptoAmt}</strong>`

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
        <img src="${escHtml(partnerAvatarPath)}" alt="" style="width: 44px; height: 44px; border-radius: 50%; object-fit: cover; box-shadow: 0 2px 8px rgba(0,0,0,0.15);" />
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
            <strong>${isBuying ? 'You release crypto' : 'Counterparty releases crypto'}</strong>
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
  document.getElementById('trade-terms-text').textContent = t.terms || 'No terms specified.'
  if (showCountdown) bindStatusCountdown(t.expires_at)
  else clearStatusCountdownTimer()
  bindTradeFeesToggle()
  renderTradeActions(t, isBuying)
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
    if (!container) return

    const closed = ['completed', 'cancelled', 'expired', 'disputed']
    if (closed.includes(t.status)) {
      const reason = t.cancel_reason ? ` — <em>${escHtml(t.cancel_reason)}</em>` : ''
      container.innerHTML = `<p class="muted">No actions available — trade is <strong>${escHtml(t.status)}</strong>${reason}.</p>`
      return
    }

    const buttons = []

    if (isBuying && t.status === 'open') {
      buttons.push({ label: 'Mark as Paid', action: 'paid', cls: 'btn' })
    }
    if (isBuying && (t.status === 'open' || t.status === 'paid')) {
      buttons.push({ label: 'Cancel Trade', action: 'cancel', cls: 'btn-danger' })
    }
    if (!isBuying && (t.status === 'open' || t.status === 'paid')) {
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
        const ok = await showConfirm('Mark this trade as completed? This confirms you have received payment.')
        if (!ok) return
        currentTrade = await completeTrade(tradeId)
      } else if (action === 'cancel') {
        const ok = await showConfirm('Cancel this trade? This cannot be undone.')
        if (!ok) return
        const reason = await promptReason('Reason for cancellation (optional):')
        currentTrade = await cancelTrade(tradeId, reason || undefined)
      } else if (action === 'dispute') {
        const ok = await showConfirm('Open a dispute for this trade? An admin will review the case.')
        if (!ok) return
        currentTrade = await disputeTrade(tradeId)
      }
      await displayTrade()
      const isCreator = currentUser && currentTrade.creator_uid === currentUser.uid
      const partnerUsername = isCreator
        ? (currentTrade.offer_owner_username || null)
        : (currentTrade.creator_username || null)
      syncTradeChatState(partnerUsername)
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
