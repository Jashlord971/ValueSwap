import { listTrades, getMessages, getChatReadStatuses, markChatRead } from './api.js'
import { initializeApp, getApps } from 'firebase/app'
import { getDatabase, ref, query, orderByChild, equalTo, onValue } from 'firebase/database'
import { firebaseConfig } from './firebase-config.js'

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
    // Ignore storage quota/private mode errors.
  }
}

function shortTradeId(id) {
  return String(id || '').slice(0, 8)
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
      // Audio context may be unavailable in some browsers.
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
    // Best-effort tone only.
  }
}

export function setupUnreadTradeNotifications({ user, navAuth, pollMs = 15000 }) {
  if (!user || !navAuth) return { stop() {}, markRead() {} }

  if (window.__tradeUnreadNotifier && typeof window.__tradeUnreadNotifier.stop === 'function') {
    window.__tradeUnreadNotifier.stop()
  }

  const notifiedKey = `trade:lastNotified:${user.uid}`
  const lastNotifiedByTrade = readJson(notifiedKey, {})
  // readsByTrade is the in-memory cache of DB-backed read timestamps
  let readsByTrade = {}
  let latestIncomingByTrade = {}

  const shell = document.createElement('div')
  shell.className = 'nav-notifications'
  shell.innerHTML = `
    <button id="btn-nav-bell" class="nav-bell-btn" title="Unread messages" aria-label="Unread messages" aria-expanded="false">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5"/><path d="M9 17a3 3 0 0 0 6 0"/></svg>
      <span id="nav-bell-badge" class="nav-bell-badge hidden">0</span>
    </button>
    <div id="nav-bell-panel" class="nav-bell-panel hidden">
      <div class="nav-bell-head">Unread messages</div>
      <div id="nav-bell-list" class="nav-bell-list">
        <p class="muted">No unread messages.</p>
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
  let realtimeReady = false
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

  function reconcileRealtimeTrades() {
    const merged = { ...creatorTrades, ...ownerTrades }
    const nextFingerprints = {}
    const events = []

    Object.values(merged).forEach((trade) => {
      if (!trade?.id) return
      const fp = tradeFingerprint(trade)
      nextFingerprints[trade.id] = fp

      const prevFp = knownTradeFingerprints[trade.id]
      if (!realtimeReady) return
      if (!prevFp) {
        events.push({ type: 'created', trade, previous: null })
        return
      }
      if (prevFp !== fp) {
        events.push({ type: 'updated', trade, previous: null })
      }
    })

    if (realtimeReady) {
      Object.keys(knownTradeFingerprints).forEach((tradeId) => {
        if (nextFingerprints[tradeId]) return
        events.push({ type: 'removed', trade: { id: tradeId }, previous: null })
      })
    }

    knownTradeFingerprints = nextFingerprints
    if (!realtimeReady) {
      realtimeReady = true
      return
    }

    let hadTradeChange = false
    events.forEach((evt) => {
      hadTradeChange = true
      publishTradeRealtimeEvent(evt.type, evt.trade, evt.previous)
      if (evt.type === 'created' || evt.type === 'updated') {
        playTradeNotificationTone(evt.type)
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

    const attach = (q, assign) => onValue(q, (snap) => {
      const val = snap.val() || {}
      const rows = {}
      Object.entries(val).forEach(([id, t]) => {
        rows[id] = { ...(t || {}), id: t?.id || id }
      })
      assign(rows)
      reconcileRealtimeTrades()
    })

    creatorUnsub = attach(creatorQ, (rows) => { creatorTrades = rows })
    ownerUnsub = attach(ownerQ, (rows) => { ownerTrades = rows })
  }

  function persistNotified() {
    writeJson(notifiedKey, lastNotifiedByTrade)
  }

  function markRead(tradeId, atTs) {
    if (!tradeId) return
    const ts = Number(atTs || latestIncomingByTrade[tradeId] || Math.floor(Date.now() / 1000))
    // Optimistically update in-memory cache for instant UI response
    readsByTrade[tradeId] = ts
    // Persist to DB (fire-and-forget)
    markChatRead(tradeId).catch(() => {})
  }

  function render(items, totalUnreadMessages) {
    if (totalUnreadMessages > 0) {
      badge.textContent = unreadLabel(totalUnreadMessages)
      badge.classList.remove('hidden')
    } else {
      badge.classList.add('hidden')
    }

    if (!items.length) {
      listEl.innerHTML = '<p class="muted">No unread messages.</p>'
      return
    }

    listEl.innerHTML = items.map((item) => {
      const tradeId = item.trade.id
      const displayUnread = item.unreadCount > 99 ? '99+' : String(item.unreadCount)
      const statusClass = CLOSED_STATUSES.has(item.trade.status) ? 'nav-bell-item-status-closed' : 'nav-bell-item-status-open'
      return `
        <a href="/trade-detail.html?id=${encodeURIComponent(tradeId)}" class="nav-bell-item" data-trade-id="${tradeId}">
          <div class="nav-bell-item-top">
            <span class="nav-bell-item-title">Trade #${shortTradeId(tradeId)}...</span>
            <span class="nav-bell-item-count">${displayUnread}</span>
          </div>
          <div class="nav-bell-item-meta">
            <span class="${statusClass}">${item.trade.status}</span>
            <span>${new Date(item.latestIncomingTs * 1000).toLocaleString()}</span>
          </div>
        </a>
      `
    }).join('')

    listEl.querySelectorAll('.nav-bell-item').forEach((a) => {
      a.addEventListener('click', () => {
        const tradeId = a.getAttribute('data-trade-id')
        markRead(tradeId)
      })
    })
  }

  function desktopNotify(items) {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return

    items.forEach((item) => {
      const tradeId = item.trade.id
      const lastNotified = Number(lastNotifiedByTrade[tradeId] || 0)
      if (item.latestIncomingTs <= lastNotified) return
      if (item.latestIncomingTs <= Number(readsByTrade[tradeId] || 0)) return

      lastNotifiedByTrade[tradeId] = item.latestIncomingTs
      const n = new Notification('New trade message', {
        body: `Trade #${shortTradeId(tradeId)}... has ${item.unreadCount} unread message${item.unreadCount === 1 ? '' : 's'}.`,
        tag: `trade-${tradeId}`,
      })
      n.onclick = () => {
        window.focus()
        markRead(tradeId)
        window.location.href = `/trade-detail.html?id=${encodeURIComponent(tradeId)}`
      }
    })

    persistNotified()
  }

  async function refresh() {
    if (running) return
    running = true
    try {
      // Fetch read statuses from DB and active trades in parallel
      const [dbReads, trades] = await Promise.all([
        getChatReadStatuses().catch(() => ({})),
        listTrades(),
      ])
      // Merge DB reads into in-memory cache (DB wins over optimistic local values)
      Object.assign(readsByTrade, dbReads)

      const byTrade = await Promise.all(
        trades.map(async (trade) => {
          try {
            const msgs = await getMessages(trade.id)
            const incoming = msgs.filter((m) => m.sender_uid !== user.uid)
            const readTs = Number(readsByTrade[trade.id] || 0)
            const unread = incoming.filter((m) => Number(m.created_at || 0) > readTs)
            const latestIncomingTs = unread.length
              ? Math.max(...unread.map((m) => Number(m.created_at || 0)))
              : (incoming.length ? Math.max(...incoming.map((m) => Number(m.created_at || 0))) : 0)

            latestIncomingByTrade[trade.id] = latestIncomingTs

            return {
              trade,
              unreadCount: unread.length,
              latestIncomingTs,
            }
          } catch {
            return { trade, unreadCount: 0, latestIncomingTs: 0 }
          }
        })
      )

      const unreadItems = byTrade
        .filter((item) => item.unreadCount > 0)
        .sort((a, b) => b.latestIncomingTs - a.latestIncomingTs)

      const totalUnreadMessages = unreadItems.reduce((sum, item) => sum + item.unreadCount, 0)
      render(unreadItems, totalUnreadMessages)
      desktopNotify(unreadItems)
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
      shell.remove()
    },
  }

  window.__tradeUnreadNotifier = api
  return api
}
