import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, getCombinedUsdBalance } from '../api.js'
import { avatarPathFromProfile } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const ADS_STORE_KEY = 'cardswap:p2p-ads'
const EARNINGS_STORE_PREFIX = 'cardswap:p2p-ads-earnings:'
const VIEWS_STORE_PREFIX = 'cardswap:p2p-ads-views:'
const FEEDBACK_STORE_KEY = 'cardswap:p2p-ads-feedback'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

let currentUser = null
let currentProfile = null
let activeWatch = null

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
  bindPostAdForm()
  renderEarnings()
  renderAds()
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

function bindPostAdForm() {
  const postBtn = document.getElementById('btn-post-ad')
  postBtn?.addEventListener('click', async () => {
    const err = document.getElementById('ad-post-error')
    const title = document.getElementById('ad-title').value.trim()
    const description = document.getElementById('ad-description').value.trim()
    const adLinkRaw = document.getElementById('ad-link').value.trim()
    const rewardCents = Number(document.getElementById('ad-reward-cents').value)
    const watchSecs = Number(document.getElementById('ad-watch-secs').value)
    const questions = collectQuestionnaire()

    err.textContent = ''
    if (!title) { err.textContent = 'Ad title is required.'; return }
    if (!description) { err.textContent = 'Ad message is required.'; return }
    const adLink = normalizeHttpUrl(adLinkRaw)
    if (!adLink) { err.textContent = 'Enter a valid ad link (http/https).'; return }
    if (!Number.isFinite(rewardCents) || rewardCents < 1 || rewardCents > 100) {
      err.textContent = 'Reward must be between 1 and 100 cents.'
      return
    }
    if (!Number.isFinite(watchSecs) || watchSecs < 5 || watchSecs > 120) {
      err.textContent = 'Watch time must be between 5 and 120 seconds.'
      return
    }
    if (questions.length > 4) {
      err.textContent = 'Questionnaire supports at most 4 questions.'
      return
    }

    postBtn.disabled = true
    postBtn.textContent = 'Checking balance...'
    try {
      const usdBalance = await getCombinedUsdBalance()
      const minRequired = rewardCents / 100
      if (!Number.isFinite(usdBalance) || usdBalance + 1e-9 < minRequired) {
        err.textContent = `Insufficient balance. You need at least ${formatUsd(minRequired)} to fund one ad watch.`
        return
      }

      const ads = loadAds()
      ads.unshift({
        id: crypto.randomUUID(),
        ownerUid: currentUser.uid,
        ownerLabel: currentProfile?.username ? `@${currentProfile.username}` : (currentUser.email || 'User'),
        title,
        description,
        adLink,
        rewardCents,
        watchSecs,
        questions,
        createdAt: Math.floor(Date.now() / 1000),
      })
      saveAds(ads)
      resetAdForm()
      renderAds()
    } catch (e) {
      err.textContent = `Could not verify balance: ${e?.message || 'Unknown error'}`
    } finally {
      postBtn.disabled = false
      postBtn.textContent = 'Post Ad'
    }
  })
}

function renderEarnings() {
  const cents = getEarningsCents()
  document.getElementById('ads-earned-total').textContent = formatUsd(cents / 100)
}

