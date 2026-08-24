
import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, listSwapOffers, createSwapOffer, acceptSwapOffer, getUserProfile } from '../api.js'
import { showAlert, showConfirm } from '../modal.js'
import { avatarPathFromProfile, avatarPathFromNumber } from '../avatar.js'
import { COIN_LOGOS } from '../coin-logos.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

const COINS = ['BTC', 'ETH', 'USDT', 'USDC']
const SWAP_FEE_PCT = 1

let currentUser = null
let profileCache = new Map()
let pollTimer = null

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

  document.getElementById('btn-new-swap').addEventListener('click', openCreateSwapModal)

  await loadSwaps()
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(loadSwaps, 20000)
})

async function loadSwaps() {
  const list = document.getElementById('swaps-list')
  try {
    const offers = await listSwapOffers()
    await hydrateProfiles(offers)
    renderSwaps(list, offers)
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

function renderSwaps(list, offers) {
  if (!offers.length) {
    list.innerHTML = '<div class="card"><p class="muted">No open swap offers right now. Be the first to post one.</p></div>'
    return
  }

  list.innerHTML = offers.map(buildSwapCard).join('')
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
  const rate = Number(offer.to_amount) / Number(offer.from_amount)
  const youReceive = Number(offer.from_amount) * (1 - Number(offer.fee_pct || 0) / 100)

  return `
    <article class="p2p-offer-card">
      <div class="p2p-offer-trader">
        <img class="p2p-offer-avatar" src="${escHtml(avatarPath)}" alt="" />
        <div class="p2p-offer-trader-copy">
          <strong class="p2p-offer-username">${escHtml(username)}</strong>
          <div class="p2p-offer-trader-meta"><span>is offering</span></div>
        </div>
      </div>

      <div class="p2p-offer-body">
        <div class="p2p-offer-stat">
          <span class="p2p-offer-label">Gives</span>
          <strong class="p2p-offer-value">${fromLogo ? `<img src="${escHtml(fromLogo)}" alt="" style="width:18px;height:18px;vertical-align:middle;margin-right:0.3rem;" />` : ''}${formatCoinAmount(offer.from_amount)} ${escHtml(fromCoin)}</strong>
        </div>
        <div class="p2p-offer-stat">
          <span class="p2p-offer-label">Wants</span>
          <strong class="p2p-offer-value">${toLogo ? `<img src="${escHtml(toLogo)}" alt="" style="width:18px;height:18px;vertical-align:middle;margin-right:0.3rem;" />` : ''}${formatCoinAmount(offer.to_amount)} ${escHtml(toCoin)}</strong>
        </div>
        <div class="p2p-offer-stat p2p-offer-action-block">
          <span class="p2p-offer-subtle">Rate: 1 ${escHtml(fromCoin)} = ${formatCoinAmount(rate)} ${escHtml(toCoin)}</span>
          <span class="p2p-offer-subtle">You'd pay ${formatCoinAmount(offer.to_amount)} ${escHtml(toCoin)}, receive ${formatCoinAmount(youReceive)} ${escHtml(fromCoin)} after ${Number(offer.fee_pct || 0)}% fee</span>
          <button class="p2p-card-action btn-accept-swap" data-id="${escHtml(offer.id)}">Accept</button>
        </div>
      </div>
    </article>
  `
}

async function handleAccept(id) {
  const ok = await showConfirm('Accept this swap? Both sides transfer immediately on your internal ledger and cannot be undone.')
  if (!ok) return
  try {
    await acceptSwapOffer(id)
    await loadSwaps()
    void refreshNavCombinedBalance()
  } catch (e) {
    await showAlert(`Accept failed: ${e.message}`)
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
            <label for="swap-from-coin">You give</label>
            <div style="display:flex;gap:0.5rem;">
              <input id="swap-from-amount" type="number" min="0" step="any" placeholder="e.g. 99" class="form-input" style="flex:2;" />
              <select id="swap-from-coin" class="form-input" style="flex:1;">${COINS.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
            </div>
          </div>
          <div class="field-row">
            <label for="swap-to-coin">You want</label>
            <div style="display:flex;gap:0.5rem;">
              <input id="swap-to-amount" type="number" min="0" step="any" placeholder="e.g. 100" class="form-input" style="flex:2;" />
              <select id="swap-to-coin" class="form-input" style="flex:1;">${COINS.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
            </div>
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

  const updatePreview = () => {
    const fromAmount = Number.parseFloat(document.getElementById('swap-from-amount').value)
    const fromCoin = document.getElementById('swap-from-coin').value
    const preview = document.getElementById('swap-preview')
    if (!Number.isFinite(fromAmount) || fromAmount <= 0) { preview.textContent = ''; return }
    const afterFee = fromAmount * (1 - SWAP_FEE_PCT / 100)
    preview.textContent = `The taker receives ${formatCoinAmount(afterFee)} ${fromCoin} after the ${SWAP_FEE_PCT}% platform fee. You'll receive your requested amount minus the same fee once someone accepts.`
  }
  document.getElementById('swap-from-amount').oninput = updatePreview
  document.getElementById('swap-from-coin').onchange = updatePreview
}

function openCreateSwapModal() {
  ensureCreateSwapModal()
  const modal = document.getElementById('create-swap-modal')
  document.getElementById('swap-from-amount').value = ''
  document.getElementById('swap-to-amount').value = ''
  document.getElementById('create-swap-error').textContent = ''
  document.getElementById('swap-preview').textContent = ''
  modal.classList.remove('hidden')

  const btn = document.getElementById('btn-submit-swap')
  const handler = async () => {
    const errEl = document.getElementById('create-swap-error')
    errEl.textContent = ''
    const from_coin = document.getElementById('swap-from-coin').value
    const to_coin = document.getElementById('swap-to-coin').value
    const from_amount = Number.parseFloat(document.getElementById('swap-from-amount').value)
    const to_amount = Number.parseFloat(document.getElementById('swap-to-amount').value)

    if (from_coin === to_coin) { errEl.textContent = 'Choose two different coins.'; return }
    if (!Number.isFinite(from_amount) || from_amount <= 0) { errEl.textContent = 'Enter a valid amount to give.'; return }
    if (!Number.isFinite(to_amount) || to_amount <= 0) { errEl.textContent = 'Enter a valid amount you want.'; return }

    btn.disabled = true
    try {
      await createSwapOffer({ from_coin, to_coin, from_amount, to_amount })
      modal.classList.add('hidden')
      await loadSwaps()
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
