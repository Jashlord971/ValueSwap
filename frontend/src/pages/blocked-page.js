
import { initializeApp } from 'firebase/app'
import { firebaseConfig }  from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, updateMyProfile } from '../api.js'
import { initChat } from '../chat.js'
import { avatarPathFromProfile } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)
initChat(firebaseApp)

let currentProfile = null

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }

  try {
    currentProfile = await upsertUser()
  } catch {
    currentProfile = { email: user.email }
  }

  renderNav(user, currentProfile)
  renderBlockedList()
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

function renderBlockedList() {
  const list    = document.getElementById('blocked-list')
  const blocked = Array.isArray(currentProfile?.blocked_users) ? currentProfile.blocked_users : []

  if (!blocked.length) {
    list.innerHTML = '<p class="muted user-list-empty">No users blocked.</p>'
    return
  }

  list.innerHTML = blocked.map(uid => `
    <div class="user-list-item">
      <div class="user-list-avatar">${uid.charAt(0).toUpperCase()}</div>
      <span class="user-list-uid">${uid}</span>
      <span class="user-list-tag tag-blocked">Blocked</span>
      <button class="btn-sm btn-danger-sm" data-unblock="${uid}">Unblock</button>
    </div>
  `).join('')

  list.querySelectorAll('[data-unblock]').forEach(btn => {
    btn.addEventListener('click', () => unblockUser(btn.dataset.unblock))
  })
}

function bindActions() {
  document.getElementById('btn-block-user').addEventListener('click', async () => {
    const input   = document.getElementById('input-block-user')
    const errEl   = document.getElementById('block-error')
    errEl.textContent = ''
    const val = input.value.trim().replace(/^@/, '')
    if (!val) { errEl.textContent = 'Please enter a username or UID.'; return }

    const current = Array.isArray(currentProfile?.blocked_users) ? currentProfile.blocked_users : []
    if (current.includes(val)) { errEl.textContent = 'That user is already blocked.'; return }

    try {
      const updated = await updateMyProfile({ blocked_users: [...current, val] })
      currentProfile = updated
      input.value = ''
      renderBlockedList()
      showToast(`@${val} blocked.`)
    } catch (e) {
      errEl.textContent = 'Failed: ' + e.message
    }
  })
}

async function unblockUser(uid) {
  const current = Array.isArray(currentProfile?.blocked_users) ? currentProfile.blocked_users : []
  try {
    const updated = await updateMyProfile({ blocked_users: current.filter(u => u !== uid) })
    currentProfile = updated
    renderBlockedList()
    showToast(`Unblocked.`)
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
