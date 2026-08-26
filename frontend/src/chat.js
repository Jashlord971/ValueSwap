import {
  getChatSync,
  sendMessage,
  leaveTradeFeedback,
  editTradeFeedback,
  markChatRead,
} from './api.js'
import { showAlert, showFeedbackModal } from './modal.js'
import { playNotifySound, primeNotifySound } from './sound.js'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import {
  getDatabase,
  ref,
  query,
  orderByChild,
  startAt,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onValue,
} from 'firebase/database'
import {
  isActiveFromLastActive,
  formatPresenceLastSeen,
  PARTNER_PRESENCE_RECALC_INTERVAL_MS,
} from './presence.js'

let activeTradeId    = null
let pollTimer        = null
let currentUid       = null
let partnerUsername  = null
let activeTrade      = null
let initialized      = false
let lastRenderedTradeId = null
let lastRenderKey    = null
let shouldScrollToBottom = false
let readStatuses     = {}
let partnerReceiptStatus = { last_delivered_at: 0, last_read_at: 0 }
let partnerPresence = { active: false, lastActiveAt: 0 }
let tradeOpenInSync = true
let pendingMediaType = null
let pendingVisibility = 'everyone'
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024
const MAX_MESSAGES_AFTER_DISPUTE = 10
let authWatcherBound = false
const markReadInFlight = new Map()
let pollInFlight = false
let chatCursorTs = 0
let chatMessageCache = []
let chatFirebaseApp = null
let chatRealtimeActive = false
let stopChatRealtimeListeners = null
let presenceRecalcTimer = null

const recentSentImages = new Map()
const CLOSED_TRADE_STATUSES = new Set(['completed', 'cancelled', 'expired'])
const EXPIRES_WITH_TIME_STATUSES = new Set(['open', 'pending'])

export function initChat(firebaseApp, uid) {
  chatFirebaseApp = firebaseApp || chatFirebaseApp
  currentUid = uid || currentUid || getAuth(firebaseApp).currentUser?.uid || null
  primeNotifySound()

  if (!authWatcherBound) {
    authWatcherBound = true
    onAuthStateChanged(getAuth(firebaseApp), (user) => {
      if (user?.uid) currentUid = user.uid
    })
  }

  if (initialized) return
  initialized = true

  if (!presenceRecalcTimer) {
    presenceRecalcTimer = setInterval(() => {
      if (!activeTradeId) return
      refreshPartnerPresenceState()
    }, PARTNER_PRESENCE_RECALC_INTERVAL_MS)
  }

  document.addEventListener('open-chat', (e) => {
    stopRealtimeChatListeners()
    activeTradeId   = e.detail.tradeId
    partnerUsername = e.detail.partnerUsername || null
    activeTrade     = e.detail.trade || null
    shouldScrollToBottom = true
    lastRenderKey = null
    partnerReceiptStatus = { last_delivered_at: 0, last_read_at: 0 }
    partnerPresence = { active: false, lastActiveAt: 0 }
    tradeOpenInSync = isTradeOpenStatus(activeTrade?.status, activeTrade?.expires_at)
    chatCursorTs = 0
    chatMessageCache = []
    readStatuses = {}
    clearChatPollTimer()
    loadMessages().finally(() => {
      if (!startRealtimeChatListeners()) {
        scheduleNextChatPoll()
      }
    })
  })

  document.addEventListener('trade-updated', (e) => {
    const trade = e?.detail?.trade
    if (!trade?.id || !activeTradeId) return
    if (String(trade.id) !== String(activeTradeId)) return
    activeTrade = trade
    tradeOpenInSync = tradeOpenInSync && isTradeOpenStatus(activeTrade?.status, activeTrade?.expires_at)
    loadMessages().finally(() => {
      if (!chatRealtimeActive) scheduleNextChatPoll()
    })
  })

  document.addEventListener('visibilitychange', () => {
    if (!activeTradeId) return
    if (chatRealtimeActive) return
    scheduleNextChatPoll()
  })
  window.addEventListener('focus', () => {
    if (!activeTradeId) return
    if (chatRealtimeActive) return
    scheduleNextChatPoll()
  })
  window.addEventListener('blur', () => {
    if (!activeTradeId) return
    if (chatRealtimeActive) return
    scheduleNextChatPoll()
  })

  const chatMessages = document.getElementById('chat-messages')
  if (chatMessages) {
    chatMessages.addEventListener('click', async (e) => {
      const placeholder = e.target.closest('.bubble-image-placeholder')
      if (!placeholder) return
      const url = decodeURIComponent(placeholder.dataset.imageUrl || '')
      const tradeId = placeholder.dataset.tradeId
      if (!url || !tradeId) return

      let media
      if (placeholder.dataset.mediaType === 'video') {
        media = document.createElement('video')
        media.className = 'bubble-image'
        media.src = url
        media.controls = true
      } else {
        media = document.createElement('img')
        media.className = 'bubble-image'
        media.alt = 'Shared image'
        media.src = url
      }
      placeholder.replaceWith(media)

      const ts = Math.floor(Date.now() / 1000)
      readStatuses[tradeId] = ts
      markChatRead(tradeId).catch(() => {})
    })
  }

  const sendBtn  = document.getElementById('btn-send-msg')
  const chatText = document.getElementById('chat-text')
  if (sendBtn)  sendBtn.addEventListener('click', handleSend)
  if (chatText) chatText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  })

  document.addEventListener('change', (e) => {
    if (e.target.id !== 'chat-image-input') return
    const file = e.target.files[0]
    console.log('[chat] file selected:', file?.name, file?.size, 'bytes', file?.type)
    const preview = document.getElementById('chat-image-preview')
    if (!preview) return

    if (!file) {
      clearMediaPreview(preview)
      return
    }

    if (file.size > MAX_ATTACHMENT_BYTES) {
      showAlert(`That file is too large. Attachments must be under ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB.`)
      e.target.value = ''
      clearMediaPreview(preview)
      return
    }

    pendingMediaType = file.type.startsWith('video/') ? 'video' : 'image'
    pendingVisibility = 'everyone'

    const localUrl = URL.createObjectURL(file)
    const mediaTag = pendingMediaType === 'video'
      ? `<video src="${localUrl}" class="chat-image-preview-thumb" muted></video>`
      : `<img src="${localUrl}" class="chat-image-preview-thumb" alt="Preview" />`

    preview.innerHTML = `
      ${mediaTag}
      <div class="chat-media-visibility">
        <label><input type="radio" name="chat-media-visibility" value="everyone" checked /> Visible to entire chat</label>
        <label><input type="radio" name="chat-media-visibility" value="moderator_only" /> Only moderator can see this</label>
      </div>`
    preview.dataset.localUrl = localUrl
    preview.querySelectorAll('input[name="chat-media-visibility"]').forEach((input) => {
      input.addEventListener('change', () => { pendingVisibility = input.value })
    })
  })
}

