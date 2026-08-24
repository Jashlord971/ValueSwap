
import { initializeApp }         from 'firebase/app'
import { firebaseConfig }        from './firebase-config.js'
import { initAuth, onAuthChange, signInWithGoogle, logOut } from './auth.js'
import { initChat }              from './chat.js'
import { upsertUser, updateMyProfile } from './api.js'
import { avatarPathFromProfile } from './avatar.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from './dev-balance-tools.js'

let _app = null

export function getFirebaseApp() {
  if (!_app) _app = initializeApp(firebaseConfig)
  return _app
}

let _currentProfile = null
export function getCurrentProfile() { return _currentProfile }

export function initShared(onUser, { requireAuth = true } = {}) {
  const app = getFirebaseApp()
  initAuth(app)
  initChat(app)

  onAuthChange(async (user) => {
    if (user) {
      try {
        _currentProfile = await upsertUser()
      } catch {
        _currentProfile = { email: user.email }
      }
      renderNavAuth(user, _currentProfile)
      onUser(user, _currentProfile)
    } else {
      _currentProfile = null
      renderNavAuth(null, null)
      if (requireAuth) {
        window.location.href = '/'
      }
    }
  })
}

function renderNavAuth(user, profile) {
  const el = document.getElementById('nav-auth')
  if (!el) return
  if (!user) {
    el.innerHTML = ''
    return
  }
  const label   = profile?.username ? `@${profile.username}` : user.email
  const photo   = avatarPathFromProfile(profile)
  const initial = (profile?.first_name || profile?.username || label || '?').charAt(0).toUpperCase()
  el.innerHTML = `
    <span id="nav-available-balance" class="nav-balance-sm" title="Available balance">Bal: --</span>
    <a href="/settings.html" class="nav-profile-link" title="Account Settings">
      <span class="nav-avatar-sm">${photo ? `<img src="${photo}" alt="" />` : initial}</span>
      <span class="nav-username-sm">${label}</span>
    </a>
    <button id="btn-logout" class="btn-sm">Sign Out</button>
  `
  el.querySelector('#btn-logout').addEventListener('click', () => logOut())
  ensureDevBalanceTools()
  void refreshNavCombinedBalance()
}

function showProfileModal(profile) {
  document.getElementById('profile-modal-overlay')?.remove()

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.id = 'profile-modal-overlay'
  overlay.innerHTML = `
    <div class="modal profile-modal">
      <div class="modal-header">
        <h2>Your Profile</h2>
        <button class="btn-modal-close">✕</button>
      </div>
      <div class="profile-field">
        <label class="form-label">Username</label>
        <div class="profile-username-row">
          <span id="profile-username-display">@${profile?.username || '—'}</span>
          <button id="btn-edit-username" class="btn-sm">Edit</button>
        </div>
        <div id="profile-edit-section" style="display:none;margin-top:0.5rem">
          <input id="profile-username-input" class="form-input" type="text"
            value="${profile?.username || ''}"
            placeholder="e.g. CoolOtter123" maxlength="30" />
          <p class="muted" style="font-size:0.75rem;margin:0.25rem 0">3–30 letters and digits only</p>
          <div id="profile-username-error" class="error" style="display:none;margin-top:0.25rem"></div>
          <div style="margin-top:0.5rem">
            <button id="btn-save-username" class="btn-primary">Save</button>
            <button id="btn-cancel-username" class="btn-sm" style="margin-left:0.5rem">Cancel</button>
          </div>
        </div>
      </div>
      <div class="profile-field" style="margin-top:1rem">
        <label class="form-label">Email</label>
        <span class="muted">${profile?.email || '—'}</span>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  overlay.querySelector('.btn-modal-close').addEventListener('click', () => overlay.remove())

  overlay.querySelector('#btn-edit-username').addEventListener('click', () => {
    overlay.querySelector('#profile-edit-section').style.display = ''
    overlay.querySelector('#btn-edit-username').style.display = 'none'
  })
  overlay.querySelector('#btn-cancel-username').addEventListener('click', () => {
    overlay.querySelector('#profile-edit-section').style.display = 'none'
    overlay.querySelector('#btn-edit-username').style.display = ''
    overlay.querySelector('#profile-username-error').style.display = 'none'
  })
  overlay.querySelector('#btn-save-username').addEventListener('click', async () => {
    const newUsername = overlay.querySelector('#profile-username-input').value.trim()
    const errEl = overlay.querySelector('#profile-username-error')
    const btn   = overlay.querySelector('#btn-save-username')
    errEl.style.display = 'none'

    if (!/^[a-zA-Z0-9]{3,30}$/.test(newUsername)) {
      errEl.textContent = 'Username must be 3–30 letters and digits only.'
      errEl.style.display = 'block'
      return
    }
    btn.disabled = true; btn.textContent = 'Saving…'
    try {
      const updated = await updateMyProfile(newUsername)
      _currentProfile = updated
      overlay.querySelector('#profile-username-display').textContent = `@${updated.username}`
      overlay.querySelector('#profile-edit-section').style.display = 'none'
      overlay.querySelector('#btn-edit-username').style.display = ''
      const navBtn = document.getElementById('btn-profile')
      if (navBtn) navBtn.textContent = `@${updated.username}`
    } catch (e) {
      errEl.textContent = e.message
      errEl.style.display = 'block'
    } finally {
      btn.disabled = false; btn.textContent = 'Save'
    }
  })
}
