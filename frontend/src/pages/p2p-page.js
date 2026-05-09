// p2p-page.js — entry point for p2p.html
import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, listOffers, listCurrencies, listPaymentMethods, getUserProfile } from '../api.js'
import { initChat } from '../chat.js'
import { avatarPathFromNumber, avatarPathFromProfile } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)
initChat(firebaseApp)

let allOffers = []
let paymentMethods = []
const profileCache = new Map()
let selectedSide = 'buy'
let selectedCoin = 'BTC'
let selectedCurrency = ''
let selectedPaymentMethod = ''
let selectedSort = 'reputation'
let usdPrices = null
let offersRefreshTimer = null

const COIN_TO_GECKO = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  TRX: 'tron',
}

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }

  let profile
  try { profile = await upsertUser() } catch { profile = { email: user.email } }

  renderNav(user, profile)
  bindFilters()
  await loadMeta()
  await loadOffers(buildMarketQuery())
})

function renderNav(user, profile) {
  const navAuth = document.getElementById('nav-auth')
  const label = profile?.username ? `@${profile.username}` : user.email
  const photo = avatarPathFromProfile(profile)
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
}

async function loadMeta() {
  try {
    const [currencies, methods] = await Promise.all([listCurrencies(), listPaymentMethods()])
    paymentMethods = methods
    const currencyList = document.getElementById('p2p-currency-list')
    currencies.forEach((currency) => {
      const li = document.createElement('li')
      li.dataset.value = currency.code || currency.id || ''
      li.role = 'option'
      li.textContent = `${currency.code || currency.symbol || ''} ${currency.name}`.trim()
      currencyList.appendChild(li)
    })
    const pmList = document.getElementById('p2p-pm-list')
    methods.forEach((method) => {
      const li = document.createElement('li')
      li.dataset.value = method.id || ''
      li.role = 'option'
      li.textContent = method.name || method.id
      pmList.appendChild(li)
    })
  } catch { /* non-critical */ }
}

async function loadOffers(query = {}) {
  const list = document.getElementById('p2p-list')
  try {
    const offers = await listOffers({ fresh: true, ...query })
    allOffers = offers.filter((offer) => offer.status === 'active')
    await hydrateProfiles(allOffers)
    applyFilters()
  } catch (e) {
    list.innerHTML = `<p class="error">Failed to load offers: ${e.message}</p>`
  }
}

async function hydrateProfiles(offers) {
  const uids = [...new Set(offers.map((offer) => offer.creator_uid).filter(Boolean))]
  await Promise.all(uids.map(async (uid) => {
    if (profileCache.has(uid)) return
    try {
      profileCache.set(uid, await getUserProfile(uid))
    } catch {
      profileCache.set(uid, null)
    }
  }))
}

function bindFilters() {
  bindCoinDropdown()
  bindCurrencyDropdown()
  bindPaymentMethodDropdown()
  bindSortDropdown()
  document.getElementById('p2p-amount').addEventListener('input', () => queueOffersRefresh())
  document.getElementById('p2p-type-buy').addEventListener('click', () => setSide('buy'))
  document.getElementById('p2p-type-sell').addEventListener('click', () => setSide('sell'))
  document.getElementById('p2p-reset').addEventListener('click', resetFilters)
  document.addEventListener('click', closeAllDropdowns)
}

function setSide(side) {
  selectedSide = side
  document.getElementById('p2p-type-buy').classList.toggle('active', side === 'buy')
  document.getElementById('p2p-type-sell').classList.toggle('active', side === 'sell')
  document.querySelector('.p2p-hero').classList.toggle('sell-theme', side === 'sell')
  queueOffersRefresh(true)
}

function resetFilters() {
  selectedSide = 'buy'
  selectedCurrency = ''
  selectedPaymentMethod = ''
  selectedSort = 'reputation'
  setCoinSelection('BTC')
  document.getElementById('p2p-amount').value = ''
  setCurrencySelection('')
  setPmSelection('')
  setSortSelection('reputation')
  setSide('buy')
  queueOffersRefresh(true)
}

function closeAllDropdowns() {
  document.querySelectorAll('.p2p-custom-select-panel').forEach((p) => p.classList.add('hidden'))
  document.querySelectorAll('.p2p-custom-select-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'))
}

function bindCoinDropdown() {
  const btn = document.getElementById('p2p-coin-btn')
  const panel = document.getElementById('p2p-coin-panel')
  const searchInput = document.getElementById('p2p-coin-search')
  const list = document.getElementById('p2p-coin-list')

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const alreadyOpen = !panel.classList.contains('hidden')
    closeAllDropdowns()
    if (!alreadyOpen) {
      panel.classList.remove('hidden')
      btn.setAttribute('aria-expanded', 'true')
      searchInput.focus()
    }
  })

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase()
    list.querySelectorAll('li').forEach((li) => {
      li.style.display = !q || li.textContent.toLowerCase().includes(q) ? '' : 'none'
    })
  })

  searchInput.addEventListener('click', (e) => e.stopPropagation())

  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-value]')
    if (!li) return
    setCoinSelection(li.dataset.value)
    closeAllDropdowns()
    queueOffersRefresh(true)
  })
}