function clearMediaPreview(preview) {
  preview.innerHTML = ''
  if (preview.dataset.localUrl) URL.revokeObjectURL(preview.dataset.localUrl)
  delete preview.dataset.localUrl
  pendingMediaType = null
  pendingVisibility = 'everyone'
}

function messagesSentSinceDisputeCount() {
  if (String(activeTrade?.status || '') !== 'disputed') return 0
  const raisedAt = Number(activeTrade?.dispute_raised_at || 0)
  if (!raisedAt) return 0
  return chatMessageCache.filter(m => m.sender_uid === currentUid && Number(m.created_at || 0) >= raisedAt).length
}

async function handleSend() {
  if (!activeTradeId) return
  if (isChatClosed()) {
    stopRealtimeChatListeners();
    clearChatPollTimer();
    syncChatInputState();
    return
  }
  if (messagesSentSinceDisputeCount() >= MAX_MESSAGES_AFTER_DISPUTE) {
    syncChatInputState()
    return
  }

  const textInput  = document.getElementById('chat-text')
  const fileInput  = document.getElementById('chat-image-input')
  const text       = textInput.value.trim()
  const mediaFile  = fileInput.files[0]
  let   imageUrl   = null

  if (!text && !mediaFile) return

  const btn = document.getElementById('btn-send-msg')
  btn.disabled = true
  try {
    const mediaType = pendingMediaType
    const visibility = pendingVisibility
    if (mediaFile) {

      const preview = document.getElementById('chat-image-preview')
      const localUrl = preview?.dataset.localUrl || null
      console.log('[chat] preparing media:', mediaFile.name, mediaType)
      imageUrl = mediaType === 'video' ? await uploadChatVideo(mediaFile) : await uploadChatImage(mediaFile)
      console.log('[chat] media ready, size:', Math.round(imageUrl.length / 1024), 'KB')
      if (localUrl) recentSentImages.set(imageUrl, localUrl)
    }
    console.log('[chat] sending message to backend, tradeId:', activeTradeId, 'imageUrl:', imageUrl)
    await sendMessage(activeTradeId, text || null, imageUrl, mediaFile ? mediaType : null, mediaFile ? visibility : null)
    console.log('[chat] message sent successfully')
    playNotifySound()
    textInput.value  = ''
    fileInput.value  = ''

    const preview = document.getElementById('chat-image-preview')
    if (preview) clearMediaPreview(preview)
    shouldScrollToBottom = true
    await loadMessages()
  } catch (e) {
    showAlert('Send failed: ' + e.message)
  } finally {
    btn.disabled = false
  }
}