function renderAds() {
  const list = document.getElementById('ads-list')
  const ads = loadAds()
  const feedbackByAd = loadFeedbackByAdId()

  if (!ads.length) {
    list.innerHTML = '<p class="muted">No ads posted yet. Be the first to post one.</p>'
    return
  }

  const views = loadViewsByAdId()

  list.innerHTML = ads.map((ad) => {
    const isOwner = ad.ownerUid === currentUser.uid
    const watched = !!views[ad.id]
    const feedbackCount = Array.isArray(feedbackByAd[ad.id]) ? feedbackByAd[ad.id].length : 0
    const stateText = isOwner ? 'Your ad' : (watched ? 'Watched' : 'Available')
    const stateColor = isOwner ? 'var(--muted)' : (watched ? 'var(--success)' : 'var(--accent)')

    return `
      <div class="offer-card" style="margin-bottom:0.8rem;">
        <div style="display:flex;justify-content:space-between;gap:0.9rem;align-items:flex-start;flex-wrap:wrap;">
          <div style="min-width:220px;flex:1;">
            <strong>${esc(ad.title)}</strong>
            <div class="muted" style="font-size:0.82rem;margin-top:0.2rem;">Posted by ${esc(ad.ownerLabel)} • ${new Date(ad.createdAt * 1000).toLocaleString()}</div>
            <p style="margin-top:0.45rem;">${esc(ad.description)}</p>
            <div class="muted" style="font-size:0.82rem;">Questionnaire: ${Array.isArray(ad.questions) ? ad.questions.length : 0} question(s)</div>
            <div class="muted" style="font-size:0.82rem;">Watch ${Number(ad.watchSecs)}s and earn ${Number(ad.rewardCents)} cents</div>
            ${isOwner ? `<button class="btn-sm btn-secondary" data-view-feedback="${esc(ad.id)}">View Feedback (${feedbackCount})</button>` : ''}
            <div id="ad-feedback-${esc(ad.id)}" class="hidden" style="margin-top:0.55rem;"></div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.4rem;min-width:150px;">
            <span style="font-size:0.82rem;color:${stateColor};font-weight:600;">${stateText}</span>
            ${isOwner
              ? `<button class="btn-sm btn-danger" data-delete-ad="${esc(ad.id)}">Delete</button>`
              : `<button class="btn-sm" data-watch-ad="${esc(ad.id)}" ${watched ? 'disabled' : ''}>${watched ? 'Already Watched' : 'Watch Ad'}</button>`}
            <div class="muted" data-watch-status="${esc(ad.id)}"></div>
          </div>
        </div>
      </div>
    `
  }).join('')

  list.querySelectorAll('[data-delete-ad]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const adId = btn.getAttribute('data-delete-ad')
      const next = loadAds().filter((ad) => ad.id !== adId)
      saveAds(next)
      const views = loadViewsByAdId()
      delete views[adId]
      saveViewsByAdId(views)
      const feedback = loadFeedbackByAdId()
      delete feedback[adId]
      saveFeedbackByAdId(feedback)
      renderAds()
    })
  })

  list.querySelectorAll('[data-view-feedback]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const adId = btn.getAttribute('data-view-feedback')
      const panel = document.getElementById(`ad-feedback-${adId}`)
      if (!panel) return
      panel.classList.toggle('hidden')
      if (!panel.classList.contains('hidden')) {
        renderFeedbackPanel(panel, adId)
      }
    })
  })

  list.querySelectorAll('[data-watch-ad]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const adId = btn.getAttribute('data-watch-ad')
      const ad = loadAds().find((item) => item.id === adId)
      if (!ad) return
      watchAd(ad)
    })
  })
}

function watchAd(ad) {
  if (ad.ownerUid === currentUser.uid) return
  if (!normalizeHttpUrl(ad.adLink || '')) return

  const modal = document.getElementById('watch-ad-modal')
  const closeBtn = document.getElementById('close-watch-ad-modal')
  const frame = document.getElementById('watch-ad-frame')
  const status = document.getElementById('watch-ad-status')
  const qWrap = document.getElementById('watch-ad-questions')
  const submitBtn = document.getElementById('btn-submit-ad-answers')
  const linkBtn = document.getElementById('watch-ad-link')

  if (!modal || !closeBtn || !frame || !status || !qWrap || !submitBtn || !linkBtn) return

  if (activeWatch?.timer) {
    clearInterval(activeWatch.timer)
  }

  closeBtn.onclick = () => {
    if (activeWatch?.timer) clearInterval(activeWatch.timer)
    activeWatch = null
    modal.classList.add('hidden')
    frame.src = 'about:blank'
    renderAds()
  }

  frame.src = normalizeHttpUrl(ad.adLink)
  modal.classList.remove('hidden')

  const totalSecs = Math.max(5, Math.floor(Number(ad.watchSecs) || 0))
  let remaining = totalSecs
  qWrap.classList.add('hidden')
  qWrap.innerHTML = ''
  submitBtn.classList.add('hidden')
  linkBtn.classList.add('hidden')
  linkBtn.href = normalizeHttpUrl(ad.adLink)

  const views = loadViewsByAdId()
  if (views[ad.id]) {
    status.textContent = 'You already completed this ad. You can still visit the advertiser website.'
    linkBtn.classList.remove('hidden')
    return
  }

  status.textContent = `Watching ad in app... ${remaining}s remaining.`

  const timer = setInterval(() => {
    remaining -= 1
    if (remaining > 0) {
      status.textContent = `Watching ad in app... ${remaining}s remaining.`
      return
    }

    clearInterval(timer)
    status.textContent = 'Watch complete. Please answer the questionnaire to receive reward and unlock link.'
    renderQuestionnaire(ad, qWrap)
    qWrap.classList.remove('hidden')
    submitBtn.classList.remove('hidden')

    submitBtn.onclick = () => submitAdFeedback(ad)
  }, 1000)

  activeWatch = { adId: ad.id, timer }
}

