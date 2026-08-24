
import { initializeApp } from 'firebase/app'
import { firebaseConfig }  from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, listTrades, completeTrade, cancelTrade, listPaymentMethods } from '../api.js'
import { showAlert, showConfirm } from '../modal.js'
import { cacheGet, cacheInvalidate } from '../cache.js'
import { avatarPathFromProfile, avatarPathFromNumber } from '../avatar.js'
import { getPresenceBadgeState } from '../presence.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

cacheInvalidate('trades')

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)

let currentUser = null
let allTrades = []
let activeTrades = []
let pastTrades = []
let countdownTimer = null
let pastFiltersBound = false
let paymentMethodNameMap = null
let appliedPastFilters = {
  coin: new Set(),
  type: new Set(),
  method: new Set(),
  dateFrom: '',
  dateTo: '',
}

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }
  currentUser = user

  let profile
  try { profile = await upsertUser() } catch { profile = { email: user.email } }

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

  bindPastFiltersUi()
  await ensurePaymentMethodNameMap()
  await loadTradesOverview()

  const tradeId = new URLSearchParams(window.location.search).get('trade')
  if (tradeId) {
    window.location.href = `/trade-detail.html?id=${tradeId}`
    return
  }
})

async function loadTradesOverview() {
  const activeGrid = document.getElementById('active-trades-list')
  const pastGrid = document.getElementById('past-trades-list')

  const cached = cacheGet('trades')
  if (cached) {
    consumeTrades(cached)
    renderActiveTrades(activeGrid, activeTrades)
    renderPastTrades(pastGrid, applyPastFilters())
  } else {
    activeGrid.innerHTML = '<p class="muted">Loading…</p>'
    pastGrid.innerHTML = '<p class="muted">Loading…</p>'
  }

  try {
    const all = await listTrades()
    consumeTrades(all)
    renderActiveTrades(activeGrid, activeTrades)
    renderPastTrades(pastGrid, applyPastFilters())
  } catch (e) {
    if (!cached) {
      activeGrid.innerHTML = `<p class="error">Failed to load trades: ${e.message}</p>`
      pastGrid.innerHTML = `<p class="error">Failed to load trades: ${e.message}</p>`
    }
  }
}

async function ensurePaymentMethodNameMap() {
  if (paymentMethodNameMap) return paymentMethodNameMap
  try {
    const methods = await listPaymentMethods()
    paymentMethodNameMap = new Map(
      (methods || []).map((method) => [String(method.id || '').toLowerCase(), method.name || method.id || ''])
    )
  } catch {
    paymentMethodNameMap = new Map()
  }
  return paymentMethodNameMap
}

function prettifyPaymentMethodId(raw) {
  return String(raw || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function paymentMethodDisplayName(raw) {
  const id = String(raw || '').trim()
  if (!id) return '—'
  return paymentMethodNameMap?.get(id.toLowerCase()) || prettifyPaymentMethodId(id)
}

function isTradeSettled(t) {
  const status = String(t?.status || '').toLowerCase()
  if (status === 'disputed') return !!t.dispute_resolved
  return ['completed', 'cancelled', 'expired'].includes(status)
}

function consumeTrades(trades) {
  allTrades = Array.isArray(trades)
    ? Array.from(new Map(trades.filter((trade) => trade?.id).map((trade) => [trade.id, trade])).values())
    : []
  activeTrades = allTrades.filter(t => !isTradeSettled(t))
  pastTrades = allTrades.filter(t => isTradeSettled(t))
  refreshPastFilterOptions()
}

function renderActiveTrades(grid, trades) {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }

  if (!trades.length) {
    grid.innerHTML = '<p class="muted">No active trades. <a href="/p2p.html">Browse the P2P market</a> to start one.</p>'
    return
  }

  grid.innerHTML = trades.map(t => buildTradeCard(t)).join('')

  grid.querySelectorAll('.btn-open-chat').forEach(btn => {
    btn.addEventListener('click', () => {
      const tradeId = btn.dataset.id
      window.location.href = `/trade-detail.html?id=${tradeId}`
    })
  })

  grid.querySelectorAll('.btn-complete-trade').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tradeId = btn.dataset.id
      const trade = trades.find((entry) => String(entry.id) === String(tradeId))
      const confirmMessage = String(trade?.status || '').toLowerCase() === 'paid'
        ? 'Mark this trade as completed? This confirms you have received payment.'
        : 'Your trade counterparty has not marked this trade as paid yet. Are you still sure you want to release and complete this trade?'
      if (!await showConfirm(confirmMessage)) return
      btn.disabled = true
      try { await completeTrade(tradeId); await loadTradesOverview() }
      catch (e) { showAlert(e.message); btn.disabled = false }
    })
  })

  grid.querySelectorAll('.btn-cancel-trade').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!await showConfirm('Cancel this trade?')) return
      btn.disabled = true
      try { await cancelTrade(btn.dataset.id); await loadTradesOverview() }
      catch (e) { showAlert(e.message); btn.disabled = false }
    })
  })

  countdownTimer = setInterval(() => tickCountdowns(grid, trades), 1000)
}