async function loadMessages() {
  if (!activeTradeId) return
  try {
    const sync = await getChatSync(activeTradeId, chatCursorTs, shouldPingPresenceHeartbeat())
    partnerReceiptStatus = {
      last_delivered_at: Number(sync?.partner_receipt?.last_delivered_at || 0),
      last_read_at: Number(sync?.partner_receipt?.last_read_at || 0),
    }
    const partnerLastActiveAt = Number(sync?.partner_last_active_at || 0)
    partnerPresence = {
      active: isPartnerActiveFromLastActive(partnerLastActiveAt),
      lastActiveAt: partnerLastActiveAt,
    }
    tradeOpenInSync = sync?.trade_open !== false
    if (!tradeOpenInSync) {
      stopRealtimeChatListeners()
      clearChatPollTimer()
    }

    const incoming = Array.isArray(sync?.messages) ? sync.messages : []
    if (incoming.length) {
      chatMessageCache = mergeMessagesById(chatMessageCache, incoming)
      chatCursorTs = Math.max(chatCursorTs, ...incoming.map(m => Number(m.created_at || 0)))
    }
    renderChatFromState()
  } catch (e) {
    const container = document.getElementById('chat-messages')
    container.innerHTML = `<p class="error">Could not load messages: ${e.message}</p>`
  }
}

function renderChatFromState() {
  if (!activeTradeId) return
  const container = document.getElementById('chat-messages')
  if (!container) return

  if (isChatClosed()) {
    stopRealtimeChatListeners()
    clearChatPollTimer()
  }

  const isNewTrade = lastRenderedTradeId !== activeTradeId
  const wasNearBottom = isNewTrade || isScrolledNearBottom(container)
  const sorted = [...chatMessageCache].sort((a, b) => a.created_at - b.created_at)
  const latestIncomingTs = sorted
    .filter(m => m.sender_uid !== currentUid)
    .reduce((latest, m) => Math.max(latest, Number(m.created_at || 0)), 0)
  const hasUnreadIncoming = sorted.some(m => m.sender_uid !== currentUid && !Number(m.read_at || 0))

  if (hasUnreadIncoming || latestIncomingTs > Number(readStatuses[activeTradeId] || 0)) {
    readStatuses[activeTradeId] = latestIncomingTs
    markAsReadSoon(activeTradeId, latestIncomingTs)
  }

  const readMarker = Number(readStatuses[activeTradeId] || 0)
  const tradeFeedback = Array.isArray(activeTrade?.feedback) ? activeTrade.feedback.length : 0
  const tradeKey = activeTrade
    ? `${activeTrade.status || ''}:${activeTrade.cancel_reason || ''}:${tradeFeedback}`
    : ''
  const messagesKey = sorted
    .map(m => `${m.id}:${m.created_at}:${m.sender_uid}:${m.text ? 1 : 0}:${m.image_url ? 1 : 0}:${Number(m.read_at || 0)}`)
    .join('|')
  const partnerReceiptKey = `${Number(partnerReceiptStatus.last_delivered_at || 0)}:${Number(partnerReceiptStatus.last_read_at || 0)}`
  const partnerPresenceKey = `${partnerPresence.active ? 1 : 0}:${Number(partnerPresence.lastActiveAt || 0)}`
  const nextRenderKey = `${activeTradeId}|${readMarker}|${partnerReceiptKey}|${partnerPresenceKey}|${tradeKey}|${messagesKey}`

  if (nextRenderKey !== lastRenderKey) {
    const messageMarkup = sorted.length ? sorted.map(renderMessage).join('') : '<p class="muted">No messages yet.</p>'
    container.innerHTML = `${renderPartnerPresenceStatus()}${messageMarkup}${renderTradeEventCard()}${renderFeedbackSection()}`
    lastRenderKey = nextRenderKey
  }

  syncChatInputState()
  if (shouldScrollToBottom || wasNearBottom) {
    container.scrollTop = container.scrollHeight
    shouldScrollToBottom = false
  }
  lastRenderedTradeId = activeTradeId
}

