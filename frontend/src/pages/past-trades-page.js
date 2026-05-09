// past-trades-page.js — entry point for past-trades.html
import { initializeApp } from 'firebase/app'
import { firebaseConfig }  from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, listTrades } from '../api.js'
import { cacheGet, cacheInvalidate } from '../cache.js'
import { avatarPathFromProfile, avatarPathFromNumber } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

cacheInvalidate('trades')

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

let currentUser = null

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

  await loadPastTrades()
})

async function loadPastTrades() {
  const grid = document.getElementById('past-trades-list')

  const cached = cacheGet('trades')
  if (cached) {
    const past = cached.filter(t => ['completed','cancelled','expired'].includes(t.status))
    renderPastTrades(grid, past)
  }

  try {
    const all  = await listTrades()
    const past = all.filter(t => ['completed','cancelled','expired'].includes(t.status))
    renderPastTrades(grid, past)
  } catch (e) {
    if (!cached) grid.innerHTML = `<p class="error">Failed to load past trades: ${e.message}</p>`
  }
}

function renderPastTrades(grid, trades) {
  if (!trades.length) {
    grid.innerHTML = '<p class="muted">No past trades yet.</p>'
    return
  }
  grid.innerHTML = trades.map(t => buildPastTradeCard(t)).join('')
  grid.querySelectorAll('.btn-open-past-trade').forEach(btn => {
    btn.addEventListener('click', () => {
      window.location.href = `/trade-detail.html?id=${btn.dataset.id}`
    })
  })
}

function buildPastTradeCard(t) {
  const isCreator      = currentUser && t.creator_uid === currentUser.uid
  const partnerUid     = isCreator ? t.offer_owner_uid : t.creator_uid
  const partnerName    = isCreator ? (t.offer_owner_username || null) : (t.creator_username || null)
  const partnerAvatarNumber = isCreator ? t.offer_owner_avatar_number : t.creator_avatar_number
  const partnerAvatarPath = avatarPathFromNumber(partnerAvatarNumber)
  const partnerDisplay = partnerName || (partnerUid ? partnerUid.slice(0, 8) + '…' : '—')

  const currency  = t.currency || ''
  const coin      = t.coin || ''
  const fiatAmt   = t.fiat_amount != null ? `${currency} ${Number(t.fiat_amount).toFixed(2)}` : '—'
  const cryptoAmt = t.crypto_amount != null ? `${Number(t.crypto_amount).toFixed(6)} ${coin}` : '—'
  const date      = t.created_at ? new Date(t.created_at * 1000).toLocaleDateString() : '—'

  return `
    <div class="trade-card trade-card-past" data-id="${escHtml(t.id)}">
      <div class="trade-card-header">
        <div class="trade-partner">
          <span class="trade-partner-avatar"><img src="${escHtml(partnerAvatarPath)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" /></span>
          <div>
            <span class="trade-partner-label">Partner</span>
            <span class="trade-partner-id">${escHtml(partnerDisplay)}</span>
          </div>
        </div>
        <span class="trade-status-badge status-${escHtml(t.status)}">${escHtml(t.status)}</span>
      </div>
      <div class="trade-card-body">
        <div class="trade-detail-row">
          <span class="trade-detail-label">Payment Method</span>
          <span class="trade-detail-value">${escHtml(t.card || '—')}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">Fiat</span>
          <span class="trade-detail-value trade-fiat">${fiatAmt}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">Crypto</span>
          <span class="trade-detail-value trade-crypto">${cryptoAmt}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">Date</span>
          <span class="trade-detail-value">${date}</span>
        </div>
      </div>
      <div class="trade-card-actions">
        <button class="btn-sm btn-success btn-open-past-trade" data-id="${escHtml(t.id)}">View Trade</button>
      </div>
    </div>
  `
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
