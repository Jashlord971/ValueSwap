
import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, listMySwapOffers, cancelSwapOffer, getUserProfile } from '../api.js'
import { showAlert, showConfirm } from '../modal.js'
import { avatarPathFromProfile } from '../avatar.js'
import { COIN_LOGOS } from '../coin-logos.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

let currentUser = null
const profileCache = new Map()

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
  const uids = [...new Set(offers.flatMap((o) => [o.creator_uid, o.taker_uid]).filter(Boolean))]
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
}

function buildMySwapCard(offer) {
  const isCreator = offer.creator_uid === currentUser.uid
  const roleLabel = isCreator ? 'You posted this' : 'You took this'
  const fromCoin = String(offer.from_coin || '').toUpperCase()
  const toCoin = String(offer.to_coin || '').toUpperCase()
  const fromLogo = COIN_LOGOS[fromCoin]
  const toLogo = COIN_LOGOS[toCoin]
  const status = String(offer.status || '').toLowerCase()
  const statusClass = `status-${status}`
  const counterpartyUid = isCreator ? offer.taker_uid : offer.creator_uid
  const counterpartyProfile = counterpartyUid ? profileCache.get(counterpartyUid) : null
  const counterpartyName = counterpartyProfile?.username || (counterpartyUid ? `${counterpartyUid.slice(0, 8)}…` : '—')
  const when = offer.created_at ? new Date(Number(offer.created_at) * 1000).toLocaleString() : '—'
  const feePct = Number(offer.fee_pct || 0)
  const youReceive = isCreator
    ? Number(offer.to_amount) * (1 - feePct / 100)
    : Number(offer.from_amount) * (1 - feePct / 100)

  return `
    <div class="trade-card" data-id="${escHtml(offer.id)}">
      <div class="trade-card-header">
        <div class="trade-partner">
          <div>
            <span class="trade-partner-label">${escHtml(roleLabel)}</span>
            <span class="trade-partner-id">${status === 'open' ? 'Waiting for a taker' : `vs ${escHtml(counterpartyName)}`}</span>
          </div>
        </div>
        <span class="trade-status-badge ${statusClass}">${escHtml(offer.status)}</span>
      </div>
      <div class="trade-card-body">
        <div class="trade-detail-row">
          <span class="trade-detail-label">Gave</span>
          <span class="trade-detail-value">${fromLogo ? `<img src="${escHtml(fromLogo)}" alt="" style="width:16px;height:16px;vertical-align:middle;margin-right:0.3rem;" />` : ''}${formatCoinAmount(offer.from_amount)} ${escHtml(fromCoin)}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">${isCreator ? 'Wanted' : 'Paid'}</span>
          <span class="trade-detail-value">${toLogo ? `<img src="${escHtml(toLogo)}" alt="" style="width:16px;height:16px;vertical-align:middle;margin-right:0.3rem;" />` : ''}${formatCoinAmount(offer.to_amount)} ${escHtml(toCoin)}</span>
        </div>
        ${status === 'filled' ? `
        <div class="trade-detail-row">
          <span class="trade-detail-label">You received</span>
          <span class="trade-detail-value">${formatCoinAmount(youReceive)} ${escHtml(isCreator ? toCoin : fromCoin)} (after ${feePct}% fee)</span>
        </div>` : ''}
        <div class="trade-detail-row">
          <span class="trade-detail-label">Posted</span>
          <span class="trade-detail-value">${escHtml(when)}</span>
        </div>
      </div>
      ${isCreator && status === 'open' ? `
      <div class="trade-card-actions">
        <button class="btn-sm btn-danger btn-cancel-swap" data-id="${escHtml(offer.id)}">Cancel Offer</button>
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
