import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, listTrades, editTradeFeedback } from '../api.js'
import { cacheGet } from '../cache.js'
import { avatarPathFromProfile, avatarPathFromNumber } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'
import { showAlert, showFeedbackModal } from '../modal.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

let currentUser = null
let activeView = 'received'
let receivedRows = []
let givenRows = []
const PAGE_SIZE = 20
const viewPage = { received: 1, given: 1 }

onAuthChange(async (user) => {
  if (!user) {
    window.location.href = '/'
    return
  }
  currentUser = user

  let profile
  try {
    profile = await upsertUser()
  } catch {
    profile = { email: user.email }
  }

  renderNav(profile, user)
  bindViewToggle()
  await loadFeedbackFeed()
})

function bindViewToggle() {
  const receivedBtn = document.getElementById('feedback-view-received')
  const givenBtn = document.getElementById('feedback-view-given')
  if (!receivedBtn || !givenBtn) return

  receivedBtn.addEventListener('click', () => {
    activeView = 'received'
    viewPage.received = 1
    renderActiveView()
  })
  givenBtn.addEventListener('click', () => {
    activeView = 'given'
    viewPage.given = 1
    renderActiveView()
  })
}

function renderNav(profile, user) {
  const navAuth = document.getElementById('nav-auth')
  if (!navAuth) return

  const label = profile?.username ? `@${profile.username}` : user.email
  const photo = avatarPathFromProfile(profile)
  const initial = (profile?.first_name || profile?.username || label || '?').charAt(0).toUpperCase()

  navAuth.innerHTML = `
    <span id="nav-available-balance" class="nav-balance-sm" title="Available balance">Bal: --</span>
    <a href="/settings.html" class="nav-profile-link" title="Account Settings">
      <span class="nav-avatar-sm">${photo ? `<img src="${photo}" alt="" />` : initial}</span>
      <span class="nav-username-sm">${escapeHtml(label)}</span>
    </a>
    <button id="btn-logout" class="btn-sm">Sign Out</button>
  `

  navAuth.querySelector('#btn-logout')?.addEventListener('click', () => logOut())
  setupUnreadTradeNotifications({ user, navAuth })
  ensureDevBalanceTools()
  void refreshNavCombinedBalance()
}

async function loadFeedbackFeed() {
  const listEl = document.getElementById('feedback-list')
  if (!listEl) return

  const cached = cacheGet('trades')
  if (cached) {
    hydrateFeedbackRows(cached)
    renderActiveView()
  }

  try {
    const trades = await listTrades()
    hydrateFeedbackRows(trades)
    renderActiveView()
  } catch (e) {
    if (!cached) {
      listEl.innerHTML = `<p class="error">Failed to load feedback: ${escapeHtml(e.message || 'Unknown error')}</p>`
    }
  }
}

function hydrateFeedbackRows(trades) {
  const rows = extractFeedbackRows(trades)
  receivedRows = rows.received
  givenRows = rows.given
  viewPage.received = clampPage(viewPage.received, receivedRows.length)
  viewPage.given = clampPage(viewPage.given, givenRows.length)
}

function extractFeedbackRows(trades) {
  if (!Array.isArray(trades) || !currentUser?.uid) {
    return { received: [], given: [] }
  }

  const received = []
  const given = []
  for (const trade of trades) {
    const entries = Array.isArray(trade?.feedback) ? trade.feedback : []
    for (const entry of entries) {
      if (!entry) continue

      if (entry.to_uid === currentUser.uid) {
        const fromMeta = senderMetaFromTrade(trade, entry.from_uid)
        received.push({
          tradeId: String(trade.id || ''),
          counterpartyUid: String(entry.from_uid || ''),
          counterpartyName: fromMeta.name,
          counterpartyAvatarNumber: fromMeta.avatarNumber,
          positive: !!entry.positive,
          comment: String(entry.comment || ''),
          createdAt: Number(entry.created_at || 0),
        })
      }

      if (entry.from_uid === currentUser.uid) {
        const toMeta = recipientMetaFromTrade(trade, entry.to_uid)
        given.push({
          tradeId: String(trade.id || ''),
          counterpartyUid: String(entry.to_uid || ''),
          counterpartyName: toMeta.name,
          counterpartyAvatarNumber: toMeta.avatarNumber,
          positive: !!entry.positive,
          comment: String(entry.comment || ''),
          createdAt: Number(entry.created_at || 0),
        })
      }
    }
  }

  received.sort((a, b) => b.createdAt - a.createdAt)
  given.sort((a, b) => b.createdAt - a.createdAt)
  return { received, given }
}

function senderMetaFromTrade(trade, fromUid) {
  if (fromUid === trade?.creator_uid) {
    return {
      name: trade?.creator_username || shortUid(fromUid),
      avatarNumber: trade?.creator_avatar_number,
    }
  }

  if (fromUid === trade?.offer_owner_uid) {
    return {
      name: trade?.offer_owner_username || shortUid(fromUid),
      avatarNumber: trade?.offer_owner_avatar_number,
    }
  }

  return {
    name: shortUid(fromUid),
    avatarNumber: null,
  }
}

function recipientMetaFromTrade(trade, toUid) {
  if (toUid === trade?.creator_uid) {
    return {
      name: trade?.creator_username || shortUid(toUid),
      avatarNumber: trade?.creator_avatar_number,
    }
  }

  if (toUid === trade?.offer_owner_uid) {
    return {
      name: trade?.offer_owner_username || shortUid(toUid),
      avatarNumber: trade?.offer_owner_avatar_number,
    }
  }

  return {
    name: shortUid(toUid),
    avatarNumber: null,
  }
}