function clearChatPollTimer() {
  if (!pollTimer) return
  clearTimeout(pollTimer)
  pollTimer = null
}

function computeChatPollDelay() {
  if (document.hidden) return 90000
  if (!document.hasFocus()) return 45000
  return 30000
}

function scheduleNextChatPoll() {
  clearChatPollTimer()
  if (!activeTradeId) return
  if (chatRealtimeActive) return
  pollTimer = setTimeout(runChatPoll, computeChatPollDelay())
}

async function runChatPoll() {
  if (pollInFlight) {
    scheduleNextChatPoll()
    return
  }
  pollInFlight = true
  try {
    await loadMessages()
  } finally {
    pollInFlight = false
    scheduleNextChatPoll()
  }
}

function mergeMessagesById(existing, incoming) {
  const byId = new Map()
  for (const msg of existing || []) {
    if (!msg?.id) continue
    byId.set(msg.id, msg)
  }
  for (const msg of incoming || []) {
    if (!msg?.id) continue
    const prev = byId.get(msg.id)
    byId.set(msg.id, prev ? { ...prev, ...msg } : msg)
  }
  return [...byId.values()]
}

function getPartnerUidForActiveTrade() {
  if (!activeTrade || !currentUid) return null
  if (activeTrade.creator_uid === currentUid) return activeTrade.offer_owner_uid
  if (activeTrade.offer_owner_uid === currentUid) return activeTrade.creator_uid

  return null
}

function isTradeOpenStatus(status, expiresAt) {
  const normalizedStatus = String(status || '').toLowerCase()
  if (CLOSED_TRADE_STATUSES.has(normalizedStatus)) return false

  const expiryTs = Number(expiresAt || 0)
  if (expiryTs > 0 && EXPIRES_WITH_TIME_STATUSES.has(normalizedStatus)) {
    return Math.floor(Date.now() / 1000) < expiryTs
  }

  return true
}

function shouldPingPresenceHeartbeat() {
  if (!activeTradeId) return false
  if (document.hidden) return false
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false
  return true
}

function isPartnerActiveFromLastActive(lastActiveAt) {
  return isActiveFromLastActive(lastActiveAt)
}

function refreshPartnerPresenceState() {
  const nextActive = isPartnerActiveFromLastActive(partnerPresence.lastActiveAt)
  if (nextActive === !!partnerPresence.active) return
  partnerPresence = {
    ...partnerPresence,
    active: nextActive,
  }
  renderChatFromState()
}

function stopRealtimeChatListeners() {
  chatRealtimeActive = false
  if (!stopChatRealtimeListeners) return
  stopChatRealtimeListeners()
  stopChatRealtimeListeners = null
}