function bindPastFiltersUi() {
  if (pastFiltersBound) return
  pastFiltersBound = true

  const toggleBtn = document.getElementById('past-trades-filters-toggle')
  const panel = document.getElementById('past-trades-filters-panel')
  const applyBtn = document.getElementById('btn-apply-past-filters')
  const clearBtn = document.getElementById('btn-clear-past-filters')
  const downloadBtn = document.getElementById('btn-download-past-csv')
  const dateFromInput = document.getElementById('filter-past-date-from')
  const dateToInput = document.getElementById('filter-past-date-to')

  const collapsePanel = () => {
    panel.classList.add('hidden')
    if (toggleBtn) toggleBtn.textContent = 'Show Filters'
  }

  toggleBtn?.addEventListener('click', () => {
    const isHidden = panel.classList.toggle('hidden')
    toggleBtn.textContent = isHidden ? 'Show Filters' : 'Hide Filters'
  })

  applyBtn?.addEventListener('click', () => {
    appliedPastFilters.coin = readCheckedValues(document.getElementById('filter-past-coin'))
    appliedPastFilters.type = readCheckedValues(document.getElementById('filter-past-type'))
    appliedPastFilters.method = readCheckedValues(document.getElementById('filter-past-method'))
    appliedPastFilters.dateFrom = String(dateFromInput?.value || '')
    appliedPastFilters.dateTo = String(dateToInput?.value || '')
    renderPastTrades(document.getElementById('past-trades-list'), applyPastFilters())
    collapsePanel()
  })

  clearBtn?.addEventListener('click', () => {
    appliedPastFilters = {
      coin: new Set(),
      type: new Set(),
      method: new Set(),
      dateFrom: '',
      dateTo: '',
    }
    syncCheckboxSelection(document.getElementById('filter-past-coin'), appliedPastFilters.coin)
    syncCheckboxSelection(document.getElementById('filter-past-type'), appliedPastFilters.type)
    syncCheckboxSelection(document.getElementById('filter-past-method'), appliedPastFilters.method)
    if (dateFromInput) dateFromInput.value = ''
    if (dateToInput) dateToInput.value = ''
    renderPastTrades(document.getElementById('past-trades-list'), applyPastFilters())
    collapsePanel()
  })

  downloadBtn?.addEventListener('click', () => {
    const rows = applyPastFilters()
    downloadPastTradesCsv(rows)
  })
}

function refreshPastFilterOptions() {
  renderCheckboxGroup(
    document.getElementById('filter-past-coin'),
    uniqSorted(pastTrades.map((t) => String(t.coin || '').toUpperCase()).filter(Boolean)),
    appliedPastFilters.coin,
    'past-coin'
  )
  renderCheckboxGroup(
    document.getElementById('filter-past-type'),
    uniqSorted(pastTrades.map((t) => String(t.offer_type || '').toLowerCase()).filter(Boolean)),
    appliedPastFilters.type,
    'past-type'
  )
  renderCheckboxGroup(
    document.getElementById('filter-past-method'),
    uniqSorted(pastTrades.map((t) => String(t.card || '').trim()).filter(Boolean)),
    appliedPastFilters.method,
    'past-method'
  )
}

