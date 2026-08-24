
import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, listSwapOffers, acceptSwapOffer, getUserProfile, getUsdPrices } from '../api.js'
import { showAlert, showConfirm } from '../modal.js'
import { avatarPathFromProfile, avatarPathFromNumber } from '../avatar.js'
import { COIN_LOGOS } from '../coin-logos.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

const COINS = ['BTC', 'ETH', 'USDT', 'USDC']
const COIN_TO_GECKO = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
}

let currentUser = null
let profileCache = new Map()
let pollTimer = null
let priceCache = null
let allOffers = []
const filters = { getCoin: '', giveCoin: '', minUsd: '', maxUsd: '' }
// Per-card unit for the "amount to take" input, keyed by offer id — defaults
// to USD (set the first time a card is built) so raw BTC/ETH amounts aren't
// the only way to size a fill; a taker can switch a given card back to coin units.
const takeUnitByOfferId = new Map()

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }
  currentUser = user

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

  bindFilters()
  await loadPrices()
  await loadSwaps()
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(loadSwaps, 20000)
})

function bindFilters() {
  const getSelect = document.getElementById('filter-get-coin')
  const giveSelect = document.getElementById('filter-give-coin')
  const minInput = document.getElementById('filter-min-usd')
  const maxInput = document.getElementById('filter-max-usd')
  const clearBtn = document.getElementById('btn-clear-swap-filters')
  if (!getSelect || !giveSelect || !minInput || !maxInput) return

  const optionsHtml = '<option value="">Any</option>' + COINS.map((c) => `<option value="${c}">${c}</option>`).join('')
  getSelect.innerHTML = optionsHtml
  giveSelect.innerHTML = optionsHtml

  getSelect.addEventListener('change', () => { filters.getCoin = getSelect.value; renderSwaps(document.getElementById('swaps-list'), allOffers) })
  giveSelect.addEventListener('change', () => { filters.giveCoin = giveSelect.value; renderSwaps(document.getElementById('swaps-list'), allOffers) })
  minInput.addEventListener('input', () => { filters.minUsd = minInput.value; renderSwaps(document.getElementById('swaps-list'), allOffers) })
  maxInput.addEventListener('input', () => { filters.maxUsd = maxInput.value; renderSwaps(document.getElementById('swaps-list'), allOffers) })
  clearBtn?.addEventListener('click', () => {
    filters.getCoin = ''; filters.giveCoin = ''; filters.minUsd = ''; filters.maxUsd = ''
    getSelect.value = ''; giveSelect.value = ''; minInput.value = ''; maxInput.value = ''
    renderSwaps(document.getElementById('swaps-list'), allOffers)
  })
}

async function loadPrices() {
  if (priceCache) return priceCache
  try {
    priceCache = await getUsdPrices(Object.values(COIN_TO_GECKO))
  } catch {
    priceCache = null
  }
  return priceCache
}

async function loadSwaps() {
  const list = document.getElementById('swaps-list')
  try {
    allOffers = await listSwapOffers()
    await hydrateProfiles(allOffers)
    renderSwaps(list, allOffers)
  } catch (e) {
    list.innerHTML = `<p class="error">Failed to load swap offers: ${escHtml(e.message)}</p>`
  }
}

async function hydrateProfiles(offers) {
  const uids = [...new Set(offers.map((o) => o.creator_uid).filter(Boolean))]
  await Promise.all(uids.map(async (uid) => {
    if (profileCache.has(uid)) return
    try { profileCache.set(uid, await getUserProfile(uid)) } catch { profileCache.set(uid, null) }
  }))
}

/** USD value of what's actually still fillable, using from_coin's price. */
function usdRangeFor(offer) {
  const price = priceCache?.[COIN_TO_GECKO[String(offer.from_coin || '').toUpperCase()]]?.usd
  if (!price) return null
  return { min: Number(offer.min_amount) * price, max: Number(offer.remaining_amount) * price }
}

function fromPriceFor(offer) {
  return priceCache?.[COIN_TO_GECKO[String(offer.from_coin || '').toUpperCase()]]?.usd || null
}

function formatUsd(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '$0.00'
  return `$${numeric.toFixed(2)}`
}

function applyFilters(offers) {
  return offers.filter((o) => {
    if (filters.getCoin && String(o.from_coin || '').toUpperCase() !== filters.getCoin) return false
    if (filters.giveCoin && String(o.to_coin || '').toUpperCase() !== filters.giveCoin) return false

    const minUsd = Number.parseFloat(filters.minUsd)
    const maxUsd = Number.parseFloat(filters.maxUsd)
    if (Number.isFinite(minUsd) || Number.isFinite(maxUsd)) {
      const range = usdRangeFor(o)
      if (!range) return true // no price to evaluate against — don't hide it over a filter we can't apply
      if (Number.isFinite(minUsd) && range.max < minUsd) return false
      if (Number.isFinite(maxUsd) && range.min > maxUsd) return false
    }
    return true
  })
}

