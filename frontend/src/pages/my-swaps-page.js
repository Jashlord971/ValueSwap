
import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, listMySwapOffers, createSwapOffer, updateSwapOffer, toggleSwapOffer, deleteSwapOffer, cancelSwapOffer, getUserProfile, getUsdPrices } from '../api.js'
import { showAlert, showConfirm } from '../modal.js'
import { avatarPathFromProfile } from '../avatar.js'
import { COIN_LOGOS } from '../coin-logos.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

const COINS = ['BTC', 'ETH', 'USDT', 'USDC']
const SWAP_FEE_PCT = 1
const COIN_TO_GECKO = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
}

let currentUser = null
const profileCache = new Map()
let priceCache = null
let editingOfferId = null
// Which unit the min/max range inputs are currently showing — defaults to USD
// since raw BTC/ETH amounts (e.g. 0.00015) are hard to reason about; can be
// switched to the coin's own units per coin like the wallet Send modal.
let swapAmountUnit = 'usd'

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

  document.getElementById('btn-new-swap').addEventListener('click', () => openCreateSwapModal())

  await loadMySwaps()
})

async function loadMySwaps() {
  const list = document.getElementById('my-swaps-list')
  try {
    const offers = await listMySwapOffers()
    await hydrateProfiles(offers)
    renderMySwaps(list, offers)
  } catch (e) {
    list.innerHTML = `<p class="error">Failed to load your swaps: ${escHtml(e.message)}</p>`
  }
}

async function hydrateProfiles(offers) {
  const uids = [...new Set(offers.flatMap((o) => [o.creator_uid, o.last_taker_uid]).filter(Boolean))]
  await Promise.all(uids.map(async (uid) => {
    if (profileCache.has(uid)) return
    try { profileCache.set(uid, await getUserProfile(uid)) } catch { profileCache.set(uid, null) }
  }))
}

function renderMySwaps(list, offers) {
  if (!offers.length) {
    list.innerHTML = '<div class="card"><p class="muted">You haven\'t posted or taken any swaps yet. <a href="/swaps.html">Browse the swap board</a>.</p></div>'
    return
  }

  const sorted = [...offers].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
  list.innerHTML = sorted.map(buildMySwapCard).join('')
  list.querySelectorAll('.btn-cancel-swap').forEach((btn) => {
    btn.addEventListener('click', () => handleCancel(btn.dataset.id))
  })
  list.querySelectorAll('.btn-toggle-swap').forEach((btn) => {
    btn.addEventListener('click', () => handleToggle(btn.dataset.id, btn.dataset.active === 'true'))
  })
  list.querySelectorAll('.btn-edit-swap').forEach((btn) => {
    const offer = sorted.find((o) => o.id === btn.dataset.id)
    if (offer) btn.addEventListener('click', () => openCreateSwapModal(offer))
  })
  list.querySelectorAll('.btn-delete-swap').forEach((btn) => {
    btn.addEventListener('click', () => handleDelete(btn.dataset.id))
  })
}