function startRealtimeChatListeners() {
  stopRealtimeChatListeners()
  if (!chatFirebaseApp || !activeTradeId) return false
  if (!isTradeOpenStatus(activeTrade?.status, activeTrade?.expires_at) || tradeOpenInSync === false) return false

  try {
    const db = getDatabase(chatFirebaseApp)
    const subscribedTradeId = String(activeTradeId)
    const unsubscribers = []

    const messagesQuery = query(
      ref(db, `chats/${subscribedTradeId}/messages`),
      orderByChild('created_at'),
      startAt(Math.max(0, Number(chatCursorTs || 0)) + 1)
    )

    const upsertMessage = (snap) => {
      if (String(activeTradeId) !== subscribedTradeId) return
      const msg = snap.val()
      if (!msg?.id) return
      chatMessageCache = mergeMessagesById(chatMessageCache, [msg])
      chatCursorTs = Math.max(chatCursorTs, Number(msg.created_at || 0))
      renderChatFromState()
    }

    const onNewMessage = (snap) => {
      const msg = snap.val()
      if (msg?.id && String(msg.sender_uid || '') !== String(currentUid || '')) {
        playNotifySound()
      }
      upsertMessage(snap)
    }

    unsubscribers.push(onChildAdded(messagesQuery, onNewMessage, () => {
      chatRealtimeActive = false
      scheduleNextChatPoll()
    }))
    unsubscribers.push(onChildChanged(messagesQuery, upsertMessage, () => {
      chatRealtimeActive = false
      scheduleNextChatPoll()
    }))
    unsubscribers.push(onChildRemoved(ref(db, `chats/${subscribedTradeId}/messages`), (snap) => {
      if (String(activeTradeId) !== subscribedTradeId) return
      const msg = snap.val()
      if (!msg?.id) return
      chatMessageCache = chatMessageCache.filter((m) => String(m.id) !== String(msg.id))
      renderChatFromState()
    }, () => {
      chatRealtimeActive = false
      scheduleNextChatPoll()
    }))

    const partnerUid = getPartnerUidForActiveTrade()

    unsubscribers.push(onValue(ref(db, `trades/${subscribedTradeId}/status`), (snap) => {
      if (String(activeTradeId) !== subscribedTradeId) return
      const latestStatus = String(snap.val() || '').toLowerCase()
      if (activeTrade) {
        activeTrade = { ...activeTrade, status: latestStatus }
      }
      tradeOpenInSync = isTradeOpenStatus(latestStatus, activeTrade?.expires_at)
      if (!tradeOpenInSync) {
        stopRealtimeChatListeners()
        clearChatPollTimer()
      }
      renderChatFromState()
    }))

    if (partnerUid) {
      unsubscribers.push(onValue(ref(db, `chats/${subscribedTradeId}/participants/${partnerUid}`), (snap) => {
        if (String(activeTradeId) !== subscribedTradeId) return
        const val = snap.val() || {}
        partnerReceiptStatus = {
          last_delivered_at: Number(val.last_delivered_at || 0),
          last_read_at: Number(val.last_read_at || 0),
        }
        renderChatFromState()
      }))

      unsubscribers.push(onValue(ref(db, `users/${partnerUid}/last_active_at`), (snap) => {
        if (String(activeTradeId) !== subscribedTradeId) return
        const lastActiveAt = Number(snap.val() || 0)
        partnerPresence = {
          active: isPartnerActiveFromLastActive(lastActiveAt),
          lastActiveAt,
        }
        renderChatFromState()
      }))
    }

    stopChatRealtimeListeners = () => {
      for (const unsubscribe of unsubscribers) {
        if (typeof unsubscribe === 'function') unsubscribe()
      }
    }
    chatRealtimeActive = true
    return true
  } catch {
    chatRealtimeActive = false
    return false
  }
}

function markAsReadSoon(tradeId, fallbackTs = 0) {
  if (!tradeId) return
  if (markReadInFlight.has(tradeId)) return

  const p = markChatRead(tradeId)
    .then((res) => {
      const serverTs = Number(res?.last_read_at || 0)
      if (serverTs > Number(readStatuses[tradeId] || 0)) {
        readStatuses[tradeId] = serverTs
      }
    })
    .catch(() => {
      if (fallbackTs > Number(readStatuses[tradeId] || 0)) {
        readStatuses[tradeId] = fallbackTs
      }
    })
    .finally(() => {
      markReadInFlight.delete(tradeId)
    })

  markReadInFlight.set(tradeId, p)
}

function isScrolledNearBottom(container) {
  const threshold = 48
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold
}

function syncChatInputState() {
  const inputArea = document.getElementById('chat-input-area')
  if (!inputArea) return

  if (isChatClosed()) {
    const label = terminalStatusLabel(activeTrade)
    if (!inputArea.querySelector('[data-chat-closed="true"]')) {
      inputArea.innerHTML = `<p class="muted" data-chat-closed="true" style="padding: 0.75rem 0; text-align: center;">This trade is ${label} — chat is read-only.</p>`
    }
    return
  }

  const sentSinceDispute = messagesSentSinceDisputeCount()
  const disputeLimitReached = sentSinceDispute >= MAX_MESSAGES_AFTER_DISPUTE

  if (disputeLimitReached) {
    if (!inputArea.querySelector('[data-dispute-limit="true"]')) {
      inputArea.innerHTML = `<p class="muted" data-dispute-limit="true" style="padding: 0.75rem 0; text-align: center;">You've reached the ${MAX_MESSAGES_AFTER_DISPUTE}-message limit after opening a dispute. A moderator will review this trade.</p>`
    }
    return
  }

  if (!(inputArea.querySelector('#btn-send-msg') && inputArea.querySelector('#chat-text') && inputArea.querySelector('#chat-image-preview'))) {
    inputArea.innerHTML = `
      <p id="chat-dispute-limit-hint" class="muted hidden" style="padding: 0 0 0.5rem; text-align: center; font-size: 0.82rem;"></p>
      <div id="chat-image-preview" class="chat-image-preview"></div>
      <div class="chat-input-row">
        <input id="chat-text" type="text" placeholder="Type a message…" autocomplete="off" />
        <label class="file-btn" title="Attach image or video">
          📎
          <input id="chat-image-input" type="file" accept="image/*,video/*" class="hidden" />
        </label>
        <button id="btn-send-msg">Send</button>
      </div>
    `

    const sendBtn = document.getElementById('btn-send-msg')
    const chatText = document.getElementById('chat-text')
    if (sendBtn) sendBtn.addEventListener('click', handleSend)
    if (chatText) chatText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
    })
  }

  const hint = document.getElementById('chat-dispute-limit-hint')
  if (hint) {
    if (String(activeTrade?.status || '') === 'disputed') {
      const remaining = MAX_MESSAGES_AFTER_DISPUTE - sentSinceDispute
      hint.textContent = `${remaining} message${remaining === 1 ? '' : 's'} remaining after dispute`
      hint.classList.remove('hidden')
    } else {
      hint.classList.add('hidden')
    }
  }
}