function setCoinSelection(value) {
  selectedCoin = value
  const list = document.getElementById('p2p-coin-list')
  const label = document.getElementById('p2p-coin-label')
  const searchInput = document.getElementById('p2p-coin-search')
  list.querySelectorAll('li').forEach((li) => {
    li.classList.toggle('selected', li.dataset.value === value)
    li.style.display = ''
  })
  if (searchInput) searchInput.value = ''
  label.textContent = value || 'All coins'
}

function bindCurrencyDropdown() {
  const btn = document.getElementById('p2p-currency-btn')
  const panel = document.getElementById('p2p-currency-panel')
  const searchInput = document.getElementById('p2p-currency-search')
  const list = document.getElementById('p2p-currency-list')

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const alreadyOpen = !panel.classList.contains('hidden')
    closeAllDropdowns()
    if (!alreadyOpen) {
      panel.classList.remove('hidden')
      btn.setAttribute('aria-expanded', 'true')
      searchInput.focus()
    }
  })

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase()
    list.querySelectorAll('li').forEach((li) => {
      li.style.display = !q || li.textContent.toLowerCase().includes(q) ? '' : 'none'
    })
  })

  searchInput.addEventListener('click', (e) => e.stopPropagation())

  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-value]')
    if (!li) return
    setCurrencySelection(li.dataset.value)
    closeAllDropdowns()
    queueOffersRefresh(true)
  })
}

function bindPaymentMethodDropdown() {
  const btn = document.getElementById('p2p-pm-btn')
  const panel = document.getElementById('p2p-pm-panel')
  const searchInput = document.getElementById('p2p-pm-search')
  const list = document.getElementById('p2p-pm-list')

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const alreadyOpen = !panel.classList.contains('hidden')
    closeAllDropdowns()
    if (!alreadyOpen) {
      panel.classList.remove('hidden')
      btn.setAttribute('aria-expanded', 'true')
      searchInput.focus()
    }
  })

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase()
    list.querySelectorAll('li').forEach((li) => {
      li.style.display = !q || li.textContent.toLowerCase().includes(q) ? '' : 'none'
    })
  })

  searchInput.addEventListener('click', (e) => e.stopPropagation())

  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-value]')
    if (!li) return
    setPmSelection(li.dataset.value, li.textContent)
    closeAllDropdowns()
    queueOffersRefresh(true)
  })
}

function bindSortDropdown() {
  const btn = document.getElementById('p2p-sort-btn')
  const panel = document.getElementById('p2p-sort-panel')
  const list = document.getElementById('p2p-sort-list')

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const alreadyOpen = !panel.classList.contains('hidden')
    closeAllDropdowns()
    if (!alreadyOpen) {
      panel.classList.remove('hidden')
      btn.setAttribute('aria-expanded', 'true')
    }
  })

  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-value]')
    if (!li) return
    setSortSelection(li.dataset.value)
    closeAllDropdowns()
    applyFilters()
  })
}

function setSortSelection(value) {
  selectedSort = value
  const list = document.getElementById('p2p-sort-list')
  list.querySelectorAll('li').forEach((li) => li.classList.toggle('selected', li.dataset.value === value))
  const btn = document.getElementById('p2p-sort-btn')
  btn.classList.toggle('p2p-sort-active', value !== 'reputation')
}

function setCurrencySelection(value) {
  selectedCurrency = value
  const list = document.getElementById('p2p-currency-list')
  const label = document.getElementById('p2p-currency-label')
  const searchInput = document.getElementById('p2p-currency-search')
  list.querySelectorAll('li').forEach((li) => {
    li.classList.toggle('selected', li.dataset.value === value)
    li.style.display = ''
  })
  if (searchInput) searchInput.value = ''
  const active = list.querySelector(`li[data-value="${value}"]`)
  label.textContent = active ? active.textContent : 'All currencies'
}

function setPmSelection(value, text) {
  selectedPaymentMethod = value
  const list = document.getElementById('p2p-pm-list')
  const label = document.getElementById('p2p-pm-label')
  const searchInput = document.getElementById('p2p-pm-search')
  list.querySelectorAll('li').forEach((li) => {
    li.classList.toggle('selected', li.dataset.value === value)
    li.style.display = ''
  })
  if (searchInput) searchInput.value = ''
  label.textContent = value ? (text || value) : 'All methods'
}

