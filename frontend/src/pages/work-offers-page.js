import { initializeApp } from 'firebase/app'
import { firebaseConfig }  from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser } from '../api.js'
import { avatarPathFromProfile } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

const STORE_KEY = 'cardswap:work-offers'
let currentProfile = null

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }

  try {
    currentProfile = await upsertUser()
  } catch {
    currentProfile = { email: user.email }
  }

  renderNav(user, currentProfile)
  bindModal()
  renderWorkOffers()
})

function renderNav(user, profile) {
  const navAuth = document.getElementById('nav-auth')
  const label = profile?.username ? `@${profile.username}` : user.email
  const photo = avatarPathFromProfile(profile)
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

function bindModal() {
  const modal = document.getElementById('work-offer-modal')
  const openBtn = document.getElementById('btn-new-work-offer')
  const closeBtn = document.getElementById('close-work-offer-modal')
  const submitBtn = document.getElementById('btn-submit-work-offer')

  openBtn?.addEventListener('click', () => {
    resetForm()
    modal.classList.remove('hidden')
  })
  closeBtn?.addEventListener('click', () => modal.classList.add('hidden'))
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden')
  })

  submitBtn?.addEventListener('click', () => {
    const title = document.getElementById('work-title').value.trim()
    const category = document.getElementById('work-category').value.trim()
    const payCoin = document.getElementById('work-pay-coin').value
    const payAmount = Number(document.getElementById('work-pay-amount').value)
    const details = document.getElementById('work-details').value.trim()
    const err = document.getElementById('work-offer-error')

    err.textContent = ''
    if (!title) { err.textContent = 'Title is required.'; return }
    if (!category) { err.textContent = 'Category is required.'; return }
    if (!Number.isFinite(payAmount) || payAmount <= 0) { err.textContent = 'Enter a valid budget.'; return }

    const offers = loadStoredOffers()
    offers.unshift({
      id: crypto.randomUUID(),
      title,
      category,
      payCoin,
      payAmount,
      details,
      createdAt: Math.floor(Date.now() / 1000),
    })
    saveStoredOffers(offers)
    modal.classList.add('hidden')
    renderWorkOffers()
  })
}

function renderWorkOffers() {
  const list = document.getElementById('work-offers-list')
  const offers = loadStoredOffers()

  if (!offers.length) {
    list.innerHTML = '<p class="muted">No work offers yet. Click <strong>Add Work Offer</strong> to create one.</p>'
    return
  }

  list.innerHTML = offers.map((o) => `
    <div class="offer-card" style="margin-bottom:0.75rem;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem;">
        <div>
          <strong>${esc(o.title)}</strong>
          <div class="muted" style="font-size:0.82rem;">${esc(o.category)} • ${new Date(o.createdAt * 1000).toLocaleString()}</div>
          <div style="margin-top:0.35rem;">Budget: <strong>${Number(o.payAmount).toFixed(6)} ${esc(o.payCoin)}</strong></div>
          ${o.details ? `<p class="muted" style="margin-top:0.35rem;">${esc(o.details)}</p>` : ''}
        </div>
        <button class="btn-sm btn-danger" data-remove-work-offer="${esc(o.id)}">Delete</button>
      </div>
    </div>
  `).join('')

  list.querySelectorAll('[data-remove-work-offer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-remove-work-offer')
      const next = loadStoredOffers().filter((o) => o.id !== id)
      saveStoredOffers(next)
      renderWorkOffers()
    })
  })
}

function loadStoredOffers() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '[]')
  } catch {
    return []
  }
}

function saveStoredOffers(v) {
  localStorage.setItem(STORE_KEY, JSON.stringify(v))
}

function resetForm() {
  document.getElementById('work-title').value = ''
  document.getElementById('work-category').value = ''
  document.getElementById('work-pay-coin').value = 'BTC'
  document.getElementById('work-pay-amount').value = ''
  document.getElementById('work-details').value = ''
  document.getElementById('work-offer-error').textContent = ''
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;')
}
