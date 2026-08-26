import { listTrades, getMessages, markChatRead } from './api.js'
import { initializeApp, getApps } from 'firebase/app'
import { getDatabase, ref, query, orderByChild, equalTo, onValue } from 'firebase/database'
import { firebaseConfig } from './firebase-config.js'
import { playNotifySound } from './sound.js'

const CLOSED_STATUSES = new Set(['completed', 'cancelled', 'expired'])

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {

  }
}

function shortTradeId(id) {
  return String(id || '').slice(0, 8)
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function prettifyPaymentMethodId(raw) {
  return String(raw || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function closeTradePopupModal() {
  document.getElementById('trade-popup-modal-overlay')?.remove()
}

function showIncomingTradePopupModal(trade) {
  if (!trade?.id) return

  playNotifySound()
  closeTradePopupModal()
  const overlay = document.createElement('div')
  overlay.id = 'trade-popup-modal-overlay'
  overlay.className = 'modal-overlay'
  const fiat = Number.isFinite(Number(trade.fiat_amount))
    ? `${escapeHtml(trade.currency || 'USD')} ${Number(trade.fiat_amount).toFixed(2)}`
    : '—'
  const crypto = Number.isFinite(Number(trade.crypto_amount))
    ? `${Number(trade.crypto_amount).toFixed(6)} ${escapeHtml(trade.coin || '')}`
    : '—'
  const payment = prettifyPaymentMethodId(trade.card || '—')
  const type = String(trade.offer_type || '').toLowerCase() === 'buy' ? 'Buy' : 'Sell'
  const created = Number(trade.created_at || 0) > 0
    ? new Date(Number(trade.created_at) * 1000).toLocaleString()
    : new Date().toLocaleString()

  overlay.innerHTML = `
    <div class="modal wallet-action-modal" style="max-width:520px;">
      <div class="modal-header">
        <h2>New Trade Opened</h2>
        <button class="btn-modal-close" aria-label="Close">✕</button>
      </div>
      <p class="muted" style="margin-top:0.6rem;">A new trade was just opened with you.</p>
      <div style="margin-top:0.9rem;display:grid;grid-template-columns:1fr 1fr;gap:0.6rem 1rem;">
        <div><span class="muted">Trade</span><div>#${escapeHtml(shortTradeId(trade.id))}</div></div>
        <div><span class="muted">Type</span><div>${escapeHtml(type)}</div></div>
        <div><span class="muted">Payment Method</span><div>${escapeHtml(payment)}</div></div>
        <div><span class="muted">Status</span><div style="text-transform:capitalize;">${escapeHtml(trade.status || 'open')}</div></div>
        <div><span class="muted">Fiat</span><div>${fiat}</div></div>
        <div><span class="muted">Crypto</span><div>${crypto}</div></div>
      </div>
      <p class="muted" style="margin-top:0.8rem;">Opened: ${escapeHtml(created)}</p>
      <div class="confirm-modal-actions" style="margin-top:1rem;">
        <button class="btn-cancel" id="trade-popup-dismiss">Dismiss</button>
        <a class="btn btn-success" id="trade-popup-open" href="/trade-detail.html?id=${encodeURIComponent(trade.id)}">Open Trade</a>
      </div>
    </div>
  `

  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeTradePopupModal()
  })
  overlay.querySelector('.btn-modal-close')?.addEventListener('click', closeTradePopupModal)
  overlay.querySelector('#trade-popup-dismiss')?.addEventListener('click', closeTradePopupModal)
}

const TX_KIND_LABEL = {
  internal_transfer: 'internal transfer',
  deposit: 'on-chain deposit',
  trade: 'trade payout',
}

function closeTransactionPopupModal() {
  document.getElementById('transaction-popup-modal-overlay')?.remove()
}

function showIncomingTransactionPopupModal(tx) {
  if (!tx?.id) return

  playNotifySound()
  closeTransactionPopupModal()
  const overlay = document.createElement('div')
  overlay.id = 'transaction-popup-modal-overlay'
  overlay.className = 'modal-overlay'
  const amount = Number.isFinite(Number(tx.amount)) ? Number(tx.amount).toFixed(8) : '—'
  const kindLabel = TX_KIND_LABEL[tx.kind] || tx.kind || 'transaction'

  overlay.innerHTML = `
    <div class="modal wallet-action-modal" style="max-width:460px;">
      <div class="modal-header">
        <h2>Money Received</h2>
        <button class="btn-modal-close" aria-label="Close">✕</button>
      </div>
      <p class="muted" style="margin-top:0.6rem;">You just received a ${escapeHtml(kindLabel)}.</p>
      <p style="margin-top:0.9rem;font-size:1.1rem;">
        <strong>${amount} ${escapeHtml(tx.coin || '')}</strong>
      </p>
      <div class="confirm-modal-actions" style="margin-top:1rem;">
        <button class="btn-cancel" id="transaction-popup-dismiss">Dismiss</button>
        <a class="btn btn-success" id="transaction-popup-open" href="/transactions.html">View Transactions</a>
      </div>
    </div>
  `

  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeTransactionPopupModal()
  })
  overlay.querySelector('.btn-modal-close')?.addEventListener('click', closeTransactionPopupModal)
  overlay.querySelector('#transaction-popup-dismiss')?.addEventListener('click', closeTransactionPopupModal)
}

