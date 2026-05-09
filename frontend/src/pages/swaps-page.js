// swaps-page.js — entry point for swaps.html
import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser } from '../api.js'
import { initChat } from '../chat.js'
import { initSwapOffers } from '../trades.js'
import { avatarPathFromProfile } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)
initChat(firebaseApp)

let currentUserProfile = null

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }

  try {
    currentUserProfile = await upsertUser()
  } catch {
    currentUserProfile = { email: user.email }
  }

  renderNav(user, currentUserProfile)
  initSwapOffers(user)

  if (window.location.hash === '#mine') {
    const section = document.getElementById('my-swap-offers-section')
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
})

function renderNav(user, profile) {
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
}