function buildMySwapCard(offer) {
  const isCreator = offer.creator_uid === currentUser.uid
  // Note: last_taker_uid only tracks the most recent fill. If you filled part
  // of an open offer and someone else fills more later, this card's "posted
  // by"/counterparty info will reflect them, not you — the exact amount you
  // personally sent and received is always accurate in /wallet/transactions.
  const roleLabel = isCreator ? 'You posted this' : 'You took part of this'
  const fromCoin = String(offer.from_coin || '').toUpperCase()
  const toCoin = String(offer.to_coin || '').toUpperCase()
  const fromLogo = COIN_LOGOS[fromCoin]
  const toLogo = COIN_LOGOS[toCoin]
  const status = String(offer.status || '').toLowerCase()
  const statusClass = `status-${status}`
  const counterpartyUid = isCreator ? offer.last_taker_uid : offer.creator_uid
  const counterpartyProfile = counterpartyUid ? profileCache.get(counterpartyUid) : null
  const counterpartyName = counterpartyProfile?.username || (counterpartyUid ? `${counterpartyUid.slice(0, 8)}…` : '—')
  const when = offer.created_at ? new Date(Number(offer.created_at) * 1000).toLocaleString() : '—'
  const feePct = Number(offer.fee_pct || 0)
  const rawRate = Number(offer.to_amount) / Number(offer.max_amount)
  const rate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 0
  const filledAmount = Math.max(0, Number(offer.max_amount) - Number(offer.remaining_amount))
  const creatorReceivedTotal = filledAmount * rate * (1 - feePct / 100)
  const rangeLabel = Number(offer.min_amount) >= Number(offer.max_amount) - 1e-9
    ? formatCoinAmount(offer.max_amount)
    : `${formatCoinAmount(offer.min_amount)}–${formatCoinAmount(offer.max_amount)}`

  return `
    <div class="trade-card" data-id="${escHtml(offer.id)}">
      <div class="trade-card-header">
        <div class="trade-partner">
          <div>
            <span class="trade-partner-label">${escHtml(roleLabel)}</span>
            <span class="trade-partner-id">${isCreator
              ? (offer.last_taker_uid ? `last taken by ${escHtml(counterpartyName)}` : 'Waiting for a taker')
              : `posted by ${escHtml(counterpartyName)}`}</span>
          </div>
        </div>
        <span class="trade-status-badge ${statusClass}">${escHtml(offer.status)}</span>
      </div>
      <div class="trade-card-body">
        <div class="trade-detail-row">
          <span class="trade-detail-label">${isCreator ? 'Range offered' : 'Offer range'}</span>
          <span class="trade-detail-value">${fromLogo ? `<img src="${escHtml(fromLogo)}" alt="" style="width:16px;height:16px;vertical-align:middle;margin-right:0.3rem;" />` : ''}${rangeLabel} ${escHtml(fromCoin)}</span>
        </div>
        ${isCreator ? `
        <div class="trade-detail-row">
          <span class="trade-detail-label">Remaining</span>
          <span class="trade-detail-value">${formatCoinAmount(offer.remaining_amount)} ${escHtml(fromCoin)}</span>
        </div>` : ''}
        <div class="trade-detail-row">
          <span class="trade-detail-label">Full-fill price</span>
          <span class="trade-detail-value">${toLogo ? `<img src="${escHtml(toLogo)}" alt="" style="width:16px;height:16px;vertical-align:middle;margin-right:0.3rem;" />` : ''}${formatCoinAmount(offer.to_amount)} ${escHtml(toCoin)}</span>
        </div>
        ${isCreator ? `
        <div class="trade-detail-row">
          <span class="trade-detail-label">Your rate</span>
          <span class="trade-detail-value">${Number(offer.profit_pct || 0) > 0 ? '+' : ''}${Number(offer.profit_pct || 0).toFixed(1)}%</span>
        </div>` : ''}
        ${isCreator && filledAmount > 0 ? `
        <div class="trade-detail-row">
          <span class="trade-detail-label">Received so far</span>
          <span class="trade-detail-value">${formatCoinAmount(creatorReceivedTotal)} ${escHtml(toCoin)} (after ${feePct}% fee)</span>
        </div>` : ''}
        ${!isCreator ? `
        <div class="trade-detail-row">
          <span class="trade-detail-label">Exact amounts</span>
          <span class="trade-detail-value"><a href="/transactions.html">View in Transactions</a></span>
        </div>` : ''}
        <div class="trade-detail-row">
          <span class="trade-detail-label">Posted</span>
          <span class="trade-detail-value">${escHtml(when)}</span>
        </div>
      </div>
      ${isCreator && (status === 'open' || status === 'paused') ? `
      <div class="trade-card-actions">
        <button class="btn-sm btn-toggle-swap" data-id="${escHtml(offer.id)}" data-active="${status === 'open' ? 'false' : 'true'}">${status === 'open' ? 'Turn Off' : 'Turn On'}</button>
        <button class="btn-sm btn-edit-swap" data-id="${escHtml(offer.id)}">Edit</button>
        <button class="btn-sm btn-danger btn-cancel-swap" data-id="${escHtml(offer.id)}">Cancel Offer</button>
      </div>` : ''}
      ${isCreator && (status === 'cancelled' || status === 'filled') ? `
      <div class="trade-card-actions">
        <button class="btn-sm btn-danger btn-delete-swap" data-id="${escHtml(offer.id)}">Delete</button>
      </div>` : ''}
    </div>
  `
}

