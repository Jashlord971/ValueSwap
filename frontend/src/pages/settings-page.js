
import { initializeApp } from 'firebase/app'
import { firebaseConfig }  from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, updateMyProfile, setWithdrawCode } from '../api.js'
import { initChat } from '../chat.js'
import { MIN_AVATAR_NUMBER, MAX_AVATAR_NUMBER, normalizeAvatarNumber, avatarPathFromNumber, avatarPathFromProfile } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)
initChat(firebaseApp)

let currentProfile = null
let pendingAvatarNumber = null

const DEFAULT_AVATAR_NUMBER = MIN_AVATAR_NUMBER
const AVATARS = Array.from({ length: MAX_AVATAR_NUMBER }, (_, idx) => idx + 1)

const COUNTRIES = [
  'Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda','Argentina',
  'Armenia','Australia','Austria','Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados',
  'Belarus','Belgium','Belize','Benin','Bhutan','Bolivia','Bosnia and Herzegovina',
  'Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cabo Verde','Cambodia',
  'Cameroon','Canada','Central African Republic','Chad','Chile','China','Colombia','Comoros',
  'Congo','Costa Rica','Croatia','Cuba','Cyprus','Czech Republic','Denmark','Djibouti',
  'Dominica','Dominican Republic','Ecuador','Egypt','El Salvador','Equatorial Guinea',
  'Eritrea','Estonia','Eswatini','Ethiopia','Fiji','Finland','France','Gabon','Gambia',
  'Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea','Guinea-Bissau',
  'Guyana','Haiti','Honduras','Hungary','Iceland','India','Indonesia','Iran','Iraq',
  'Ireland','Israel','Italy','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati',
  'Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya',
  'Liechtenstein','Lithuania','Luxembourg','Madagascar','Malawi','Malaysia','Maldives',
  'Mali','Malta','Marshall Islands','Mauritania','Mauritius','Mexico','Micronesia',
  'Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia',
  'Nauru','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria',
  'North Korea','North Macedonia','Norway','Oman','Pakistan','Palau','Panama',
  'Papua New Guinea','Paraguay','Peru','Philippines','Poland','Portugal','Qatar',
  'Romania','Russia','Rwanda','Saint Kitts and Nevis','Saint Lucia',
  'Saint Vincent and the Grenadines','Samoa','San Marino','Sao Tome and Principe',
  'Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia',
  'Slovenia','Solomon Islands','Somalia','South Africa','South Korea','South Sudan',
  'Spain','Sri Lanka','Sudan','Suriname','Sweden','Switzerland','Syria','Taiwan',
  'Tajikistan','Tanzania','Thailand','Timor-Leste','Togo','Tonga','Trinidad and Tobago',
  'Tunisia','Turkey','Turkmenistan','Tuvalu','Uganda','Ukraine','United Arab Emirates',
  'United Kingdom','United States','Uruguay','Uzbekistan','Vanuatu','Vatican City',
  'Venezuela','Vietnam','Yemen','Zambia','Zimbabwe',
]

function populateCountrySelect(selected) {
  const sel = document.getElementById('input-country')
  COUNTRIES.forEach(c => {
    const opt = document.createElement('option')
    opt.value = c
    opt.textContent = c
    if (c === selected) opt.selected = true
    sel.appendChild(opt)
  })
}

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }

  try { currentProfile = await upsertUser() } catch { currentProfile = { email: user.email } }

  const navAuth = document.getElementById('nav-auth')
  const label   = currentProfile?.username ? `@${currentProfile.username}` : user.email
  const photo   = avatarPathFromProfile(currentProfile)
  const initial = (currentProfile?.first_name || currentProfile?.username || label || '?').charAt(0).toUpperCase()
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

  populateCountrySelect(currentProfile?.country || '')
  renderViewMode()
  renderTradeSettings()
  bindForm()
  bindTradeSettings()
})

function renderViewMode() {
  const p = currentProfile || {}
  setText('view-first-name', p.first_name || '—')
  setText('view-last-name',  p.last_name  || '—')
  setText('view-username',   p.username   ? `@${p.username}` : '—')
  setText('view-email',      p.email      || '—')
  setText('view-country',    p.country    || '—')
  const avatarNumber = normalizeAvatarNumber(p.avatar_number, DEFAULT_AVATAR_NUMBER)
  renderAvatar('view-avatar-img', 'view-avatar-initials', avatarNumber, p.first_name, p.username)
}

function setText(id, val) {
  const el = document.getElementById(id)
  if (el) el.textContent = val
}

function setVal(id, val) {
  const el = document.getElementById(id)
  if (el) el.value = val
}