function renderCheckboxGroup(container, values, selectedSet, prefix) {
  if (!container) return
  if (!values.length) {
    container.innerHTML = '<span class="muted" style="font-size:0.82rem;">No options</span>'
    return
  }

  container.innerHTML = values.map((value, idx) => {
    const id = `${prefix}-${idx}`
    const checked = selectedSet.has(value) ? 'checked' : ''
    return `
      <label for="${id}" style="display:flex;align-items:center;gap:0.45rem;font-size:0.9rem;cursor:pointer;">
        <input id="${id}" type="checkbox" value="${escHtml(value)}" ${checked} />
        <span>${escHtml(value)}</span>
      </label>
    `
  }).join('')
}

function readCheckedValues(container) {
  if (!container) return new Set()
  return new Set(Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.value))
}

function syncCheckboxSelection(container, selectedSet) {
  if (!container) return
  container.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    el.checked = selectedSet.has(el.value)
  })
}

function applyPastFilters() {
  const selectedCoins = appliedPastFilters.coin
  const selectedTypes = appliedPastFilters.type
  const selectedMethods = appliedPastFilters.method
  const fromTs = parseDateStart(appliedPastFilters.dateFrom)
  const toTs = parseDateEnd(appliedPastFilters.dateTo)

  return pastTrades.filter((t) => {
    const coin = String(t.coin || '').toUpperCase()
    const type = String(t.offer_type || '').toLowerCase()
    const method = String(t.card || '').trim()
    const createdAt = Number(t.created_at || 0)

    if (selectedCoins.size && !selectedCoins.has(coin)) return false
    if (selectedTypes.size && !selectedTypes.has(type)) return false
    if (selectedMethods.size && !selectedMethods.has(method)) return false
    if (fromTs !== null && createdAt < fromTs) return false
    if (toTs !== null && createdAt > toTs) return false
    return true
  })
}

function parseDateStart(dateValue) {
  if (!dateValue) return null
  const ts = Math.floor(new Date(`${dateValue}T00:00:00`).getTime() / 1000)
  return Number.isFinite(ts) ? ts : null
}

function parseDateEnd(dateValue) {
  if (!dateValue) return null
  const ts = Math.floor(new Date(`${dateValue}T23:59:59.999`).getTime() / 1000)
  return Number.isFinite(ts) ? ts : null
}

function downloadPastTradesCsv(rows) {
  const header = [
    'trade_id',
    'status',
    'trade_type',
    'payment_method',
    'currency',
    'fiat_amount',
    'coin',
    'crypto_amount',
    'created_at',
  ]

  const lines = [header.join(',')]
  rows.forEach((t) => {
    const line = [
      t.id,
      t.status,
      t.offer_type,
      t.card,
      t.currency,
      t.fiat_amount,
      t.coin,
      t.crypto_amount,
      t.created_at ? new Date(Number(t.created_at) * 1000).toISOString() : '',
    ].map(csvCell)
    lines.push(line.join(','))
  })

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `past-trades-${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function csvCell(v) {
  const s = String(v ?? '')
  return `"${s.replace(/"/g, '""')}"`
}

function renderPastTrades(grid, trades) {
  if (!trades.length) {
    grid.innerHTML = '<p class="muted">No past trades match the selected filters.</p>'
    return
  }

  grid.innerHTML = trades.map(t => buildPastTradeCard(t)).join('')
  grid.querySelectorAll('.btn-open-past-trade').forEach(btn => {
    btn.addEventListener('click', () => {
      window.location.href = `/trade-detail.html?id=${btn.dataset.id}`
    })
  })
}