function renderQuestionnaire(ad, target) {
  const questions = Array.isArray(ad.questions) ? ad.questions.slice(0, 4) : []
  if (!questions.length) {
    target.innerHTML = '<p class="muted">No questions configured for this ad.</p>'
    return
  }

  target.innerHTML = questions.map((q, idx) => {
    const qId = `ad-q-${idx}`
    const prompt = esc(q.prompt || `Question ${idx + 1}`)
    if (q.type === 'yesno') {
      return `
        <div class="field-row" style="margin-top:0.35rem;">
          <label>${prompt}</label>
          <div class="radio-group">
            <label class="radio-label"><input type="radio" name="${qId}" value="yes" /> <span>Yes</span></label>
            <label class="radio-label"><input type="radio" name="${qId}" value="no" /> <span>No</span></label>
          </div>
        </div>
      `
    }
    return `
      <div class="field-row" style="margin-top:0.35rem;">
        <label for="${qId}">${prompt}</label>
        <input id="${qId}" class="form-input" type="text" maxlength="180" placeholder="Your answer" />
      </div>
    `
  }).join('')
}

function submitAdFeedback(ad) {
  const status = document.getElementById('watch-ad-status')
  const submitBtn = document.getElementById('btn-submit-ad-answers')
  const linkBtn = document.getElementById('watch-ad-link')
  const questions = Array.isArray(ad.questions) ? ad.questions.slice(0, 4) : []
  const answers = []

  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i]
    const prompt = String(q.prompt || '').trim()
    if (!prompt) continue

    if (q.type === 'yesno') {
      const picked = document.querySelector(`input[name="ad-q-${i}"]:checked`)
      if (!picked) {
        if (status) status.textContent = `Please answer question ${i + 1}.`
        return
      }
      answers.push({ prompt, type: 'yesno', answer: picked.value })
    } else {
      const input = document.getElementById(`ad-q-${i}`)
      const val = String(input?.value || '').trim()
      if (!val) {
        if (status) status.textContent = `Please answer question ${i + 1}.`
        return
      }
      answers.push({ prompt, type: 'short', answer: val })
    }
  }

  const views = loadViewsByAdId()
  if (!views[ad.id]) {
    views[ad.id] = Math.floor(Date.now() / 1000)
    saveViewsByAdId(views)
    const next = getEarningsCents() + Number(ad.rewardCents || 0)
    setEarningsCents(next)
    renderEarnings()
  }

  const feedbackByAd = loadFeedbackByAdId()
  const list = Array.isArray(feedbackByAd[ad.id]) ? feedbackByAd[ad.id] : []
  list.unshift({
    watcherUid: currentUser.uid,
    watcherLabel: currentProfile?.username ? `@${currentProfile.username}` : (currentUser.email || 'User'),
    createdAt: Math.floor(Date.now() / 1000),
    answers,
  })
  feedbackByAd[ad.id] = list
  saveFeedbackByAdId(feedbackByAd)

  if (status) status.textContent = `Completed. You earned ${ad.rewardCents} cents. You can now visit the advertiser website.`
  submitBtn.classList.add('hidden')
  linkBtn.classList.remove('hidden')
  renderAds()
}