function showEditMode() {
  pendingAvatarNumber = null

  setVal('input-first-name', currentProfile?.first_name || '')
  setVal('input-last-name',  currentProfile?.last_name  || '')
  setVal('input-username',   currentProfile?.username   || '')
  const emailEl = document.getElementById('input-email')
  if (emailEl) emailEl.textContent = currentProfile?.email || '—'
  const countrySel = document.getElementById('input-country')
  if (countrySel) countrySel.value = currentProfile?.country || ''

  const p = currentProfile || {}
  const activeAvatarNumber = normalizeAvatarNumber(p.avatar_number, DEFAULT_AVATAR_NUMBER)
  renderAvatar('edit-avatar-img', 'edit-avatar-initials', activeAvatarNumber, p.first_name, p.username)
  renderAvatarGrid(activeAvatarNumber)
  const removeBtn = document.getElementById('btn-remove-photo')
  if (removeBtn) removeBtn.classList.add('hidden')

  document.getElementById('profile-view').classList.add('hidden')
  document.getElementById('profile-form').classList.remove('hidden')
  document.getElementById('btn-edit-profile').classList.add('hidden')
  document.getElementById('btn-cancel-profile').classList.remove('hidden')
  document.getElementById('profile-form-error').textContent = ''
  document.getElementById('photo-upload-error').textContent = ''
}

function showViewMode() {
  pendingAvatarNumber = null
  document.getElementById('profile-view').classList.remove('hidden')
  document.getElementById('profile-form').classList.add('hidden')
  document.getElementById('btn-edit-profile').classList.remove('hidden')
  document.getElementById('btn-cancel-profile').classList.add('hidden')
}

function bindForm() {
  document.getElementById('btn-edit-profile').addEventListener('click', showEditMode)
  document.getElementById('btn-cancel-profile').addEventListener('click', showViewMode)
  document.getElementById('profile-form').addEventListener('submit', (e) => {
    e.preventDefault()
    saveProfile()
  })
  document.getElementById('btn-signout-settings').addEventListener('click', () => logOut())

  const grid = document.getElementById('avatar-grid')
  if (grid) {
    grid.addEventListener('click', (e) => {
      const item = e.target.closest('.avatar-grid-item')
      if (!item) return
      const avatarNumber = normalizeAvatarNumber(item.dataset.avatarNumber, DEFAULT_AVATAR_NUMBER)
      pendingAvatarNumber = avatarNumber
      grid.querySelectorAll('.avatar-grid-item').forEach(el => el.classList.remove('selected'))
      item.classList.add('selected')
      renderAvatar('edit-avatar-img', 'edit-avatar-initials', avatarNumber, currentProfile?.first_name, currentProfile?.username)
    })
  }

  const removeBtn = document.getElementById('btn-remove-photo')
  if (removeBtn) removeBtn.classList.add('hidden')
}

async function saveProfile() {
  const errEl = document.getElementById('profile-form-error')
  const btn   = document.getElementById('btn-save-profile')
  errEl.textContent = ''

  const newUsername = document.getElementById('input-username').value.trim()
  const firstName   = document.getElementById('input-first-name').value.trim()
  const lastName    = document.getElementById('input-last-name').value.trim()
  const country     = document.getElementById('input-country').value

  if (newUsername && !/^[a-zA-Z0-9]{3,30}$/.test(newUsername)) {
    errEl.textContent = 'Username must be 3–30 letters and digits only.'
    return
  }

  const payload = {}
  if (newUsername !== (currentProfile?.username || ''))    payload.username   = newUsername || undefined
  if (firstName   !== (currentProfile?.first_name || '')) payload.first_name = firstName   || null
  if (lastName    !== (currentProfile?.last_name  || '')) payload.last_name  = lastName    || null
  if (country     !== (currentProfile?.country    || '')) payload.country    = country     || null

  if (pendingAvatarNumber !== null && pendingAvatarNumber !== currentProfile?.avatar_number) {
    payload.avatar_number = pendingAvatarNumber
  }

  if (Object.keys(payload).length === 0) { showViewMode(); return }

  btn.disabled = true
  btn.textContent = 'Saving…'
  try {
    const updated = await updateMyProfile(payload)
    currentProfile = updated
    renderViewMode()
    showViewMode()
    showToast('Profile saved!')
    const navEl = document.querySelector('#nav-auth .nav-username-sm')
    if (navEl && updated.username) navEl.textContent = `@${updated.username}`
  } catch (e) {
    errEl.textContent = e.message
  } finally {
    btn.disabled = false
    btn.textContent = 'Save Changes'
  }
}