function renderTradeEventCard() {
  if (!activeTrade) return ''

  if (activeTrade.status === 'completed') {
    return `
      <div style="margin-top:1rem;padding:0.95rem 1rem;border-radius:12px;border:1px solid rgba(34,197,94,0.35);background:rgba(34,197,94,0.12);color:var(--success);font-weight:600;">
        Trade completed. Chat is now closed, and both parties can leave feedback.
      </div>`
  }

  if (activeTrade.status === 'cancelled') {
    const reason = activeTrade.cancel_reason ? `<div style="margin-top:0.45rem;color:var(--text);font-weight:500;">Reason: ${escapeHtml(activeTrade.cancel_reason)}</div>` : ''
    return `
      <div style="margin-top:1rem;padding:0.95rem 1rem;border-radius:12px;border:1px solid rgba(239,68,68,0.35);background:rgba(239,68,68,0.1);color:var(--danger);font-weight:600;">
        Trade cancelled. Chat is now closed.${reason}
      </div>`
  }

  if (activeTrade.status === 'expired') {
    return `
      <div style="margin-top:1rem;padding:0.95rem 1rem;border-radius:12px;border:1px solid rgba(168,85,247,0.35);background:rgba(168,85,247,0.1);color:#a855f7;font-weight:600;">
        Trade expired. Chat is now closed.
      </div>`
  }

  if (activeTrade.status === 'paid') {
    return `
      <div style="margin-top:1rem;padding:0.95rem 1rem;border-radius:12px;border:1px solid rgba(234,179,8,0.35);background:rgba(234,179,8,0.1);color:#eab308;font-weight:600;">
        Your partner is verifying the payment and will be with you shortly.
      </div>`
  }

  if (activeTrade.status === 'disputed') {

    const raisedAt = Number(activeTrade.dispute_raised_at || 0)
    const deadlineText = raisedAt > 0
      ? ` (by ${new Date((raisedAt + 96 * 3600) * 1000).toLocaleString()})`
      : ''
    const resolvedNote = activeTrade.dispute_resolved
      ? `<div style="margin-top:0.75rem;font-weight:700;">This dispute has been resolved by a moderator.</div>`
      : ''
    return `
      <div style="margin-top:1rem;padding:0.95rem 1rem;border-radius:12px;border:1px solid rgba(239,68,68,0.35);background:rgba(239,68,68,0.1);">
        <div style="color:var(--danger);font-weight:700;">Dispute in progress.</div>
        <div style="margin-top:0.5rem;color:var(--text);">We will look to resolve the dispute within 96 hours of the claim being made${deadlineText}.</div>
        <div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid rgba(239,68,68,0.25);color:var(--text);">
          <strong>Both parties: please add evidence</strong> here in the chat to help a moderator resolve this quickly. Good evidence includes:
          <ul style="margin:0.4rem 0 0 1.1rem;padding:0;">
            <li>A screen recording of the payment being sent (or not received)</li>
            <li>Payment receipts or bank/app confirmation screenshots</li>
            <li>Transaction IDs or reference numbers</li>
            <li>Timestamps showing when payment was expected vs. sent</li>
          </ul>
          <div style="margin-top:0.5rem;font-size:0.85rem;">When attaching evidence, you can choose to show it to the entire chat or keep it visible to the moderator only. Each of you can send up to ${MAX_MESSAGES_AFTER_DISPUTE} messages after a dispute is opened, so make them count.</div>
        </div>
        ${resolvedNote}
      </div>`
  }

  return ''
}