function renderFeedbackPanel(panel, adId) {
  const feedbackByAd = loadFeedbackByAdId()
  const rows = Array.isArray(feedbackByAd[adId]) ? feedbackByAd[adId] : []
  if (!rows.length) {
    panel.innerHTML = '<p class="muted" style="margin-top:0.45rem;">No feedback yet.</p>'
    return
  }

  panel.innerHTML = rows.map((row) => {
    const answers = Array.isArray(row.answers) ? row.answers : []
    return `
      <div style="margin-top:0.55rem;padding:0.65rem;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,0.02);">
        <div class="muted" style="font-size:0.78rem;margin-bottom:0.35rem;">${esc(row.watcherLabel || 'Watcher')} • ${new Date((row.createdAt || 0) * 1000).toLocaleString()}</div>
        ${answers.length
          ? answers.map((a) => `<div style="margin-bottom:0.25rem;"><strong>${esc(a.prompt)}:</strong> <span>${esc(a.answer)}</span></div>`).join('')
          : '<div class="muted">No answers submitted.</div>'}
      </div>
    `
  }).join('')
}

function loadAds() {
  try {
    return JSON.parse(localStorage.getItem(ADS_STORE_KEY) || '[]')
  } catch {
    return []
  }
}

function saveAds(ads) {
  localStorage.setItem(ADS_STORE_KEY, JSON.stringify(ads))
}

function loadViewsByAdId() {
  if (!currentUser?.uid) return {}
  try {
    return JSON.parse(localStorage.getItem(`${VIEWS_STORE_PREFIX}${currentUser.uid}`) || '{}')
  } catch {
    return {}
  }
}

function saveViewsByAdId(viewsByAdId) {
  if (!currentUser?.uid) return
  localStorage.setItem(`${VIEWS_STORE_PREFIX}${currentUser.uid}`, JSON.stringify(viewsByAdId))
}

function getEarningsCents() {
  if (!currentUser?.uid) return 0
  const val = Number(localStorage.getItem(`${EARNINGS_STORE_PREFIX}${currentUser.uid}`) || '0')
  return Number.isFinite(val) ? Math.max(0, Math.floor(val)) : 0
}

function setEarningsCents(cents) {
  if (!currentUser?.uid) return
  localStorage.setItem(`${EARNINGS_STORE_PREFIX}${currentUser.uid}`, String(Math.max(0, Math.floor(cents))))
}

function resetAdForm() {
  document.getElementById('ad-title').value = ''
  document.getElementById('ad-description').value = ''
  document.getElementById('ad-link').value = ''
  document.getElementById('ad-reward-cents').value = ''
  document.getElementById('ad-watch-secs').value = ''
  document.querySelectorAll('.ad-q-type').forEach((el) => { el.value = 'none' })
  document.querySelectorAll('.ad-q-text').forEach((el) => { el.value = '' })
  document.getElementById('ad-post-error').textContent = ''
}

function formatUsd(v) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
}

function cssEsc(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function normalizeHttpUrl(v) {
  const val = String(v || '').trim()
  if (!val) return null
  try {
    const url = new URL(val)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

function collectQuestionnaire() {
  const types = [...document.querySelectorAll('.ad-q-type')]
  const texts = [...document.querySelectorAll('.ad-q-text')]
  const out = []
  for (let i = 0; i < Math.min(types.length, texts.length, 4); i += 1) {
    const type = String(types[i].value || 'none')
    const prompt = String(texts[i].value || '').trim()
    if (type === 'none' && !prompt) continue
    if (type === 'none' && prompt) continue
    if (type !== 'none' && !prompt) continue
    if (type !== 'yesno' && type !== 'short') continue
    out.push({ type, prompt })
  }
  return out
}

function loadFeedbackByAdId() {
  try {
    return JSON.parse(localStorage.getItem(FEEDBACK_STORE_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveFeedbackByAdId(data) {
  localStorage.setItem(FEEDBACK_STORE_KEY, JSON.stringify(data))
}
