// trusted-page.js — Trusted Partners management page
import { initializeApp } from 'firebase/app'
import { firebaseConfig }  from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, updateMyProfile, resolveRecipient, getUserProfile } from '../api.js'
import { showConfirm } from '../modal.js'
import { avatarPathFromNumber } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

let currentProfile = null
let currentUser    = null

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }
  currentUser = user

  try {
    currentProfile = await upsertUser()
  } catch {
    currentProfile = { email: user.email }
  }

  renderNav(user, currentProfile)
  await renderTrustedList()
  bindActions()
})

function renderNav(user, profile) {
  const navAuth = document.getElementById('nav-auth')
  const label   = profile?.username ? `@${profile.username}` : user.email
  const photo   = avatarPathFromProfile(profile)
  navAuth.innerHTML = `
    <span id="nav-available-balance" class="nav-balance-sm" title="Available balance">Bal: --</span>
    <a href="/settings.html" class="nav-profile-link">
      <img src="${photo}" alt="avatar" class="nav-avatar-sm"
           onerror="this.src='/avatars/1.png'" />
      <span class="nav-username-sm">${label}</span>
    </a>
    <button id="btn-logout" class="btn-sm">Log out</button>
  `
  document.getElementById('btn-logout').addEventListener('click', () => logOut())
  setupUnreadTradeNotifications({ user, navAuth })
  ensureDevBalanceTools()
  void refreshNavCombinedBalance()
}

async function renderTrustedList() {
  const list    = document.getElementById('trusted-list')
  const trusted = Array.isArray(currentProfile?.trusted_users) ? currentProfile.trusted_users : []

  if (!trusted.length) {
    list.innerHTML = '<p class="muted user-list-empty">No trusted partners yet.</p>'
    return
  }

  list.innerHTML = '<p class="muted user-list-empty">Loading…</p>'

  const profiles = await Promise.all(trusted.map(uid =>
    getUserProfile(uid).catch(() => ({ uid, username: uid.slice(0, 8) + '…', avatar_number: 1 }))
  ))

  list.innerHTML = profiles.map(p => `
    <div class="user-list-item">
      <img src="${avatarPathFromNumber(p.avatar_number)}" alt="" class="user-list-avatar-img"
           onerror="this.src='/avatars/1.png'" />
      <span class="user-list-name">@${p.username}</span>
      <span class="user-list-tag tag-trusted">Trusted</span>
      <button class="btn-sm" data-untrust="${p.uid}">Remove</button>
    </div>
  `).join('')

  list.querySelectorAll('[data-untrust]').forEach(btn => {
    btn.addEventListener('click', () => untrustUser(btn.dataset.untrust))
  })
}

function bindActions() {
  document.getElementById('btn-trust-user').addEventListener('click', async () => {
    const input = document.getElementById('input-trust-user')
    const errEl = document.getElementById('trust-error')
    errEl.textContent = ''
    const val = input.value.trim().replace(/^@/, '')
    if (!val) { errEl.textContent = 'Please enter a username or UID.'; return }

    if (val.toLowerCase() === currentProfile?.username?.toLowerCase()) {
      errEl.textContent = 'You cannot add yourself as a trusted partner.'
      return
    }

    const current = Array.isArray(currentProfile?.trusted_users) ? currentProfile.trusted_users : []
    if (current.includes(val)) { errEl.textContent = 'That user is already a trusted partner.'; return }

    let resolved
    try {
      resolved = await resolveRecipient(val, '')
    } catch {
      errEl.textContent = `Username '${val}' doesn't exist.`
      return
    }

    if (!resolved.is_platform_user || !resolved.uid) {
      errEl.textContent = `Username '${val}' doesn't exist.`
      return
    }

    if (resolved.uid === currentUser?.uid) {
      errEl.textContent = 'You cannot add yourself as a trusted partner.'
      return
    }

    if (resolved.blocked_you) {
      errEl.textContent = `@${val} has blocked you.`
      return
    }

    try {
      const updated = await updateMyProfile({ trusted_users: [...current, resolved.uid] })
      currentProfile = updated
      input.value = ''
      await renderTrustedList()
      showToast(`@${resolved.username ?? val} added as trusted partner.`)
    } catch (e) {
      errEl.textContent = 'Failed: ' + e.message
    }
  })
}

async function untrustUser(uid) {
  const confirmed = await showConfirm('Are you sure you want to remove this trusted partner?')
  if (!confirmed) return
  const current = Array.isArray(currentProfile?.trusted_users) ? currentProfile.trusted_users : []
  try {
    const updated = await updateMyProfile({ trusted_users: current.filter(u => u !== uid) })
    currentProfile = updated
    await renderTrustedList()
    showToast('Partner removed.')
  } catch (e) {
    showToast('Failed: ' + e.message, 'error')
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