function renderFeedbackSection() {
  if (!activeTrade || activeTrade.status !== 'completed') return ''

  const feedback = Array.isArray(activeTrade.feedback) ? activeTrade.feedback : []
  const myFeedback = feedback.find(entry => entry.from_uid === currentUid)
  const partnerFeedback = feedback.find(entry => entry.from_uid !== currentUid)

  const actionMarkup = myFeedback
    ? `
      <div style="margin-top:0.75rem;">
        <p class="muted" style="margin:0;">You left ${myFeedback.positive ? 'positive' : 'negative'} feedback.</p>
        <p style="margin:0.45rem 0 0;white-space:pre-wrap;">${escapeHtml(myFeedback.comment)}</p>
        <div style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-top:0.65rem;">
          <button class="btn" data-feedback-action="edit">Edit Feedback</button>
        </div>
      </div>`
    : `
      <div style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-top:0.75rem;align-items:center;">
        <button class="btn" data-feedback-action="create">Leave Feedback</button>
        <span class="muted" style="font-size:0.82rem;">5 to 200 characters</span>
      </div>`

  const partnerMarkup = partnerFeedback
    ? `
      <div style="margin-top:0.75rem;">
        <p class="muted" style="margin:0;">Your trading partner left ${partnerFeedback.positive ? 'positive' : 'negative'} feedback.</p>
        <p style="margin:0.45rem 0 0;white-space:pre-wrap;">${escapeHtml(partnerFeedback.comment)}</p>
      </div>`
    : '<p class="muted" style="margin:0.75rem 0 0;">Your trading partner has not left feedback yet.</p>'

  return `
    <div style="margin-top:1rem;padding:1rem;border-radius:12px;border:1px solid var(--border);background:var(--panel, rgba(255,255,255,0.03));">
      <h3 style="margin:0 0 0.4rem;font-size:1rem;">Trade Feedback</h3>
      <p class="muted" style="margin:0;">Rate this trader after a completed trade.</p>
      ${actionMarkup}
      ${partnerMarkup}
    </div>`
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-feedback-action]')
  if (!button || !activeTradeId) return

  try {
    const mode = button.dataset.feedbackAction
    const feedback = Array.isArray(activeTrade?.feedback) ? activeTrade.feedback : []
    const myFeedback = feedback.find(entry => entry.from_uid === currentUid)
    const result = await showFeedbackModal(mode === 'edit' && myFeedback
      ? {
          initialPositive: !!myFeedback.positive,
          initialComment: String(myFeedback.comment || ''),
          title: 'Edit Feedback',
          submitLabel: 'Save Changes',
        }
      : undefined)
    if (!result) return

    button.disabled = true
    activeTrade = mode === 'edit'
      ? await editTradeFeedback(activeTradeId, result.positive, result.comment)
      : await leaveTradeFeedback(activeTradeId, result.positive, result.comment)
    await loadMessages()
  } catch (e) {
    await showAlert('Feedback failed: ' + e.message)
    button.disabled = false
  }
})

function isChatClosed() {
  if (tradeOpenInSync === false) return true
  return !!activeTrade && !isTradeOpenStatus(activeTrade.status, activeTrade.expires_at)
}

function terminalStatusLabel(trade) {
  return trade?.status || 'closed'
}

function resolveSenderDisplayName(msg) {
  if (msg.sender_uid === currentUid) return 'You'
  if (msg.sender_role === 'moderator') return 'Moderator'
  if (activeTrade?.creator_uid === msg.sender_uid) return activeTrade.creator_username || msg.sender_uid.slice(0, 8)
  if (activeTrade?.offer_owner_uid === msg.sender_uid) return activeTrade.offer_owner_username || msg.sender_uid.slice(0, 8)
  return partnerUsername || msg.sender_uid.slice(0, 8)
}

