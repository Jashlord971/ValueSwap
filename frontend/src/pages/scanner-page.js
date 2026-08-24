
import { initializeApp } from 'firebase/app'
import { firebaseConfig }  from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser } from '../api.js'
import { initChat } from '../chat.js'
import { initCards } from '../cards.js'
import { avatarPathFromProfile } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)
initChat(firebaseApp)

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }

  let profile = null
  try {
    profile = await upsertUser()
  } catch {
    profile = { email: user.email }
  }

  renderNav(user, profile)
  initCards()
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
