import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, updateMyProfile, resolveRecipient, getUserProfile } from '../api.js'
import { showConfirm } from '../modal.js'
import { avatarPathFromProfile, avatarPathFromNumber } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

let currentProfile = null
let currentUser = null

onAuthChange(async (user) => {
  if (!user) {
    window.location.href = '/'
    return
  }

  currentUser = user
  try {
    currentProfile = await upsertUser()
  } catch {
    currentProfile = { email: user.email }
  }

  renderNav(user, currentProfile)
  bindActions()
  await renderLists()
})

function renderNav(user, profile) {
  const navAuth = document.getElementById('nav-auth')
  const label = profile?.username ? `@${profile.username}` : user.email
  const photo = avatarPathFromProfile(profile)

  navAuth.innerHTML = `
    <span id="nav-available-balance" class="nav-balance-sm" title="Available balance">Bal: --</span>
    <a href="/settings.html" class="nav-profile-link">
      <img src="${photo}" alt="avatar" class="nav-avatar-sm" onerror="this.src='/avatars/1.png'" />
      <span class="nav-username-sm">${label}</span>
    </a>
    <button id="btn-logout" class="btn-sm">Log out</button>
  `

  document.getElementById('btn-logout').addEventListener('click', () => logOut())
  setupUnreadTradeNotifications({ user, navAuth })
  ensureDevBalanceTools()
  void refreshNavCombinedBalance()
}

async function resolvePartnerUid(inputValue) {
  const value = String(inputValue || '').trim().replace(/^@/, '')
  if (!value) throw new Error('Please enter a username or UID.')

  try {
    const resolved = await resolveRecipient(value, '')
    if (resolved?.is_platform_user && resolved?.uid) return resolved
  } catch {
    // fallback to raw value if it's already a uid
  }

  return { uid: value, username: value }
}

function bindActions() {
  if (document.body.dataset.tradePartnersBound === '1') return
  document.body.dataset.tradePartnersBound = '1'

  document.getElementById('btn-trust-user').addEventListener('click', addTrustedPartner)
  document.getElementById('btn-block-user').addEventListener('click', addBlockedPartner)
}

async function addTrustedPartner() {
  const input = document.getElementById('input-trust-user')
  const errEl = document.getElementById('trust-error')
  errEl.textContent = ''

  try {
    const resolved = await resolvePartnerUid(input.value)
    if (resolved.uid === currentUser?.uid) {
      errEl.textContent = 'You cannot add yourself as a trusted partner.'
      return
    }

    const trusted = Array.isArray(currentProfile?.trusted_users) ? currentProfile.trusted_users : []
    if (trusted.includes(resolved.uid)) {
      errEl.textContent = 'That user is already a trusted partner.'
      return
    }

    const blocked = Array.isArray(currentProfile?.blocked_users) ? currentProfile.blocked_users : []
    const cleanedBlocked = blocked.filter((u) => u !== resolved.uid)

    const updated = await updateMyProfile({
      trusted_users: [...trusted, resolved.uid],
      blocked_users: cleanedBlocked,
    })

    currentProfile = updated
    input.value = ''
    await renderLists()
    showToast(`@${resolved.username || resolved.uid} added as trusted partner.`)
  } catch (e) {
    errEl.textContent = e.message || 'Failed to add trusted partner.'
  }
}

async function addBlockedPartner() {
  const input = document.getElementById('input-block-user')
  const errEl = document.getElementById('block-error')
  errEl.textContent = ''

  try {
    const resolved = await resolvePartnerUid(input.value)
    if (resolved.uid === currentUser?.uid) {
      errEl.textContent = 'You cannot block yourself.'
      return
    }

    const blocked = Array.isArray(currentProfile?.blocked_users) ? currentProfile.blocked_users : []
    if (blocked.includes(resolved.uid)) {
      errEl.textContent = 'That user is already blocked.'
      return
    }

    const trusted = Array.isArray(currentProfile?.trusted_users) ? currentProfile.trusted_users : []
    const cleanedTrusted = trusted.filter((u) => u !== resolved.uid)

    const updated = await updateMyProfile({
      blocked_users: [...blocked, resolved.uid],
      trusted_users: cleanedTrusted,
    })

    currentProfile = updated
    input.value = ''
    await renderLists()
    showToast(`@${resolved.username || resolved.uid} blocked.`)
  } catch (e) {
    errEl.textContent = e.message || 'Failed to block partner.'
  }
}

