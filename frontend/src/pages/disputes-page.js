
import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, listDisputes, listPaymentMethods } from '../api.js'
import { avatarPathFromProfile, avatarPathFromNumber } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

let paymentMethodNameMap = null

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

  await loadDisputes()
})

async function ensurePaymentMethodNameMap() {
  if (paymentMethodNameMap) return paymentMethodNameMap
  try {
    const methods = await listPaymentMethods()
    paymentMethodNameMap = new Map(
      (methods || []).map((method) => [String(method.id || '').toLowerCase(), method.name || method.id || ''])
    )
  } catch {
    paymentMethodNameMap = new Map()
  }
  return paymentMethodNameMap
}

function paymentMethodDisplayName(raw) {
  const id = String(raw || '').trim()
  if (!id) return '—'
  return paymentMethodNameMap?.get(id.toLowerCase()) || id
}

async function loadDisputes() {
  const grid = document.getElementById('disputes-list')
  await ensurePaymentMethodNameMap()

  try {
    const disputes = await listDisputes()
    renderDisputes(grid, disputes)
  } catch (e) {
    const isForbidden = /forbidden|403/i.test(String(e?.message || ''))
    grid.innerHTML = isForbidden
      ? '<p class="error">You do not have moderator access.</p>'
      : `<p class="error">Failed to load disputes: ${escHtml(e.message)}</p>`
  }
}

function renderDisputes(grid, disputes) {
  if (!disputes.length) {
    grid.innerHTML = '<p class="muted">No live disputes right now.</p>'
    return
  }

  grid.innerHTML = disputes.map(buildDisputeCard).join('')
  grid.querySelectorAll('.btn-open-dispute').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.location.href = `/trade-detail.html?id=${encodeURIComponent(btn.dataset.id)}`
    })
  })
}

function buildDisputeCard(t) {
  const offerOwnerName = t.offer_owner_username || (t.offer_owner_uid ? `${t.offer_owner_uid.slice(0, 8)}…` : '—')
  const takerName = t.creator_username || (t.creator_uid ? `${t.creator_uid.slice(0, 8)}…` : '—')
  const offerOwnerAvatar = avatarPathFromNumber(t.offer_owner_avatar_number)
  const takerAvatar = avatarPathFromNumber(t.creator_avatar_number)

  const currency = t.currency || ''
  const coin = t.coin || ''
  const fiatAmt = t.fiat_amount != null ? `${currency} ${Number(t.fiat_amount).toFixed(2)}` : '—'
  const cryptoAmt = t.crypto_amount != null ? `${Number(t.crypto_amount).toFixed(6)} ${coin}` : '—'
  const raisedAt = t.dispute_raised_at ? new Date(Number(t.dispute_raised_at) * 1000).toLocaleString() : '—'
  const raisedByOfferOwner = t.dispute_raised_by_uid && t.dispute_raised_by_uid === t.offer_owner_uid
  const raisedByLabel = t.dispute_raised_by_uid
    ? (raisedByOfferOwner ? offerOwnerName : takerName)
    : '—'

  return `
    <div class="trade-card" data-id="${escHtml(t.id)}">
      <div class="trade-card-header">
        <div class="trade-partner">
          <span class="trade-partner-avatar"><img src="${escHtml(offerOwnerAvatar)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" /></span>
          <div>
            <span class="trade-partner-label">Offer Owner</span>
            <span class="trade-partner-id">${escHtml(offerOwnerName)}</span>
          </div>
        </div>
        <span class="trade-status-badge status-disputed">Disputed</span>
      </div>

      <div class="trade-card-body">
        <div class="trade-detail-row">
          <span class="trade-detail-label">Taker</span>
          <span class="trade-detail-value">
            <img src="${escHtml(takerAvatar)}" alt="" style="width:20px;height:20px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:0.35rem;" />${escHtml(takerName)}
          </span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">Payment Method</span>
          <span class="trade-detail-value">${escHtml(paymentMethodDisplayName(t.card))}</span>
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
          <span class="trade-detail-label">Raised By</span>
          <span class="trade-detail-value">${escHtml(raisedByLabel)}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">Raised At</span>
          <span class="trade-detail-value">${escHtml(raisedAt)}</span>
        </div>
        ${t.dispute_reason_category ? `
        <div class="trade-detail-row" style="align-items:flex-start;">
          <span class="trade-detail-label">Reason</span>
          <span class="trade-detail-value" style="text-align:right;max-width:70%;">${escHtml(t.dispute_reason_category)}</span>
        </div>` : ''}
        ${t.dispute_reason_text ? `
        <div class="trade-detail-row" style="align-items:flex-start;">
          <span class="trade-detail-label">Evidence</span>
          <span class="trade-detail-value" style="white-space:pre-wrap;text-align:right;max-width:70%;">${escHtml(t.dispute_reason_text)}</span>
        </div>` : ''}
      </div>

      <div class="trade-card-actions">
        <button class="btn-sm btn-success btn-open-dispute" data-id="${escHtml(t.id)}">Open Chat &amp; Resolve</button>
      </div>
    </div>
  `
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