async function handleCancel(id) {
  const ok = await showConfirm('Cancel this swap offer? Your locked funds are returned to your available balance.')
  if (!ok) return
  try {
    await cancelSwapOffer(id)
    await loadMySwaps()
    void refreshNavCombinedBalance()
  } catch (e) {
    await showAlert(`Cancel failed: ${e.message}`)
  }
}

async function handleToggle(id, nextActive) {
  try {
    await toggleSwapOffer(id, nextActive)
    await loadMySwaps()
  } catch (e) {
    await showAlert(`${nextActive ? 'Turning on' : 'Turning off'} failed: ${e.message}`)
  }
}

async function handleDelete(id) {
  const ok = await showConfirm('Delete this swap offer? This just removes it from your history and cannot be undone.')
  if (!ok) return
  try {
    await deleteSwapOffer(id)
    await loadMySwaps()
  } catch (e) {
    await showAlert(`Delete failed: ${e.message}`)
  }
}

function ensureCreateSwapModal() {
  if (document.getElementById('create-swap-modal')) return
  const el = document.createElement('div')
  el.innerHTML = `
    <div id="create-swap-modal" class="modal-overlay hidden" role="dialog" aria-modal="true">
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <h3>New Swap Offer</h3>
          <button id="close-create-swap-modal" class="modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="field-row">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem;">
              <label for="swap-min-amount" style="margin:0;">You give (range)</label>
              <button id="btn-swap-unit-toggle" type="button" class="btn-sm btn-secondary" style="font-size:0.75rem;padding:0.2rem 0.55rem;">Switch to coin</button>
            </div>
            <div style="display:flex;flex-direction:column;gap:0.5rem;margin-top:0.35rem;">
              <input id="swap-min-amount" type="number" min="0" step="any" placeholder="Minimum e.g. 100" class="form-input" />
              <input id="swap-max-amount" type="number" min="0" step="any" placeholder="Maximum e.g. 500" class="form-input" />
              <select id="swap-from-coin" class="form-input">${COINS.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
            </div>
            <span id="swap-range-unit-hint" class="muted" style="font-size:0.78rem;"></span>
          </div>
          <div class="field-row">
            <label for="swap-to-coin">You want</label>
            <select id="swap-to-coin" class="form-input">${COINS.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
          </div>
          <div class="field-row">
            <label for="swap-profit-pct">Your profit/loss rate (%)</label>
            <input id="swap-profit-pct" type="number" step="any" placeholder="0" class="form-input" value="0" />
            <span class="muted" style="font-size:0.78rem;">Positive = you want more value back than you're giving. Negative = a discount, to get taken faster.</span>
          </div>
          <p id="swap-preview" class="muted" style="margin-top:0.35rem;"></p>
          <p id="create-swap-error" class="error"></p>
          <button id="btn-submit-swap" style="width:100%">Post Swap Offer</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(el.firstElementChild)
  document.getElementById('close-create-swap-modal').addEventListener('click', () => {
    document.getElementById('create-swap-modal').classList.add('hidden')
  })
  document.getElementById('swap-to-coin').value = 'USDC'

  document.getElementById('btn-swap-unit-toggle').addEventListener('click', () => {
    const price = currentFromPrice()
    const minInput = document.getElementById('swap-min-amount')
    const maxInput = document.getElementById('swap-max-amount')
    const minDisplay = Number.parseFloat(minInput.value)
    const maxDisplay = Number.parseFloat(maxInput.value)

    if (swapAmountUnit === 'usd' && price) {
      // usd -> coin
      swapAmountUnit = 'coin'
      if (Number.isFinite(minDisplay)) minInput.value = formatCoinAmount(minDisplay / price)
      if (Number.isFinite(maxDisplay)) maxInput.value = formatCoinAmount(maxDisplay / price)
    } else if (price) {
      // coin -> usd
      swapAmountUnit = 'usd'
      if (Number.isFinite(minDisplay)) minInput.value = (minDisplay * price).toFixed(2)
      if (Number.isFinite(maxDisplay)) maxInput.value = (maxDisplay * price).toFixed(2)
    }
    updateSwapUnitLabels()
    updateSwapPreview()
  })

  document.getElementById('swap-min-amount').oninput = updateSwapPreview
  document.getElementById('swap-max-amount').oninput = updateSwapPreview
  document.getElementById('swap-from-coin').onchange = () => { updateSwapUnitLabels(); updateSwapPreview() }
  document.getElementById('swap-to-coin').onchange = updateSwapPreview
  document.getElementById('swap-profit-pct').oninput = updateSwapPreview
}

function currentFromPrice() {
  return priceCache?.[COIN_TO_GECKO[document.getElementById('swap-from-coin')?.value]]?.usd
}

function updateSwapUnitLabels() {
  const fromCoin = document.getElementById('swap-from-coin').value
  const toggleBtn = document.getElementById('btn-swap-unit-toggle')
  const hint = document.getElementById('swap-range-unit-hint')
  const minInput = document.getElementById('swap-min-amount')
  const maxInput = document.getElementById('swap-max-amount')
  if (swapAmountUnit === 'usd') {
    toggleBtn.textContent = `Switch to ${fromCoin}`
    hint.textContent = `Amounts in USD — converted to ${fromCoin} automatically. A taker can fill any amount in this range, not just the full max.`
    minInput.placeholder = 'Minimum e.g. 100'
    maxInput.placeholder = 'Maximum e.g. 500'
  } else {
    toggleBtn.textContent = 'Switch to USD'
    hint.textContent = `Amounts in ${fromCoin}. A taker can fill any amount in this range, not just the full max.`
    minInput.placeholder = `Minimum ${fromCoin}`
    maxInput.placeholder = `Maximum ${fromCoin}`
  }
}

/** Reads the min/max inputs in whatever unit is currently displayed and
 * returns them converted to from_coin units (what the backend always wants). */
function readSwapRangeAsCoin() {
  const fromPrice = currentFromPrice()
  const minDisplay = Number.parseFloat(document.getElementById('swap-min-amount').value)
  const maxDisplay = Number.parseFloat(document.getElementById('swap-max-amount').value)
  const toCoin = (v) => (swapAmountUnit === 'usd' && fromPrice ? v / fromPrice : v)
  return { minAmount: toCoin(minDisplay), maxAmount: toCoin(maxDisplay) }
}

function updateSwapPreview() {
  const fromCoin = document.getElementById('swap-from-coin').value
  const toCoin = document.getElementById('swap-to-coin').value
  const profitPct = Number.parseFloat(document.getElementById('swap-profit-pct').value)
  const preview = document.getElementById('swap-preview')
  const fromPrice = currentFromPrice()
  const toPrice = priceCache?.[COIN_TO_GECKO[toCoin]]?.usd
  const { minAmount, maxAmount } = readSwapRangeAsCoin()

  if (!Number.isFinite(maxAmount) || maxAmount <= 0) { preview.textContent = ''; return }
  const afterFee = maxAmount * (1 - SWAP_FEE_PCT / 100)
  const rangeNote = Number.isFinite(minAmount) && minAmount > 0
    ? `Takers can fill anywhere from ${formatCoinAmount(minAmount)} to ${formatCoinAmount(maxAmount)} ${fromCoin}.`
    : ''

  if (!fromPrice || !toPrice || !Number.isFinite(profitPct)) {
    preview.textContent = `A full fill gives the taker ${formatCoinAmount(afterFee)} ${fromCoin} after the ${SWAP_FEE_PCT}% platform fee. ${rangeNote}`
    return
  }

  const toAmount = (maxAmount * fromPrice * (1 + profitPct / 100)) / toPrice
  const toAfterFee = toAmount * (1 - SWAP_FEE_PCT / 100)
  preview.textContent = toAmount > 0
    ? `A full fill costs a taker ≈${formatCoinAmount(toAmount)} ${toCoin}; you'd receive ≈${formatCoinAmount(toAfterFee)} ${toCoin} and they'd receive ${formatCoinAmount(afterFee)} ${fromCoin} — both after the ${SWAP_FEE_PCT}% fee. Partial fills are priced pro-rata. ${rangeNote}`
    : `That rate works out to zero or less — raise the rate above ${(-100).toFixed(0)}%.`
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

async function openCreateSwapModal(offer = null) {
  ensureCreateSwapModal()
  editingOfferId = offer ? offer.id : null
  const modal = document.getElementById('create-swap-modal')
  const minInput = document.getElementById('swap-min-amount')
  const maxInput = document.getElementById('swap-max-amount')
  const fromSelect = document.getElementById('swap-from-coin')
  const toSelect = document.getElementById('swap-to-coin')

  document.getElementById('create-swap-modal').querySelector('h3').textContent = offer ? 'Edit Swap Offer' : 'New Swap Offer'
  document.getElementById('btn-submit-swap').textContent = offer ? 'Save Changes' : 'Post Swap Offer'

  // from_coin/to_coin/the total size aren't editable — changing what's
  // actually collateralized needs a cancel-and-repost instead — so those
  // fields lock to the offer's current values while editing.
  fromSelect.value = offer ? String(offer.from_coin).toUpperCase() : fromSelect.value
  fromSelect.disabled = !!offer
  toSelect.value = offer ? String(offer.to_coin).toUpperCase() : 'USDC'
  toSelect.disabled = !!offer
  maxInput.disabled = !!offer
  document.getElementById('swap-profit-pct').value = offer ? offer.profit_pct : '0'
  document.getElementById('create-swap-error').textContent = ''
  document.getElementById('swap-preview').textContent = ''
  minInput.value = ''
  maxInput.value = ''
  modal.classList.remove('hidden')

  await loadPrices()
  // Default to USD when we have a price to convert with — raw BTC/ETH
  // amounts (e.g. 0.00015) are hard to type/reason about, same call as the
  // wallet Send modal.
  const price = currentFromPrice()
  swapAmountUnit = price ? 'usd' : 'coin'
  const toDisplay = (coinAmount) => (swapAmountUnit === 'usd' && price ? (coinAmount * price).toFixed(2) : formatCoinAmount(coinAmount))
  minInput.value = offer ? toDisplay(offer.min_amount) : ''
  maxInput.value = offer ? toDisplay(offer.remaining_amount) : ''
  updateSwapUnitLabels()
  updateSwapPreview()

  const btn = document.getElementById('btn-submit-swap')
  const handler = async () => {
    const errEl = document.getElementById('create-swap-error')
    errEl.textContent = ''
    const from_coin = fromSelect.value
    const to_coin = toSelect.value
    const { minAmount: min_amount, maxAmount: max_amount } = readSwapRangeAsCoin()
    const profit_pct = Number.parseFloat(document.getElementById('swap-profit-pct').value)

    if (from_coin === to_coin) { errEl.textContent = 'Choose two different coins.'; return }
    if (!Number.isFinite(min_amount) || min_amount <= 0) { errEl.textContent = 'Enter a valid minimum amount.'; return }
    if (!editingOfferId && (!Number.isFinite(max_amount) || max_amount <= 0)) { errEl.textContent = 'Enter a valid maximum amount.'; return }
    if (!editingOfferId && min_amount > max_amount) { errEl.textContent = 'Minimum cannot be greater than maximum.'; return }
    // A generous tolerance here — converting through a USD display value and
    // back can lose a little precision (rounded to cents), so a min that
    // wasn't actually changed shouldn't get rejected as "too big" by a hair.
    if (editingOfferId && min_amount > Number(offer.remaining_amount) + 1e-6) { errEl.textContent = 'Minimum cannot exceed what remains on this offer.'; return }
    if (!Number.isFinite(profit_pct)) { errEl.textContent = 'Enter a profit/loss rate (0 for an even swap).'; return }

    btn.disabled = true
    try {
      if (editingOfferId) {
        await updateSwapOffer(editingOfferId, { min_amount, profit_pct })
      } else {
        await createSwapOffer({ from_coin, to_coin, min_amount, max_amount, profit_pct })
      }
      modal.classList.add('hidden')
      await loadMySwaps()
      void refreshNavCombinedBalance()
    } catch (e) {
      errEl.textContent = e.message
    } finally {
      btn.disabled = false
    }
  }

  const fresh = btn.cloneNode(true)
  btn.replaceWith(fresh)
  fresh.addEventListener('click', handler)
}

function formatCoinAmount(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '0'
  if (numeric >= 1) return numeric.toFixed(6).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  return numeric.toFixed(8).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