function buildPastTradeCard(t) {
  const isCreator = currentUser && t.creator_uid === currentUser.uid
  const offerType = String(t.offer_type || '').toLowerCase()
  const isBuying = (isCreator && offerType === 'sell') || (!isCreator && offerType === 'buy')
  const partnerUid = isCreator ? t.offer_owner_uid : t.creator_uid
  const partnerName = isCreator ? (t.offer_owner_username || null) : (t.creator_username || null)
  const partnerAvatarNumber = isCreator ? t.offer_owner_avatar_number : t.creator_avatar_number
  const partnerLastActiveAt = Number(isCreator ? t.offer_owner_last_active_at : t.creator_last_active_at || 0)
  const partnerPresence = getPresenceBadgeState(partnerLastActiveAt)
  const partnerAvatarPath = avatarPathFromNumber(partnerAvatarNumber)
  const partnerDisplay = partnerName || (partnerUid ? partnerUid.slice(0, 8) + '…' : '—')

  const currency = t.currency || ''
  const coin = t.coin || ''
  const fiatAmt = t.fiat_amount != null ? `${currency} ${Number(t.fiat_amount).toFixed(2)}` : '—'
  const cryptoAmt = t.crypto_amount != null ? `${Number(t.crypto_amount).toFixed(6)} ${coin}` : '—'
  const date = t.created_at ? new Date(t.created_at * 1000).toLocaleDateString() : '—'

  return `
    <div class="trade-card trade-card-past" data-id="${escHtml(t.id)}">
      <div class="trade-card-header">
        <div class="trade-partner">
          <span class="trade-partner-avatar avatar-presence-wrap" title="${escHtml(partnerPresence.label)}">
            <img src="${escHtml(partnerAvatarPath)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />
            <span class="avatar-presence-badge presence-${escHtml(partnerPresence.state)}" aria-hidden="true"></span>
          </span>
          <div>
            <span class="trade-partner-label">Partner</span>
            <span class="trade-partner-id">${escHtml(partnerDisplay)}</span>
          </div>
        </div>
        <span class="trade-status-badge status-${escHtml(t.status)}">${escHtml(t.status)}</span>
      </div>
      <div class="trade-card-body">
        <div class="trade-detail-row">
          <span class="trade-detail-label">Payment Method</span>
          <span class="trade-detail-value">${escHtml(paymentMethodDisplayName(t.card))}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">Trade Type</span>
          <span class="trade-detail-value">${t.offer_type ? (isBuying ? 'BUY' : 'SELL') : '—'}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">Fiat</span>
          <span class="trade-detail-value trade-fiat">${fiatAmt}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">Crypto</span>
          <span class="trade-detail-value trade-crypto">${cryptoAmt}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">Date</span>
          <span class="trade-detail-value">${date}</span>
        </div>
      </div>
      <div class="trade-card-actions">
        <button class="btn-sm btn-success btn-open-past-trade" data-id="${escHtml(t.id)}">View Trade</button>
      </div>
    </div>
  `
}