async function renderLists() {
  await Promise.all([renderTrustedList(), renderBlockedList()])
}

async function renderTrustedList() {
  const list = document.getElementById('trusted-list')
  const trusted = Array.isArray(currentProfile?.trusted_users) ? currentProfile.trusted_users : []

  if (!trusted.length) {
    list.innerHTML = '<p class="muted user-list-empty">No trusted partners yet.</p>'
    return
  }

  list.innerHTML = '<p class="muted user-list-empty">Loading…</p>'

  const profiles = await Promise.all(
    trusted.map((uid) =>
      getUserProfile(uid).catch(() => ({ uid, username: uid.slice(0, 8) + '…', avatar_number: 1 }))
    )
  )

  list.innerHTML = profiles
    .map(
      (p) => `
      <div class="user-list-item">
        <img src="${avatarPathFromNumber(p.avatar_number)}" alt="" class="user-list-avatar-img" onerror="this.src='/avatars/1.png'" />
        <span class="user-list-name">@${p.username}</span>
        <span class="user-list-tag tag-trusted">Trusted</span>
        <button class="btn-sm" data-untrust="${p.uid}">Remove</button>
      </div>
    `
    )
    .join('')

  list.querySelectorAll('[data-untrust]').forEach((btn) => {
    btn.addEventListener('click', () => untrustUser(btn.dataset.untrust))
  })
}

function renderBlockedList() {
  const list = document.getElementById('blocked-list')
  const blocked = Array.isArray(currentProfile?.blocked_users) ? currentProfile.blocked_users : []

  if (!blocked.length) {
    list.innerHTML = '<p class="muted user-list-empty">No blocked partners.</p>'
    return
  }

  list.innerHTML = blocked
    .map(
      (uid) => `
      <div class="user-list-item">
        <div class="user-list-avatar">${uid.charAt(0).toUpperCase()}</div>
        <span class="user-list-uid">${uid}</span>
        <span class="user-list-tag tag-blocked">Blocked</span>
        <button class="btn-sm btn-danger-sm" data-unblock="${uid}">Unblock</button>
      </div>
    `
    )
    .join('')

  list.querySelectorAll('[data-unblock]').forEach((btn) => {
    btn.addEventListener('click', () => unblockUser(btn.dataset.unblock))
  })
}

async function untrustUser(uid) {
  const confirmed = await showConfirm('Remove this trusted partner?')
  if (!confirmed) return

  const trusted = Array.isArray(currentProfile?.trusted_users) ? currentProfile.trusted_users : []
  try {
    const updated = await updateMyProfile({ trusted_users: trusted.filter((u) => u !== uid) })
    currentProfile = updated
    await renderTrustedList()
    showToast('Partner removed.')
  } catch (e) {
    showToast('Failed: ' + (e.message || e), 'error')
  }
}

async function unblockUser(uid) {
  const blocked = Array.isArray(currentProfile?.blocked_users) ? currentProfile.blocked_users : []
  try {
    const updated = await updateMyProfile({ blocked_users: blocked.filter((u) => u !== uid) })
    currentProfile = updated
    renderBlockedList()
    showToast('Partner unblocked.')
  } catch (e) {
    showToast('Failed: ' + (e.message || e), 'error')
  }
}

function showToast(msg) {
  const c = document.getElementById('toast-container')
  if (!c) return
  const t = document.createElement('div')
  t.className = 'toast toast-success'
  t.textContent = msg
  c.appendChild(t)
  setTimeout(() => t.remove(), 3000)
}
