
import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, getUserProfileByUsername, listPaymentMethods, createTrade } from '../api.js'
import { initChat } from '../chat.js'
import { avatarPathFromProfile, avatarPathFromNumber } from '../avatar.js'
import { formatPresenceLastSeen } from '../presence.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)
initChat(firebaseApp)

let paymentMethodNameMap = null
let paymentMethods = []
let usdPrices = null

const COIN_TO_GECKO = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function usernameFromPath() {
  const match = window.location.pathname.match(/^\/user\/([^/]+)\/?$/)
  return match ? decodeURIComponent(match[1]) : null
}

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }

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

  await loadProfile()
})

async function ensurePaymentMethodNameMap() {
  if (paymentMethodNameMap) return paymentMethodNameMap
  try {
    const methods = await listPaymentMethods()
    paymentMethods = methods || []
    paymentMethodNameMap = new Map(
      paymentMethods.map((m) => [String(m.id || '').toLowerCase(), m.name || m.id || ''])
    )
  } catch {
    paymentMethods = []
    paymentMethodNameMap = new Map()
  }
  return paymentMethodNameMap
}

function paymentMethodDisplayName(raw) {
  const id = String(raw || '').trim()
  if (!id) return '—'
  return paymentMethodNameMap?.get(id.toLowerCase()) || id
}

function getPaymentMethodEscrowFeePct(id) {
  return Number(paymentMethods.find((method) => method.id === id)?.escrow_fee_pct || 1)
}

async function getUsdPrices(forceRefresh = false) {
  if (usdPrices && !forceRefresh) return usdPrices
  const ids = Object.values(COIN_TO_GECKO).join(',')
  try {
    const res = await fetch(`/api/wallet/prices?ids=${encodeURIComponent(ids)}`)
    if (!res.ok) throw new Error('Price request failed')
    usdPrices = await res.json()
    return usdPrices
  } catch {
    return usdPrices || {}
  }
}

function formatUsd(value) {
  const numeric = Number(value)
  if (Number.isNaN(numeric)) return '$0.00'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(numeric)
}