function getPaymentMethodName(id) {
  return paymentMethods.find((method) => method.id === id)?.name || id || 'Unknown method'
}

function getPaymentMethodEscrowFeePct(id) {
  return Number(paymentMethods.find((method) => method.id === id)?.escrow_fee_pct || 1)
}

async function getUsdPrices() {
  if (usdPrices) return usdPrices
  const ids = Object.values(COIN_TO_GECKO).join(',')
  try {
    const res = await fetch(`/api/wallet/prices?ids=${encodeURIComponent(ids)}`)
    if (!res.ok) throw new Error('Price request failed')
    usdPrices = await res.json()
    return usdPrices
  } catch {
    return {}
  }
}

function marketOfferType() {
  return selectedSide === 'buy' ? 'sell' : 'buy'
}

function buildMarketQuery() {
  const rawAmount = document.getElementById('p2p-amount')?.value || ''
  const amount = Number.parseFloat(rawAmount)
  return {
    market: true,
    side: selectedSide,
    coin: selectedCoin,
    currency: selectedCurrency || undefined,
    payment_method: selectedPaymentMethod || undefined,
    amount: Number.isFinite(amount) && amount > 0 ? amount : undefined,
  }
}

function queueOffersRefresh(immediate = false) {
  if (offersRefreshTimer) {
    clearTimeout(offersRefreshTimer)
    offersRefreshTimer = null
  }
  const delay = immediate ? 0 : 250
  offersRefreshTimer = setTimeout(() => {
    offersRefreshTimer = null
    void loadOffers(buildMarketQuery())
  }, delay)
}

function applyFilters() {
  const currency = selectedCurrency
  const pmId = selectedPaymentMethod
  const desiredOfferType = marketOfferType()

  const filtered = allOffers
    .filter((offer) => offer.status === 'active')
    .filter((offer) => offer.offer_type === desiredOfferType)
    .filter((offer) => !currency || offer.currency === currency)
    .filter((offer) => !pmId || offer.card === pmId)
    .sort((a, b) => {
      if (selectedSort === 'profit_asc') return Number(a.profit_pct) - Number(b.profit_pct)
      if (selectedSort === 'profit_desc') return Number(b.profit_pct) - Number(a.profit_pct)
      if (selectedSort === 'trades') {
        return (profileCache.get(b.creator_uid)?.trade_count || 0) - (profileCache.get(a.creator_uid)?.trade_count || 0)
      }
      if (selectedSort === 'newest') return b.created_at - a.created_at
      // default: reputation
      const aScore = (profileCache.get(a.creator_uid)?.feedback_pos || 0) - (profileCache.get(a.creator_uid)?.feedback_neg || 0)
      const bScore = (profileCache.get(b.creator_uid)?.feedback_pos || 0) - (profileCache.get(b.creator_uid)?.feedback_neg || 0)
      return bScore - aScore
    })

  updateHero(filtered)
  renderOffers(filtered)
}

function updateHero(offers) {
  const title = document.getElementById('p2p-hero-title')
  const action = selectedSide === 'buy' ? 'Buy' : 'Sell'
  const pmLabel = selectedPaymentMethod ? getPaymentMethodName(selectedPaymentMethod) : 'popular payment methods'
  title.textContent = `${action} ${selectedCoin} with ${pmLabel}`
}

function renderOffers(offers) {
  const list = document.getElementById('p2p-list')
  if (!offers.length) {
    list.innerHTML = '<div class="card"><p class="muted">No offers found. Try adjusting your filters.</p></div>'
    return
  }

  list.innerHTML = offers.map((offer) => renderOfferCard(offer)).join('')
  list.querySelectorAll('.btn-start-trade').forEach((button) => {
    button.addEventListener('click', () => startTrade(button.dataset.id))
  })
}