function buildTradeCard(t) {
  const isCreator      = currentUser && t.creator_uid === currentUser.uid
  const offerType      = String(t.offer_type || '').toLowerCase()

  const isSeller       = (isCreator && offerType === 'buy') || (!isCreator && offerType === 'sell')
  const isBuyer        = !isSeller
  const partnerLabel   = isCreator ? 'Offer Owner' : 'Taker'
  const partnerUid     = isCreator ? t.offer_owner_uid : t.creator_uid
  const partnerName    = isCreator ? (t.offer_owner_username || null) : (t.creator_username || null)
  const partnerAvatarNumber = isCreator ? t.offer_owner_avatar_number : t.creator_avatar_number
  const partnerLastActiveAt = Number(isCreator ? t.offer_owner_last_active_at : t.creator_last_active_at || 0)
  const partnerPresence = getPresenceBadgeState(partnerLastActiveAt)
  const partnerAvatarPath = avatarPathFromNumber(partnerAvatarNumber)
  const partnerShort   = partnerName || (partnerUid ? partnerUid.slice(0, 8) + '…' : '—')

  const offerName    = paymentMethodDisplayName(t.card)
  const currency     = t.currency || ''
  const coin         = t.coin || ''
  const fiatAmt      = t.fiat_amount != null ? `${currency} ${Number(t.fiat_amount).toFixed(2)}` : '—'
  const cryptoAmt    = t.crypto_amount != null ? `${Number(t.crypto_amount).toFixed(6)} ${coin}` : '—'

  const statusClass  = `status-${t.status}`
  const statusLower  = String(t.status || '').toLowerCase()
  const isExpiring   = statusLower === 'open' || statusLower === 'pending'
  const timeLeft     = isExpiring ? timeLeftStr(t.expires_at) : 'No expiry after paid'
  const isCritical   = isExpiring && t.expires_at && (t.expires_at - nowSecs()) < 300

  const disputedOpen = statusLower === 'disputed' && !t.dispute_resolved
  const canComplete  = isSeller && (statusLower === 'open' || statusLower === 'paid' || disputedOpen)
  const canCancel    = statusLower === 'open' || statusLower === 'paid' || disputedOpen

  const actionButtons = [
    `<button class="btn-sm btn-open-chat" data-id="${t.id}">Open Chat</button>`,
  ]
  if (canComplete) {
    actionButtons.push(`<button class="btn-sm btn-complete-trade" data-id="${t.id}">Complete</button>`)
  }
  if (canCancel) {
    actionButtons.push(`<button class="btn-sm btn-danger btn-cancel-trade" data-id="${t.id}">Cancel</button>`)
  }

  return `
    <div class="trade-card ${isCritical ? 'trade-card-critical' : ''}" data-id="${t.id}">
      <div class="trade-card-header">
        <div class="trade-partner">
          <span class="trade-partner-avatar avatar-presence-wrap" title="${escHtml(partnerPresence.label)}">
            <img src="${escHtml(partnerAvatarPath)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />
            <span class="avatar-presence-badge presence-${escHtml(partnerPresence.state)}" aria-hidden="true"></span>
          </span>
          <div>
            <span class="trade-partner-label">${partnerLabel}</span>
            <span class="trade-partner-id" title="${escHtml(partnerUid)}">${escHtml(partnerShort)}</span>
          </div>
        </div>
        <span class="trade-status-badge ${statusClass}">${t.status}</span>
      </div>

      <div class="trade-card-body">
        <div class="trade-detail-row">
          <span class="trade-detail-label">Payment Method</span>
          <span class="trade-detail-value">${escHtml(offerName)}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">You send</span>
          <span class="trade-detail-value trade-fiat">${isBuyer ? fiatAmt : cryptoAmt}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">You receive</span>
          <span class="trade-detail-value trade-crypto">${isBuyer ? cryptoAmt : fiatAmt}</span>
        </div>
        <div class="trade-detail-row">
          <span class="trade-detail-label">${isExpiring ? 'Time Remaining' : 'Trade Timer'}</span>
          <span class="trade-countdown ${isCritical ? 'time-critical' : ''}"
                data-expires="${isExpiring ? (t.expires_at || 0) : 0}">${timeLeft}</span>
        </div>
      </div>

      <div class="trade-card-actions">
        ${actionButtons.join('')}
      </div>
    </div>
  `
}

function tickCountdowns(grid, trades) {
  grid.querySelectorAll('.trade-countdown[data-expires]').forEach(el => {
    const exp = parseInt(el.dataset.expires, 10)
    if (!exp) return
    const left = exp - nowSecs()
    el.textContent = left <= 0 ? 'Expired' : formatDuration(left)
    if (left < 300) { el.classList.add('time-critical') }
  })
}

function timeLeftStr(expiresAt) {
  if (!expiresAt) return '—'
  const left = expiresAt - nowSecs()
  return left <= 0 ? 'Expired' : formatDuration(left)
}

function formatDuration(secs) {
  if (secs <= 0) return '0:00'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}

function pad(n) { return String(n).padStart(2, '0') }
function nowSecs() { return Math.floor(Date.now() / 1000) }
function uniqSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