function renderMessage(msg) {
  const time        = new Date(msg.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const isMe        = msg.sender_uid === currentUid
  const displayName = resolveSenderDisplayName(msg)
  const checksMarkup = isMe ? renderMessageChecks(msg) : ''
  const modBubbleClass = (msg.sender_role === 'moderator' && !isMe) ? ' chat-bubble-moderator' : ''

  if (msg.is_system) {

    return `
      <div class="chat-system-notice">
        <div class="chat-system-notice-text">${escapeHtml(msg.text || '')}</div>
        <div class="chat-system-notice-time">${time}</div>
      </div>`
  }

  if (msg.redacted) {

    return `
      <div class="chat-row${isMe ? ' chat-row-mine' : ' chat-row-theirs'}">
        <div class="chat-bubble${isMe ? ' chat-bubble-mine' : ' chat-bubble-theirs'}${modBubbleClass}">
          ${!isMe ? `<span class="bubble-name">${escapeHtml(displayName)}</span>` : ''}
          <p class="bubble-text muted">🔒 Evidence submitted — visible to the sender and a moderator only.</p>
          <span class="bubble-time"><span class="bubble-time-text">${time}</span>${checksMarkup}</span>
        </div>
      </div>`
  }

  return `
    <div class="chat-row${isMe ? ' chat-row-mine' : ' chat-row-theirs'}">
      <div class="chat-bubble${isMe ? ' chat-bubble-mine' : ' chat-bubble-theirs'}${modBubbleClass}">
        ${!isMe ? `<span class="bubble-name">${escapeHtml(displayName)}</span>` : ''}
        ${msg.text      ? `<p class="bubble-text">${escapeHtml(msg.text)}</p>` : ''}
        ${renderImagePart(msg, isMe)}
        ${msg.visibility === 'moderator_only' && isMe ? '<p class="bubble-text muted" style="font-size:0.78rem;">🔒 Only visible to you and a moderator</p>' : ''}
        <span class="bubble-time"><span class="bubble-time-text">${time}</span>${checksMarkup}</span>
      </div>
    </div>`
}

function renderMessageChecks(msg) {
  const createdAt = Number(msg.created_at || 0)
  const messageReadAt = Number(msg.read_at || 0)
  const readAt = Number(partnerReceiptStatus.last_read_at || 0)
  const deliveredAt = Number(partnerReceiptStatus.last_delivered_at || 0)

  if (messageReadAt > 0 || (createdAt > 0 && readAt >= createdAt)) {
    return ' <span class="chat-checks chat-checks-read" title="Read">✓✓</span>'
  }
  if (createdAt > 0 && deliveredAt >= createdAt) {
    return ' <span class="chat-checks chat-checks-delivered" title="Delivered">✓</span>'
  }
  return ' <span class="chat-checks chat-checks-pending" title="Sent">✓</span>'
}

function renderPartnerPresenceStatus() {
  if (!partnerUsername && !partnerPresence.lastActiveAt) return ''
  const label = partnerPresence.active
    ? 'Active now'
    : formatPresenceLastSeen(partnerPresence.lastActiveAt)
  const dot = partnerPresence.active ? '#22c55e' : '#94a3b8'
  const who = partnerUsername || 'Partner'
  return `
    <div style="display:flex;align-items:center;gap:0.45rem;margin:0.2rem 0 0.75rem;color:var(--muted);font-size:0.8rem;">
      <span style="width:0.45rem;height:0.45rem;border-radius:999px;background:${dot};display:inline-block;"></span>
      <span>${escapeHtml(who)} • ${escapeHtml(label)}</span>
    </div>`
}

function renderImagePart(msg, isMe) {
  if (!msg.image_url) return ''
  const isVideo = msg.media_type === 'video'

  const lastRead = Number(readStatuses[msg.trade_id] || 0)
  const alreadyRead = isMe || Number(msg.read_at || 0) > 0 || Number(msg.created_at) <= lastRead
  console.log('[chat] renderImagePart', { msgId: msg.id, isMe, alreadyRead, lastRead, created_at: msg.created_at, isVideo })
  if (alreadyRead) {

    const src = (isMe && recentSentImages.get(msg.image_url)) || msg.image_url
    return isVideo
      ? `<video class="bubble-image" src="${src}" controls></video>`
      : `<img class="bubble-image" src="${src}" alt="Shared image" onload="this.style.background='none'" />`
  }
  return `<div class="bubble-image-placeholder" data-image-url="${encodeURIComponent(msg.image_url)}" data-trade-id="${escapeHtml(msg.trade_id)}" data-media-type="${isVideo ? 'video' : 'image'}">
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    <span>Tap to view ${isVideo ? 'video' : 'image'}</span>
  </div>`
}

async function uploadChatImage(file) {

  const MAX_PX = 1024
  const QUALITY = 0.72
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = (e) => {
      const img = new Image()
      img.onerror = reject
      img.onload = () => {
        let { width, height } = img
        if (width > MAX_PX || height > MAX_PX) {
          if (width > height) { height = Math.round(height * MAX_PX / width); width = MAX_PX }
          else { width = Math.round(width * MAX_PX / height); height = MAX_PX }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        const dataUrl = canvas.toDataURL('image/jpeg', QUALITY)
        console.log('[chat] compressed image to', Math.round(dataUrl.length / 1024), 'KB')
        resolve(dataUrl)
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  })
}

async function uploadChatVideo(file) {

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = (e) => resolve(e.target.result)
    reader.readAsDataURL(file)
  })
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