function renderAvatar(imgId, initialsId, avatarNumber, firstName, username) {
  const img      = document.getElementById(imgId)
  const initials = document.getElementById(initialsId)
  if (!img || !initials) return

  const n = normalizeAvatarNumber(avatarNumber, DEFAULT_AVATAR_NUMBER)
  img.src = avatarPathFromNumber(n)
  img.onerror = () => {
    img.onerror = null
    img.classList.add('hidden')
    initials.classList.remove('hidden')
    const name = firstName || username || '?'
    initials.textContent = name.charAt(0).toUpperCase()
  }
  img.classList.remove('hidden')
  initials.classList.add('hidden')
}

function renderAvatarGrid(selected) {
  const grid = document.getElementById('avatar-grid')
  if (!grid) return
  const selectedNumber = normalizeAvatarNumber(selected, DEFAULT_AVATAR_NUMBER)
  grid.innerHTML = AVATARS.map(num => `
    <div class="avatar-grid-item${selectedNumber === num ? ' selected' : ''}" data-avatar-number="${num}">
      <img src="${avatarPathFromNumber(num)}" alt="Avatar option ${num}" />
    </div>
  `).join('')
}

function renderTradeSettings() {
  const p = currentProfile || {}

  const releaseToggle = document.getElementById('toggle-release-code')
  if (releaseToggle) releaseToggle.checked = !!p.require_release_code

  const withdrawToggle = document.getElementById('toggle-withdraw-code')
  if (withdrawToggle) withdrawToggle.checked = !!p.withdraw_code_required

  updateWithdrawCodeStatus(!!p.withdraw_code_hash)
}

function updateWithdrawCodeStatus(hasCode) {
  const el = document.getElementById('withdraw-code-status')
  if (!el) return
  el.textContent = hasCode
    ? 'A confirmation code is set. Enter a new code below to change it, or click Remove Code to clear it.'
    : 'No confirmation code is set. Set one below to enable code-protected actions.'

  const removeBtn = document.getElementById('btn-remove-withdraw-code')
  if (removeBtn) removeBtn.classList.toggle('hidden', !hasCode)
}

function bindTradeSettings() {

  const releaseToggle = document.getElementById('toggle-release-code')
  if (releaseToggle) {
    releaseToggle.addEventListener('change', async () => {
      const enabled = releaseToggle.checked
      try {
        const updated = await updateMyProfile({ require_release_code: enabled })
        currentProfile = updated
        showToast(enabled ? 'Release code enabled.' : 'Release code disabled.')
      } catch (e) {
        releaseToggle.checked = !enabled
        showToast('Failed to save: ' + e.message, 'error')
      }
    })
  }

  const withdrawToggle = document.getElementById('toggle-withdraw-code')
  if (withdrawToggle) {
    withdrawToggle.addEventListener('change', async () => {
      const enabled = withdrawToggle.checked
      try {
        const updated = await updateMyProfile({ withdraw_code_required: enabled })
        currentProfile = updated
        showToast(enabled ? 'Off-chain send code required.' : 'Off-chain send code requirement removed.')
      } catch (e) {
        withdrawToggle.checked = !enabled
        showToast('Failed to save: ' + e.message, 'error')
      }
    })
  }

  const saveCodeBtn = document.getElementById('btn-save-withdraw-code')
  if (saveCodeBtn) {
    saveCodeBtn.addEventListener('click', async () => {
      const codeInput    = document.getElementById('input-withdraw-code')
      const confirmInput = document.getElementById('input-withdraw-code-confirm')
      const errEl        = document.getElementById('withdraw-code-error')
      errEl.textContent  = ''

      const code    = codeInput.value.trim()
      const confirm = confirmInput.value.trim()

      if (!code) { errEl.textContent = 'Please enter a code.'; return }
      if (!/^\d{4,6}$/.test(code)) { errEl.textContent = 'Code must be 4–6 digits.'; return }
      if (code !== confirm) { errEl.textContent = 'Codes do not match.'; return }

      saveCodeBtn.disabled = true
      try {
        const updated = await setWithdrawCode(code)
        currentProfile = updated
        codeInput.value = ''
        confirmInput.value = ''
        updateWithdrawCodeStatus(true)
        showToast('Confirmation code saved.')
      } catch (e) {
        errEl.textContent = 'Failed to save: ' + e.message
      } finally {
        saveCodeBtn.disabled = false
      }
    })
  }

  const removeCodeBtn = document.getElementById('btn-remove-withdraw-code')
  if (removeCodeBtn) {
    removeCodeBtn.addEventListener('click', async () => {
      removeCodeBtn.disabled = true
      try {
        const updated = await setWithdrawCode('')
        currentProfile = updated
        updateWithdrawCodeStatus(false)
        showToast('Confirmation code removed.')
      } catch (e) {
        showToast('Failed to remove: ' + e.message, 'error')
      } finally {
        removeCodeBtn.disabled = false
      }
    })
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