function renderSwaps(list, allOffersIn) {
  // Defensive: an offer with nothing meaningful left shouldn't render — the
  // backend already excludes non-Open offers, but this also covers any
  // leftover dust-remainder rows from before the Filled-threshold was fixed.
  const live = allOffersIn.filter((o) => Number(o.remaining_amount) > 1e-8 && Number(o.max_amount) > 0)
  const offers = applyFilters(live)
  if (!offers.length) {
    list.innerHTML = `<div class="card"><p class="muted">${live.length ? 'No swap offers match your filters.' : 'No open swap offers right now. Be the first to post one.'}</p></div>`
    return
  }

  list.innerHTML = offers.map(buildSwapCard).join('')
  list.querySelectorAll('.swap-take-amount').forEach((input) => {
    input.addEventListener('input', () => updateTakePreview(input.dataset.id, offers))
    updateTakePreview(input.dataset.id, offers)
  })
  list.querySelectorAll('.swap-take-unit-toggle').forEach((btn) => {
    btn.addEventListener('click', () => handleToggleTakeUnit(btn.dataset.id, offers))
  })
  list.querySelectorAll('.btn-accept-swap').forEach((btn) => {
    btn.addEventListener('click', () => handleAccept(btn.dataset.id))
  })
}

function buildSwapCard(offer) {
  const profile = profileCache.get(offer.creator_uid)
  const username = profile?.username || shortUid(offer.creator_uid)
  const avatarPath = avatarPathFromNumber(profile?.avatar_number || 1)
  const fromCoin = String(offer.from_coin || '').toUpperCase()
  const toCoin = String(offer.to_coin || '').toUpperCase()
  const fromLogo = COIN_LOGOS[fromCoin]
  const toLogo = COIN_LOGOS[toCoin]
  const maxAmount = Number(offer.max_amount)
  const rawRate = Number(offer.to_amount) / maxAmount
  const rate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : null
  const minAmount = Number(offer.min_amount)
  const remaining = Number(offer.remaining_amount)
  const rangeLabel = minAmount >= remaining - 1e-9
    ? formatCoinAmount(remaining)
    : `${formatCoinAmount(minAmount)}–${formatCoinAmount(remaining)}`
  const usdRange = usdRangeFor(offer)
  const usdRangeLabel = usdRange
    ? (usdRange.min >= usdRange.max - 0.005 ? formatUsd(usdRange.max) : `${formatUsd(usdRange.min)}–${formatUsd(usdRange.max)}`)
    : null
  const id = escHtml(offer.id)

  // Default a new card to USD (helps most for BTC/ETH's awkward small
  // decimals); leaves an already-toggled card as the taker left it on refresh.
  if (!takeUnitByOfferId.has(offer.id)) {
    takeUnitByOfferId.set(offer.id, fromPriceFor(offer) ? 'usd' : 'coin')
  }
  const unit = takeUnitByOfferId.get(offer.id)
  const price = fromPriceFor(offer)
  const toDisplay = (coinAmount) => (unit === 'usd' && price ? (coinAmount * price).toFixed(2) : formatCoinAmount(coinAmount))

  return `
    <article class="p2p-offer-card" data-offer-id="${id}">
      <div class="p2p-offer-trader">
        <img class="p2p-offer-avatar" src="${escHtml(avatarPath)}" alt="" />
        <div class="p2p-offer-trader-copy">
          <strong class="p2p-offer-username">${escHtml(username)}</strong>
          <div class="p2p-offer-trader-meta"><span>is offering</span></div>
        </div>
      </div>

      <div class="swap-offer-stats">
        <div class="p2p-offer-stat">
          <span class="p2p-offer-label">Gives (range)</span>
          <strong class="p2p-offer-value">${fromLogo ? `<img src="${escHtml(fromLogo)}" alt="" style="width:18px;height:18px;vertical-align:middle;margin-right:0.3rem;" />` : ''}${rangeLabel} ${escHtml(fromCoin)}</strong>
          ${usdRangeLabel ? `<span class="p2p-offer-subtle">≈${escHtml(usdRangeLabel)}</span>` : ''}
        </div>
        <div class="p2p-offer-stat">
          <span class="p2p-offer-label">Full-fill price</span>
          <strong class="p2p-offer-value">${toLogo ? `<img src="${escHtml(toLogo)}" alt="" style="width:18px;height:18px;vertical-align:middle;margin-right:0.3rem;" />` : ''}${formatCoinAmount(offer.to_amount)} ${escHtml(toCoin)}</strong>
        </div>
      </div>

      <p class="p2p-offer-subtle swap-offer-rate">${rate !== null ? `Rate: 1 ${escHtml(fromCoin)} = ${formatCoinAmount(rate)} ${escHtml(toCoin)}${formatProfitBadge(offer.profit_pct)}` : 'Rate unavailable'}</p>

      <div class="swap-offer-take">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem;">
          <label class="muted" style="font-size:0.78rem;" for="swap-take-${id}">Amount to take${unit === 'usd' ? ' (USD)' : ` (${escHtml(fromCoin)})`}</label>
          ${price ? `<button type="button" class="btn-sm btn-secondary swap-take-unit-toggle" data-id="${id}" style="font-size:0.72rem;padding:0.18rem 0.5rem;">Switch to ${unit === 'usd' ? escHtml(fromCoin) : 'USD'}</button>` : ''}
        </div>
        <div class="swap-take-row">
          <input id="swap-take-${id}" class="form-input swap-take-amount" data-id="${id}"
            type="number" min="${toDisplay(minAmount)}" max="${toDisplay(remaining)}" step="any" value="${toDisplay(remaining)}" />
          <button class="p2p-card-action btn-accept-swap" data-id="${id}">Accept</button>
        </div>
        <span class="p2p-offer-subtle swap-take-preview" data-preview-id="${id}"></span>
      </div>
    </article>
  `
}