function renderOfferCard(offer) {
  const profile = profileCache.get(offer.creator_uid)
  const username = profile?.username || shortUid(offer.creator_uid)
  const avatarPath = avatarPathFromNumber(profile?.avatar_number || 1)
  const feedbackPos = profile?.feedback_pos || 0
  const feedbackNeg = profile?.feedback_neg || 0
  const totalFeedback = feedbackPos + feedbackNeg
  const satisfaction = totalFeedback ? `${Math.round((feedbackPos / totalFeedback) * 100)}%` : 'New'
  const trades = profile?.trade_count || totalFeedback
  const buttonLabel = selectedSide === 'buy' ? 'Buy' : 'Sell'
  const paymentMethod = getPaymentMethodName(offer.card)

  return `
    <article class="p2p-offer-card">
      <div class="p2p-offer-trader">
        <img class="p2p-offer-avatar" src="${escHtml(avatarPath)}" alt="" />
        <div class="p2p-offer-trader-copy">
          <div class="p2p-offer-trader-top">
            <strong class="p2p-offer-username">${escHtml(username)}</strong>
            <span class="p2p-offer-badge">${buttonLabel}</span>
          </div>
          <div class="p2p-offer-trader-meta">
            <span>${escHtml(satisfaction)} positive</span>
            <span>${formatTradeCount(trades)}</span>
          </div>
        </div>
      </div>

      <div class="p2p-offer-body">
        <div class="p2p-offer-stat">
          <span class="p2p-offer-label">Profit</span>
          <strong class="p2p-offer-value">${formatProfit(offer.profit_pct)}</strong>
        </div>

        <div class="p2p-offer-stat">
          <span class="p2p-offer-label">Payment method</span>
          <strong class="p2p-offer-value">${escHtml(paymentMethod)}</strong>
          <span class="p2p-offer-subtle">${escHtml(offer.currency)} settlement</span>
        </div>

        <div class="p2p-offer-stat p2p-offer-action-block">
          <span class="p2p-offer-label">You ${selectedSide === 'buy' ? 'pay' : 'receive'}</span>
          <strong class="p2p-offer-value">${escHtml(offer.currency)}</strong>
          <button class="p2p-card-action btn-start-trade${selectedSide === 'sell' ? ' sell' : ''}" data-id="${escHtml(offer.id)}">${buttonLabel}</button>
        </div>
      </div>

    </article>
  `
}

function formatTradeCount(count) {
  if (!count) return 'No completed trades'
  return `${count} trade${count === 1 ? '' : 's'}`
}

function formatProfit(value) {
  const numeric = Number(value)
  if (Number.isNaN(numeric)) return '—'
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(1)}%`
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

function formatTimeLimit(seconds) {
  if (seconds === 900) return '15 min'
  if (seconds === 1800) return '30 min'
  if (seconds === 3600) return '1 hr'
  return `${Math.max(1, Math.round(seconds / 60))} min`
}

function timeAgo(unix) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(unix || 0))
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`
  return `${Math.floor(seconds / 86400)} day ago`
}

function shortUid(uid) {
  if (!uid) return 'Trader'
  return `${uid.slice(0, 8)}…`
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

async function startTrade(offerId) {
  ensureTradeModal()
  const offer = allOffers.find((item) => item.id === offerId)
  const modal = document.getElementById('start-trade-modal')
  const errEl = document.getElementById('start-trade-error')
  const breakdownEl = document.getElementById('trade-buy-breakdown')
  const fiatInput = document.getElementById('trade-fiat-amount')
  const cryptoInput = document.getElementById('trade-crypto-amount')
  const prefillAmount = document.getElementById('p2p-amount').value
  const paymentMethod = offer ? getPaymentMethodName(offer.card) : ''
  const offerCoin = String(offer?.coin || selectedCoin || 'BTC').toUpperCase()

  document.getElementById('start-trade-offer-label').textContent =
    offer ? `${selectedSide === 'buy' ? 'Buy' : 'Sell'} ${offerCoin} with ${paymentMethod} (${offer.currency})` : ''
  document.getElementById('trade-currency-label').textContent = offer?.currency || 'USD'
  fiatInput.value = prefillAmount || ''
  cryptoInput.value = ''
  cryptoInput.dataset.rawAmount = ''
  errEl.textContent = ''
  breakdownEl.textContent = ''
  document.getElementById('trade-fees-summary')?.classList.add('hidden')
  const feesToggle = document.getElementById('trade-fees-toggle')
  if (feesToggle) feesToggle.textContent = 'Show fees summary'

  modal.classList.remove('hidden')

  const prices = await getUsdPrices()

  const updateBuyPreview = () => {
    if (!offer) {
      breakdownEl.textContent = ''
      return
    }

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
    const senderRole = selectedSide === 'buy' ? 'Counterparty releases crypto' : 'You release crypto'
    const receiverRole = selectedSide === 'buy' ? 'You receive crypto' : 'Counterparty receives crypto'

    // crypto_amount represents locked gross crypto; recipient receives net after escrow fee.
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
    const cryptoAmount = Number.parseFloat(cryptoInput.dataset.rawAmount || '')
    const coin = offerCoin

    errEl.textContent = ''
    if (Number.isNaN(fiatAmount) || fiatAmount <= 0) { errEl.textContent = 'Enter a valid fiat amount.'; return }
    if (Number.isNaN(cryptoAmount) || cryptoAmount <= 0) { errEl.textContent = 'Enter a valid crypto amount.'; return }

    btn.disabled = true
    try {
      const { createTrade } = await import('../api.js')
      const trade = await createTrade({ offer_id: offerId, fiat_amount: fiatAmount, crypto_amount: cryptoAmount, coin })
      modal.classList.add('hidden')
      window.location.href = `/trades.html?trade=${trade.id}`
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