function renderActiveView() {
  const listEl = document.getElementById('feedback-list')
  const paginationEl = document.getElementById('feedback-pagination')
  const subtitle = document.getElementById('feedback-view-subtitle')
  const receivedBtn = document.getElementById('feedback-view-received')
  const givenBtn = document.getElementById('feedback-view-given')
  if (!listEl || !paginationEl || !subtitle || !receivedBtn || !givenBtn) return

  const showingReceived = activeView === 'received'
  subtitle.textContent = showingReceived
    ? 'Recent feedback your trading partners have left for you.'
    : 'Recent feedback you left for your trading partners.'

  receivedBtn.className = `btn ${showingReceived ? 'btn-success' : 'btn-secondary'}`
  givenBtn.className = `btn ${showingReceived ? 'btn-secondary' : 'btn-success'}`

  const rows = showingReceived ? receivedRows : givenRows
  const currentPage = viewPage[activeView]
  const start = (currentPage - 1) * PAGE_SIZE
  const pageRows = rows.slice(start, start + PAGE_SIZE)

  renderFeedbackList(listEl, pageRows, activeView)
  renderPagination(paginationEl, rows.length, activeView)
}

function renderPagination(container, totalRows, viewMode) {
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE))
  const currentPage = clampPage(viewPage[viewMode], totalRows)
  viewPage[viewMode] = currentPage

  if (totalRows <= PAGE_SIZE) {
    container.innerHTML = ''
    return
  }

  container.innerHTML = `
    <button id="feedback-page-prev" class="btn-sm" ${currentPage <= 1 ? 'disabled' : ''}>Prev</button>
    <span class="muted" style="font-size:0.85rem;">Page ${currentPage} of ${totalPages}</span>
    <button id="feedback-page-next" class="btn-sm" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
  `

  container.querySelector('#feedback-page-prev')?.addEventListener('click', () => {
    if (viewPage[viewMode] <= 1) return
    viewPage[viewMode] -= 1
    renderActiveView()
  })

  container.querySelector('#feedback-page-next')?.addEventListener('click', () => {
    if (viewPage[viewMode] >= totalPages) return
    viewPage[viewMode] += 1
    renderActiveView()
  })
}

function clampPage(page, totalRows) {
  const totalPages = Math.max(1, Math.ceil(Number(totalRows || 0) / PAGE_SIZE))
  const n = Number(page || 1)
  if (!Number.isFinite(n) || n < 1) return 1
  if (n > totalPages) return totalPages
  return Math.floor(n)
}

function renderFeedbackList(container, feedbackRows, viewMode) {
  if (!feedbackRows.length) {
    container.innerHTML = `<p class="muted">${viewMode === 'received' ? 'No feedback has been left for you yet.' : 'You have not left feedback for anyone yet.'}</p>`
    return
  }

  container.innerHTML = feedbackRows.map((row) => {
    const avatarPath = avatarPathFromNumber(row.counterpartyAvatarNumber)
    const when = row.createdAt ? new Date(row.createdAt * 1000).toLocaleString() : 'Unknown date'
    const sentimentClass = row.positive ? 'feedback-sentiment-positive' : 'feedback-sentiment-negative'
    const sentimentText = row.positive ? 'Positive' : 'Negative'
    const label = viewMode === 'received' ? 'From' : 'To'

    return `
      <article class="trade-card trade-card-past">
        <div class="trade-card-header">
          <div class="trade-partner">
            <span class="trade-partner-avatar"><img src="${escapeHtml(avatarPath)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" /></span>
            <div>
              <span class="trade-partner-label">${label}</span>
              <span class="trade-partner-id">${escapeHtml(row.counterpartyName)}</span>
            </div>
          </div>
          <span class="trade-status-badge feedback-sentiment ${sentimentClass}">${sentimentText}</span>
        </div>

        <div class="trade-card-body">
          <div class="trade-detail-row">
            <span class="trade-detail-label">Date</span>
            <span class="trade-detail-value">${escapeHtml(when)}</span>
          </div>
          <div class="trade-detail-row" style="align-items:flex-start;">
            <span class="trade-detail-label">Message</span>
            <span class="trade-detail-value" style="white-space:pre-wrap;text-align:right;max-width:70%;">${escapeHtml(row.comment || '(No message)')}</span>
          </div>
        </div>

        <div class="trade-card-actions">
          ${viewMode === 'given' ? `<button class="btn-sm" data-edit-feedback-trade="${encodeURIComponent(row.tradeId)}">Edit Feedback</button>` : ''}
          <a class="btn-sm btn-success" href="/trade-detail.html?id=${encodeURIComponent(row.tradeId)}">Open Trade</a>
        </div>
      </article>
    `
  }).join('')

  if (viewMode === 'given') {
    container.querySelectorAll('[data-edit-feedback-trade]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tradeId = decodeURIComponent(btn.dataset.editFeedbackTrade || '')
        const row = givenRows.find((item) => item.tradeId === tradeId)
        if (!row) return

        try {
          const result = await showFeedbackModal({
            initialPositive: !!row.positive,
            initialComment: String(row.comment || ''),
            title: 'Edit Feedback',
            submitLabel: 'Save Changes',
          })
          if (!result) return

          btn.disabled = true
          await editTradeFeedback(tradeId, result.positive, result.comment)
          await loadFeedbackFeed()
        } catch (e) {
          await showAlert(`Feedback update failed: ${e.message}`)
          btn.disabled = false
        }
      })
    })
  }
}

function shortUid(uid) {
  const val = String(uid || '')
  if (!val) return 'Unknown user'
  return val.length <= 8 ? val : `${val.slice(0, 8)}...`
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