/** Converts a take-amount input's current display value to from_coin units. */
function takeAmountAsCoin(offer, input) {
  const unit = takeUnitByOfferId.get(offer.id) || 'coin'
  const price = fromPriceFor(offer)
  const displayValue = Number.parseFloat(input.value)
  if (!Number.isFinite(displayValue)) return NaN
  return unit === 'usd' && price ? displayValue / price : displayValue
}

function updateTakePreview(id, offers) {
  const offer = offers.find((o) => o.id === id)
  const input = document.getElementById(`swap-take-${id}`)
  const preview = document.querySelector(`.swap-take-preview[data-preview-id="${id}"]`)
  if (!offer || !input || !preview) return

  const fromCoin = String(offer.from_coin || '').toUpperCase()
  const toCoin = String(offer.to_coin || '').toUpperCase()
  const takeFromAmount = takeAmountAsCoin(offer, input)
  if (!Number.isFinite(takeFromAmount) || takeFromAmount <= 0) { preview.textContent = ''; return }

  const rate = Number(offer.to_amount) / Number(offer.max_amount)
  if (!Number.isFinite(rate) || rate <= 0) { preview.textContent = ''; return }
  const feeRate = Number(offer.fee_pct || 0) / 100
  const takeToAmount = takeFromAmount * rate
  const youReceive = takeFromAmount * (1 - feeRate)
  preview.textContent = `You'd pay ${formatCoinAmount(takeToAmount)} ${toCoin}, receive ${formatCoinAmount(youReceive)} ${fromCoin} after ${Number(offer.fee_pct || 0)}% fee`
}

function handleToggleTakeUnit(id, offers) {
  const offer = offers.find((o) => o.id === id)
  const input = document.getElementById(`swap-take-${id}`)
  const toggleBtn = document.querySelector(`.swap-take-unit-toggle[data-id="${id}"]`)
  const label = document.querySelector(`label[for="swap-take-${id}"]`)
  if (!offer || !input) return
  const price = fromPriceFor(offer)
  if (!price) return

  // Patch the existing card in place (rather than a full renderSwaps rebuild)
  // so the amount the taker already typed carries over, just re-displayed —
  // a full rebuild would reset every card back to its default full-amount value.
  const coinAmount = takeAmountAsCoin(offer, input)
  const nextUnit = takeUnitByOfferId.get(id) === 'usd' ? 'coin' : 'usd'
  takeUnitByOfferId.set(id, nextUnit)

  const fromCoin = String(offer.from_coin || '').toUpperCase()
  const minAmount = Number(offer.min_amount)
  const remaining = Number(offer.remaining_amount)
  const toDisplay = (v) => (nextUnit === 'usd' ? (v * price).toFixed(2) : formatCoinAmount(v))
  input.min = toDisplay(minAmount)
  input.max = toDisplay(remaining)
  if (Number.isFinite(coinAmount)) input.value = toDisplay(coinAmount)

  if (label) label.textContent = `Amount to take${nextUnit === 'usd' ? ' (USD)' : ` (${fromCoin})`}`
  if (toggleBtn) toggleBtn.textContent = `Switch to ${nextUnit === 'usd' ? fromCoin : 'USD'}`

  updateTakePreview(id, offers)
}

async function handleAccept(id) {
  const offer = allOffers.find((o) => o.id === id)
  const input = document.getElementById(`swap-take-${id}`)
  if (!offer || !input) return
  const amount = takeAmountAsCoin(offer, input)
  if (!Number.isFinite(amount) || amount <= 0) {
    await showAlert('Enter a valid amount to take.')
    return
  }

  const ok = await showConfirm('Accept this swap? Both sides transfer immediately on your internal ledger and cannot be undone.')
  if (!ok) return
  try {
    await acceptSwapOffer(id, amount)
    await loadSwaps()
    void refreshNavCombinedBalance()
  } catch (e) {
    await showAlert(`Accept failed: ${e.message}`)
  }
}

function formatProfitBadge(profitPct) {
  const pct = Number(profitPct || 0)
  if (Math.abs(pct) < 0.01) return ''
  return pct > 0 ? ` (+${pct.toFixed(1)}% for the poster)` : ` (${pct.toFixed(1)}% — better than market)`
}

function formatCoinAmount(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '0'
  if (numeric >= 1) return numeric.toFixed(6).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  return numeric.toFixed(8).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

function shortUid(uid) {
  return uid ? `${uid.slice(0, 8)}…` : 'Trader'
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

window.addEventListener('beforeunload', () => { if (pollTimer) clearInterval(pollTimer) })