function unreadLabel(total) {
  return total > 99 ? '99+' : String(total)
}

function getFirebaseApp() {
  return getApps()[0] || initializeApp(firebaseConfig)
}

function tradeFingerprint(trade) {
  const feedbackCount = Array.isArray(trade?.feedback) ? trade.feedback.length : 0
  return [
    trade?.status,
    trade?.expires_at,
    trade?.cancel_reason || '',
    trade?.escrow_released ? 1 : 0,
    feedbackCount,
    trade?.fiat_amount,
    trade?.crypto_amount,
    trade?.created_at,
  ].join('|')
}

let audioCtx = null
let audioArmed = false

function armAudioOnUserGesture() {
  if (audioArmed) return
  audioArmed = true
  window.addEventListener('pointerdown', () => {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      if (audioCtx.state === 'suspended') audioCtx.resume()
    } catch {

    }
  }, { once: true })
}

function playTradeNotificationTone(kind = 'update') {
  try {
    if (!audioCtx || audioCtx.state !== 'running') return

    const now = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    const freq = kind === 'created' ? 1046.5 : 880

    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, now)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)

    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start(now)
    osc.stop(now + 0.2)
  } catch {

  }
}

export function setupUnreadTradeNotifications({ user, navAuth, pollMs = 15000 }) {
  if (!user || !navAuth) return { stop() {}, markRead() {} }

  if (window.__tradeUnreadNotifier && typeof window.__tradeUnreadNotifier.stop === 'function') {
    window.__tradeUnreadNotifier.stop()
  }

  const notifiedKey = `trade:lastNotified:${user.uid}`
  const popupNotifiedKey = `trade:lastPopupNotified:${user.uid}`
  const seenTradeStateKey = `trade:seenState:${user.uid}`
  const seenMessageActivityKey = `trade:seenMessage:${user.uid}`
  const lastNotifiedByTrade = readJson(notifiedKey, {})
  const popupNotifiedByTrade = readJson(popupNotifiedKey, {})
  const seenTradeStateByTrade = readJson(seenTradeStateKey, {})
  const seenMessageActivityByTrade = readJson(seenMessageActivityKey, {})
  let latestIncomingByTrade = {}
  let notificationsHydrated = false

  const shell = document.createElement('div')
  shell.className = 'nav-notifications'
  shell.innerHTML = `
    <button id="btn-nav-bell" class="nav-bell-btn" title="Notifications" aria-label="Notifications" aria-expanded="false">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5"/><path d="M9 17a3 3 0 0 0 6 0"/></svg>
      <span id="nav-bell-badge" class="nav-bell-badge hidden">0</span>
    </button>
    <div id="nav-bell-panel" class="nav-bell-panel hidden">
      <div class="nav-bell-head">Notifications</div>
      <div id="nav-bell-list" class="nav-bell-list">
        <p class="muted">No notifications.</p>
      </div>
    </div>
  `

  const profileLink = navAuth.querySelector('.nav-profile-link')
  if (profileLink) navAuth.insertBefore(shell, profileLink)
  else navAuth.prepend(shell)

  const bellBtn = shell.querySelector('#btn-nav-bell')
  const badge = shell.querySelector('#nav-bell-badge')
  const panel = shell.querySelector('#nav-bell-panel')
  const listEl = shell.querySelector('#nav-bell-list')

  let timer = null
  let running = false
  let creatorUnsub = null
  let ownerUnsub = null

  let creatorReady = false
  let ownerReady = false
  let creatorTrades = {}
  let ownerTrades = {}
  let knownTradeFingerprints = {}

  function publishTradeRealtimeEvent(type, trade, previous) {
    if (!trade?.id) return
    document.dispatchEvent(new CustomEvent('trade-realtime', {
      detail: { type, trade, previous },
    }))

    if (type === 'created' || type === 'updated') {
      document.dispatchEvent(new CustomEvent('trade-updated', {
        detail: { trade, type, previous },
      }))
    }
  }

  function maybeShowIncomingTradePopup(trade) {
    if (!trade?.id) return

    if (String(trade.creator_uid || '') === String(user.uid)) return

    if (String(trade.status || '').toLowerCase() !== 'open') return
    const tradeId = String(trade.id)
    const ts = Number(trade.created_at || Math.floor(Date.now() / 1000))
    const seenTs = Number(popupNotifiedByTrade[tradeId] || 0)
    if (ts <= seenTs) return
    popupNotifiedByTrade[tradeId] = ts
    persistPopupNotified()
    showIncomingTradePopupModal(trade)
  }

  function reconcileRealtimeTrades() {
    const bothReady = creatorReady && ownerReady
    const merged = { ...creatorTrades, ...ownerTrades }
    const nextFingerprints = {}
    const events = []

    Object.values(merged).forEach((trade) => {
      if (!trade?.id) return
      const fp = tradeFingerprint(trade)
      nextFingerprints[trade.id] = fp

      if (!bothReady) return
      const prevFp = knownTradeFingerprints[trade.id]
      if (!prevFp) {
        events.push({ type: 'created', trade, previous: null })
        return
      }
      if (prevFp !== fp) {
        events.push({ type: 'updated', trade, previous: null })
      }
    })

    if (bothReady) {
      Object.keys(knownTradeFingerprints).forEach((tradeId) => {
        if (nextFingerprints[tradeId]) return
        events.push({ type: 'removed', trade: { id: tradeId }, previous: null })
      })
    }

    knownTradeFingerprints = nextFingerprints
    if (!bothReady) return

    let hadTradeChange = false
    events.forEach((evt) => {
      hadTradeChange = true
      publishTradeRealtimeEvent(evt.type, evt.trade, evt.previous)
      if (evt.type === 'created' || evt.type === 'updated') {
        playTradeNotificationTone(evt.type)
      }
      if (evt.type === 'created') {

        maybeShowIncomingTradePopup(evt.trade)
      }
    })

    if (hadTradeChange) {
      refresh()
    }
  }

  function startRealtimeTradeWatch() {
    armAudioOnUserGesture()
    const db = getDatabase(getFirebaseApp())

    const creatorQ = query(ref(db, 'trades'), orderByChild('creator_uid'), equalTo(user.uid))
    const ownerQ = query(ref(db, 'trades'), orderByChild('offer_owner_uid'), equalTo(user.uid))

    const attach = (q, assign, markReady) => onValue(
      q,
      (snap) => {
        const val = snap.val() || {}
        const rows = {}
        Object.entries(val).forEach(([id, t]) => {
          rows[id] = { ...(t || {}), id: t?.id || id }
        })
        assign(rows)
        markReady()
        reconcileRealtimeTrades()
      },
      (err) => {
        console.error('Trade realtime listener failed; falling back to polling only:', err)
      },
    )

    creatorUnsub = attach(creatorQ, (rows) => { creatorTrades = rows }, () => { creatorReady = true })
    ownerUnsub = attach(ownerQ, (rows) => { ownerTrades = rows }, () => { ownerReady = true })
  }

  function startTransactionWatch() {
    armAudioOnUserGesture()
    const db = getDatabase(getFirebaseApp())
    let hydrated = false
    const knownIds = new Set()

    onValue(
      ref(db, `transactions/${user.uid}`),
      (snap) => {
        const val = snap.val() || {}
        const entries = Object.entries(val).map(([id, tx]) => ({ ...(tx || {}), id: tx?.id || id }))

        if (!hydrated) {
          entries.forEach((tx) => knownIds.add(tx.id))
          hydrated = true
          return
        }

        entries.forEach((tx) => {
          if (knownIds.has(tx.id)) return
          knownIds.add(tx.id)
          if (tx.direction !== 'in') return
          playTradeNotificationTone('created')
          showIncomingTransactionPopupModal(tx)
        })
      },
      (err) => {
        console.error('Transaction realtime listener failed:', err)
      },
    )
  }

  function persistNotified() {
    writeJson(notifiedKey, lastNotifiedByTrade)
  }

  function persistPopupNotified() {
    writeJson(popupNotifiedKey, popupNotifiedByTrade)
  }

  function persistSeenTradeState() {
    writeJson(seenTradeStateKey, seenTradeStateByTrade)
  }

  function persistSeenMessageActivity() {
    writeJson(seenMessageActivityKey, seenMessageActivityByTrade)
  }

  function summarizeTradeNotification(trade, isNewTrade) {
    if (isNewTrade) return 'Trade started'

    const status = String(trade?.status || '').toLowerCase()
    if (status === 'paid') return 'Trade marked as paid'
    if (status === 'completed') return 'Trade completed'
    if (status === 'cancelled') return 'Trade cancelled'
    if (status === 'disputed') return 'Trade disputed'
    if (status === 'expired') return 'Trade expired'
    if (status === 'pending') return 'Trade pending'
    return 'Trade updated'
  }

  function markRead(tradeId, options = {}) {
    if (!tradeId) return
    const ts = Number(options.messageTs || latestIncomingByTrade[tradeId] || 0)
    if (ts > 0) {
      markChatRead(tradeId).catch(() => {})
    }

    const activityTs = Number(options.messageActivityTs || options.messageTs || 0)
    if (activityTs > 0) {
      seenMessageActivityByTrade[tradeId] = activityTs
      persistSeenMessageActivity()
    }

    const currentFingerprint = options.tradeFingerprint || knownTradeFingerprints[tradeId]
    if (currentFingerprint) {
      seenTradeStateByTrade[tradeId] = currentFingerprint
      persistSeenTradeState()
    }
  }

  function render(items, totalNotifications) {
    if (totalNotifications > 0) {
      badge.textContent = unreadLabel(totalNotifications)
      badge.classList.remove('hidden')
    } else {
      badge.classList.add('hidden')
    }

    if (!items.length) {
      listEl.innerHTML = '<p class="muted">No notifications.</p>'
      return
    }

    listEl.innerHTML = items.map((item) => {
      const tradeId = item.trade.id
      const displayUnread = item.unreadCount > 99 ? '99+' : String(item.unreadCount)
      const statusClass = CLOSED_STATUSES.has(item.trade.status) ? 'nav-bell-item-status-closed' : 'nav-bell-item-status-open'
      return `
        <a href="/trade-detail.html?id=${encodeURIComponent(tradeId)}" class="nav-bell-item" data-trade-id="${tradeId}">
          <div class="nav-bell-item-top">
            <span class="nav-bell-item-title">${item.title}</span>
            ${item.unreadCount > 0 ? `<span class="nav-bell-item-count">${displayUnread}</span>` : ''}
          </div>
          <div class="nav-bell-item-meta">
            <span class="${statusClass}">${item.trade.status}</span>
            <span>${item.subtitle}</span>
          </div>
          <div class="nav-bell-item-meta">
            <span>${new Date(item.timestamp * 1000).toLocaleString()}</span>
          </div>
        </a>
      `
    }).join('')

    listEl.querySelectorAll('.nav-bell-item').forEach((a) => {
      a.addEventListener('click', () => {
        const tradeId = a.getAttribute('data-trade-id')
        const item = items.find((entry) => String(entry.trade.id) === String(tradeId))
        markRead(tradeId, {
          messageTs: item?.latestIncomingTs,
          messageActivityTs: item?.latestAnyMessageTs,
          tradeFingerprint: item?.tradeFingerprint,
        })
      })
    })
  }

  function desktopNotify(items) {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return

    items.forEach((item) => {
      const tradeId = item.trade.id
      const lastNotified = Number(lastNotifiedByTrade[tradeId] || 0)
      if (item.timestamp <= lastNotified) return

      lastNotifiedByTrade[tradeId] = item.timestamp
      const n = new Notification(item.title, {
        body: item.subtitle,
        tag: `trade-${tradeId}`,
      })
      n.onclick = () => {
        window.focus()
        markRead(tradeId, {
          messageTs: item.latestIncomingTs,
          messageActivityTs: item.latestAnyMessageTs,
          tradeFingerprint: item.tradeFingerprint,
        })
        window.location.href = `/trade-detail.html?id=${encodeURIComponent(tradeId)}`
      }
    })

    persistNotified()
  }

  async function refresh() {
    if (running) return
    running = true
    try {
      const trades = await listTrades()

      const byTrade = await Promise.all(
        trades.map(async (trade) => {
          try {
            const msgs = await getMessages(trade.id)
            const latestMessage = msgs.reduce((latest, message) => {
              return Number(message?.created_at || 0) > Number(latest?.created_at || 0) ? message : latest
            }, null)
            const incoming = msgs.filter((m) => m.sender_uid !== user.uid)
            const unread = incoming.filter((m) => String(m.read_by_uid || '') !== String(user.uid))
            const latestIncomingTs = unread.length
              ? Math.max(...unread.map((m) => Number(m.created_at || 0)))
              : (incoming.length ? Math.max(...incoming.map((m) => Number(m.created_at || 0))) : 0)
            const latestAnyMessageTs = msgs.length
              ? Math.max(...msgs.map((m) => Number(m.created_at || 0)))
              : 0

            latestIncomingByTrade[trade.id] = latestIncomingTs

            return {
              trade,
              unreadCount: unread.length,
              latestIncomingTs,
              latestAnyMessageTs,
              latestMessageSenderUid: latestMessage?.sender_uid || null,
            }
          } catch {
            return { trade, unreadCount: 0, latestIncomingTs: 0, latestAnyMessageTs: 0, latestMessageSenderUid: null }
          }
        })
      )

      const notificationItems = []

      byTrade.forEach((item) => {
        const tradeId = item.trade.id
        const currentFingerprint = tradeFingerprint(item.trade)
        const seenFingerprint = seenTradeStateByTrade[tradeId]
        const seenMessageActivityTs = Number(seenMessageActivityByTrade[tradeId] || 0)

        if (!notificationsHydrated && !seenFingerprint) {
          seenTradeStateByTrade[tradeId] = currentFingerprint
          if (item.latestAnyMessageTs > 0 && !seenMessageActivityTs) {
            seenMessageActivityByTrade[tradeId] = item.latestAnyMessageTs
          }
        } else if (notificationsHydrated && seenFingerprint !== currentFingerprint) {
          const isNewTrade = !seenFingerprint
          notificationItems.push({
            kind: 'trade',
            trade: item.trade,
            unreadCount: 0,
            latestIncomingTs: item.latestIncomingTs,
            latestAnyMessageTs: item.latestAnyMessageTs,
            timestamp: Number(item.trade.created_at || item.latestAnyMessageTs || Math.floor(Date.now() / 1000)),
            title: summarizeTradeNotification(item.trade, isNewTrade),
            subtitle: `Trade #${shortTradeId(tradeId)} is now ${String(item.trade.status || 'updated')}.`,
            tradeFingerprint: currentFingerprint,
            isNewTrade,
          })
        }

        if (notificationsHydrated && item.latestAnyMessageTs > seenMessageActivityTs && item.unreadCount === 0) {
          const sentByCurrentUser = String(item.latestMessageSenderUid || '') === String(user.uid)
          notificationItems.push({
            kind: 'message-activity',
            trade: item.trade,
            unreadCount: 0,
            latestIncomingTs: item.latestIncomingTs,
            latestAnyMessageTs: item.latestAnyMessageTs,
            timestamp: item.latestAnyMessageTs,
            title: sentByCurrentUser ? 'Message sent' : 'New message',
            subtitle: `Trade #${shortTradeId(tradeId)} has new message activity.`,
            tradeFingerprint: currentFingerprint,
          })
        }

        if (item.unreadCount > 0) {
          notificationItems.push({
            kind: 'message',
            trade: item.trade,
            unreadCount: item.unreadCount,
            latestIncomingTs: item.latestIncomingTs,
            latestAnyMessageTs: item.latestAnyMessageTs,
            timestamp: item.latestIncomingTs,
            title: item.unreadCount === 1 ? 'New message' : 'New messages',
            subtitle: `Trade #${shortTradeId(tradeId)} has ${item.unreadCount} unread message${item.unreadCount === 1 ? '' : 's'}.`,
            tradeFingerprint: currentFingerprint,
          })
        }
      })

      notificationsHydrated = true
      persistSeenTradeState()
      persistSeenMessageActivity()

      const sortedItems = notificationItems.sort((a, b) => b.timestamp - a.timestamp)
      const totalNotifications = sortedItems.reduce((sum, item) => sum + (item.kind === 'message' ? item.unreadCount : 1), 0)
      render(sortedItems, totalNotifications)
      desktopNotify(sortedItems)

      sortedItems
        .filter((item) => item.kind === 'trade' && item.isNewTrade)
        .forEach((item) => maybeShowIncomingTradePopup(item.trade))
    } finally {
      running = false
    }
  }

  const onBellClick = (e) => {
    e.stopPropagation()
    const hidden = panel.classList.contains('hidden')
    panel.classList.toggle('hidden', !hidden)
    bellBtn.setAttribute('aria-expanded', hidden ? 'true' : 'false')
  }

  const onDocumentClick = (e) => {
    if (!shell.contains(e.target)) {
      panel.classList.add('hidden')
      bellBtn.setAttribute('aria-expanded', 'false')
    }
  }

  const onOpenChat = (e) => {
    const tradeId = e?.detail?.tradeId
    if (!tradeId) return
    markRead(tradeId)
    refresh()
  }

  bellBtn.addEventListener('click', onBellClick)
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('open-chat', onOpenChat)

  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }

  refresh()
  timer = setInterval(refresh, pollMs)
  startRealtimeTradeWatch()
  startTransactionWatch()

  const api = {
    markRead,
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      if (creatorUnsub) creatorUnsub()
      if (ownerUnsub) ownerUnsub()
      creatorUnsub = null
      ownerUnsub = null
      bellBtn.removeEventListener('click', onBellClick)
      document.removeEventListener('click', onDocumentClick)
      document.removeEventListener('open-chat', onOpenChat)
      closeTradePopupModal()
      shell.remove()
    },
  }

  window.__tradeUnreadNotifier = api
  return api
}