function formatCoinAmount(value) {
  const numeric = Number(value)
  if (Number.isNaN(numeric)) return '0'
  if (numeric >= 1) return numeric.toFixed(6).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  return numeric.toFixed(8).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

function ensureTradeModal() {
  if (document.getElementById('start-trade-modal')) return
  const el = document.createElement('div')
  el.innerHTML = `
    <div id="start-trade-modal" class="modal-overlay hidden" role="dialog" aria-modal="true">
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <h3>Start Trade</h3>
          <button id="close-start-trade-modal" class="modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <p id="start-trade-offer-label" class="muted" style="margin-bottom:1rem"></p>
          <div class="field-row">
            <label for="trade-fiat-amount">Fiat Amount (<span id="trade-currency-label">USD</span>)</label>
            <input id="trade-fiat-amount" type="number" min="0.01" step="0.01" placeholder="e.g. 100" class="form-input" />
          </div>
          <div class="field-row">
            <label for="trade-crypto-amount">Crypto Amount</label>
            <input id="trade-crypto-amount" type="text" placeholder="e.g. 0.0025 BTC ($100.00)" class="form-input" readonly />
          </div>
          <p id="trade-buy-breakdown" class="muted" style="margin-top:0.35rem;white-space:pre-line"></p>
          <button id="trade-fees-toggle" type="button" class="btn-secondary" style="align-self:flex-start;">Show fees summary</button>
          <div id="trade-fees-summary" class="hidden" style="padding:0.85rem 0.95rem;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,0.03);font-size:0.88rem;">
            <div style="display:flex;flex-direction:column;gap:0.4rem;">
              <div style="display:flex;justify-content:space-between;gap:0.75rem;"><span style="color:var(--muted);">Escrow fee</span><strong>0.05%</strong></div>
              <div style="display:flex;justify-content:space-between;gap:0.75rem;"><span style="color:var(--muted);">Crypto sender</span><strong id="trade-fees-sender">—</strong></div>
              <div style="display:flex;justify-content:space-between;gap:0.75rem;"><span style="color:var(--muted);">Crypto receiver</span><strong id="trade-fees-receiver">—</strong></div>
            </div>
          </div>
          <p id="start-trade-error" class="error"></p>
          <button id="btn-confirm-trade" style="width:100%">Confirm Trade</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(el.firstElementChild)
  document.getElementById('close-start-trade-modal').addEventListener('click', () => {
    document.getElementById('start-trade-modal').classList.add('hidden')
  })
}

async function openStartTrade(offer) {
  ensureTradeModal()
  const viewerSide = offer.offer_type === 'sell' ? 'buy' : 'sell'
  const modal = document.getElementById('start-trade-modal')
  const errEl = document.getElementById('start-trade-error')
  const breakdownEl = document.getElementById('trade-buy-breakdown')
  const fiatInput = document.getElementById('trade-fiat-amount')
  const cryptoInput = document.getElementById('trade-crypto-amount')
  const paymentMethod = paymentMethodDisplayName(offer.card)
  const offerCoin = String(offer.coin || 'BTC').toUpperCase()

  document.getElementById('start-trade-offer-label').textContent =
    `${viewerSide === 'buy' ? 'Buy' : 'Sell'} ${offerCoin} with ${paymentMethod} (${offer.currency})`
  document.getElementById('trade-currency-label').textContent = offer.currency || 'USD'
  fiatInput.value = ''
  cryptoInput.value = ''
  cryptoInput.dataset.rawAmount = ''
  errEl.textContent = ''
  breakdownEl.textContent = ''
  document.getElementById('trade-fees-summary')?.classList.add('hidden')
  const feesToggle = document.getElementById('trade-fees-toggle')
  if (feesToggle) feesToggle.textContent = 'Show fees summary'

  modal.classList.remove('hidden')

  let prices = await getUsdPrices()

  const updateBuyPreview = () => {
    const fiatAmount = Number.parseFloat(fiatInput.value)
    if (Number.isNaN(fiatAmount) || fiatAmount <= 0) {
      cryptoInput.value = ''
      breakdownEl.textContent = 'Enter a fiat amount to preview crypto equivalent.'
      return
    }

    const marginPct = Number(offer.profit_pct || 0)
    const multiplier = 1 + marginPct / 100
    if (multiplier <= 0) {
      breakdownEl.textContent = 'Invalid profit percentage on this offer.'
      return
    }

    const escrowFeePct = Math.max(0, getPaymentMethodEscrowFeePct(offer.card))
    const escrowRate = Math.min(0.95, escrowFeePct / 100)

    const targetNetCryptoUsd = fiatAmount / multiplier
    const coin = offerCoin
    const geckoId = COIN_TO_GECKO[coin]
    const usdPrice = Number(prices?.[geckoId]?.usd || 0)

    if (usdPrice <= 0) {
      cryptoInput.value = ''
      cryptoInput.dataset.rawAmount = ''
      breakdownEl.textContent = `${formatUsd(fiatAmount)} / ${multiplier.toFixed(4)} = ${formatUsd(targetNetCryptoUsd)} target net crypto value (price unavailable for ${coin}).`
      return
    }

    const netCrypto = targetNetCryptoUsd / usdPrice
    const grossCrypto = netCrypto / (1 - escrowRate)
    const escrowFee = grossCrypto - netCrypto
    const senderRole = viewerSide === 'buy' ? 'Counterparty releases crypto' : 'You release crypto'
    const receiverRole = viewerSide === 'buy' ? 'You receive crypto' : 'Counterparty receives crypto'

    cryptoInput.dataset.rawAmount = String(grossCrypto)
    cryptoInput.value = `${formatCoinAmount(grossCrypto)} ${coin} (${formatUsd(targetNetCryptoUsd)})`
    breakdownEl.textContent = `${coin} at ${formatUsd(usdPrice)} gives net ${formatCoinAmount(netCrypto)} ${coin}.\nEscrow fee is ${formatCoinAmount(escrowFee)} ${coin}.`

    const feesSummary = document.getElementById('trade-fees-summary')
    const feesSender = document.getElementById('trade-fees-sender')
    const feesReceiver = document.getElementById('trade-fees-receiver')
    if (feesSender) feesSender.textContent = senderRole
    if (feesReceiver) feesReceiver.textContent = receiverRole
    if (feesSummary && !feesSummary.classList.contains('hidden')) {
      feesSummary.dataset.escrow = `${escrowFeePct.toFixed(2)}%`
    }
  }

  fiatInput.oninput = updateBuyPreview
  updateBuyPreview()

  const btn = document.getElementById('btn-confirm-trade')
  const handler = async () => {
    const fiatAmount = parseFloat(fiatInput.value)
    const coin = offerCoin

    errEl.textContent = ''
    if (Number.isNaN(fiatAmount) || fiatAmount <= 0) { errEl.textContent = 'Enter a valid fiat amount.'; return }

    btn.disabled = true
    try {
      prices = await getUsdPrices(true)
      updateBuyPreview()

      const cryptoAmount = Number.parseFloat(cryptoInput.dataset.rawAmount || '')
      if (Number.isNaN(cryptoAmount) || cryptoAmount <= 0) { errEl.textContent = 'Enter a valid crypto amount.'; return }

      const trade = await createTrade({ offer_id: offer.id, fiat_amount: fiatAmount, crypto_amount: cryptoAmount, coin })
      modal.classList.add('hidden')
      window.location.href = `/trade-detail.html?id=${trade.id}`
    } catch (e) {
      errEl.textContent = e.message
    } finally {
      btn.disabled = false
    }
  }

  const fresh = btn.cloneNode(true)
  btn.replaceWith(fresh)
  fresh.addEventListener('click', handler)

  const feesToggleBtn = document.getElementById('trade-fees-toggle')
  const feesSummary = document.getElementById('trade-fees-summary')
  if (feesToggleBtn && feesSummary) {
    feesToggleBtn.onclick = () => {
      feesSummary.classList.toggle('hidden')
      feesToggleBtn.textContent = feesSummary.classList.contains('hidden') ? 'Show fees summary' : 'Hide fees summary'
    }
  }
}

async function loadProfile() {
  const root = document.getElementById('user-profile-root')
  const username = usernameFromPath()
  if (!username) {
    root.innerHTML = '<p class="error">No username specified.</p>'
    return
  }

  await ensurePaymentMethodNameMap()

  try {
    const p = await getUserProfileByUsername(username)
    renderProfile(root, p)
  } catch (e) {
    const isNotFound = /not found|404/i.test(String(e?.message || ''))
    root.innerHTML = isNotFound
      ? `<p class="error">No user found with username @${escHtml(username)}.</p>`
      : `<p class="error">Failed to load profile: ${escHtml(e.message)}</p>`
  }
}

function renderProfile(root, p) {
  const banner = document.getElementById('user-warning-banner')
  if (p.active_warning_count > 0) {
    banner.classList.remove('hidden')
    banner.textContent = `⚠️ This user currently has ${p.active_warning_count} active warning${p.active_warning_count === 1 ? '' : 's'}.`
  } else {
    banner.classList.add('hidden')
  }

  const avatar = avatarPathFromNumber(p.avatar_number)
  const lastSeen = formatPresenceLastSeen(p.last_active_at)
  const score = p.feedback_pos - p.feedback_neg

  const feedbackMarkup = p.recent_feedback.length
    ? p.recent_feedback.map((f) => `
        <div style="padding:0.75rem 0;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:center;gap:0.5rem;">
            <span style="font-weight:700;color:${f.positive ? 'var(--success)' : 'var(--danger)'};">${f.positive ? '👍 Positive' : '👎 Negative'}</span>
            <span class="muted" style="font-size:0.78rem;">${new Date(f.created_at * 1000).toLocaleDateString()}</span>
          </div>
          ${f.comment ? `<p style="margin:0.35rem 0 0;white-space:pre-wrap;">${escHtml(f.comment)}</p>` : ''}
        </div>`).join('')
    : '<p class="muted">No feedback yet.</p>'

  const offersMarkup = p.active_offers.length
    ? p.active_offers.map((o) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;padding:0.75rem 0;border-bottom:1px solid var(--border);">
          <div>
            <strong>${o.offer_type === 'buy' ? 'Buy' : 'Sell'} ${escHtml(o.coin)}</strong>
            <div class="muted" style="font-size:0.82rem;">via ${escHtml(paymentMethodDisplayName(o.card))} · ${escHtml(o.currency)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:0.75rem;">
            <div style="text-align:right;font-size:0.85rem;">
              ${o.min_amount != null ? `${o.min_amount} – ${o.max_amount ?? '?'} ${escHtml(o.currency)}` : ''}
            </div>
            <button type="button" class="btn-sm" data-start-trade="${escHtml(o.id)}">Start Trade</button>
          </div>
        </div>`).join('')
    : '<p class="muted">No active offers right now.</p>'

  root.innerHTML = `
    <section class="section card" style="display:flex;align-items:center;gap:1.1rem;">
      <img src="${escHtml(avatar)}" alt="" style="width:72px;height:72px;border-radius:50%;object-fit:cover;" />
      <div>
        <h1 style="margin:0;">@${escHtml(p.username)}</h1>
        <p class="muted" style="margin:0.25rem 0 0;">${escHtml(lastSeen)}</p>
      </div>
    </section>

    <section class="section card" style="display:flex;gap:2rem;flex-wrap:wrap;">
      <div>
        <div class="muted" style="font-size:0.8rem;">Trades completed</div>
        <div style="font-size:1.4rem;font-weight:700;">${p.trade_count}</div>
      </div>
      <div>
        <div class="muted" style="font-size:0.8rem;">Feedback</div>
        <div style="font-size:1.4rem;font-weight:700;color:${score >= 0 ? 'var(--success)' : 'var(--danger)'};">
          ${p.feedback_pos} 👍 / ${p.feedback_neg} 👎
        </div>
      </div>
    </section>

    <section class="section card">
      <h2 style="margin-top:0;">Active Offers</h2>
      ${offersMarkup}
    </section>

    <section class="section card">
      <h2 style="margin-top:0;">Recent Feedback</h2>
      ${feedbackMarkup}
    </section>
  `

  root.querySelectorAll('[data-start-trade]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const offer = p.active_offers.find((o) => o.id === btn.dataset.startTrade)
      if (offer) void openStartTrade(offer)
    })
  })
}
