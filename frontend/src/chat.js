import { getMessages, sendMessage, leaveTradeFeedback, getChatReadStatuses, markChatRead } from './api.js'
import { showAlert, showFeedbackModal } from './modal.js'

let activeTradeId    = null
let pollTimer        = null
let currentUid       = null
let partnerUsername  = null
let activeTrade      = null
let initialized      = false
let lastRenderedTradeId = null
let shouldScrollToBottom = false
let readStatuses     = {}  // tradeId → last_read_at (unix seconds)
// Maps server image URL → local object URL so the sender sees their image instantly
const recentSentImages = new Map()

export function initChat(firebaseApp, uid) {
  currentUid = uid

  if (initialized) return
  initialized = true

  document.addEventListener('open-chat', (e) => {
    activeTradeId   = e.detail.tradeId
    partnerUsername = e.detail.partnerUsername || null
    activeTrade     = e.detail.trade || null
    shouldScrollToBottom = true
    clearInterval(pollTimer)
    // Fetch current read statuses from DB when opening a trade
    getChatReadStatuses().then(s => { readStatuses = s || {} }).catch(() => {})
    loadMessages()
    pollTimer = setInterval(loadMessages, 5000)
  })

  document.addEventListener('trade-updated', (e) => {
    const trade = e?.detail?.trade
    if (!trade?.id || !activeTradeId) return
    if (String(trade.id) !== String(activeTradeId)) return
    activeTrade = trade
    loadMessages()
  })

  // Image placeholder click — reveal image and mark trade read
  const chatMessages = document.getElementById('chat-messages')
  if (chatMessages) {
    chatMessages.addEventListener('click', async (e) => {
      const placeholder = e.target.closest('.bubble-image-placeholder')
      if (!placeholder) return
      const url = decodeURIComponent(placeholder.dataset.imageUrl || '')
      const tradeId = placeholder.dataset.tradeId
      if (!url || !tradeId) return

      const img = document.createElement('img')
      img.className = 'bubble-image'
      img.alt = 'Shared image'
      img.src = url
      placeholder.replaceWith(img)

      // Update local cache and persist to DB
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

  // Show a local preview when an image file is selected
  document.addEventListener('change', (e) => {
    if (e.target.id !== 'chat-image-input') return
    const file = e.target.files[0]
    console.log('[chat] image selected:', file?.name, file?.size, 'bytes')
    const preview = document.getElementById('chat-image-preview')
    console.log('[chat] preview element found:', !!preview)
    if (!preview) return
    if (file) {
      const localUrl = URL.createObjectURL(file)
      preview.innerHTML = `<img src="${localUrl}" class="chat-image-preview-thumb" alt="Preview" />`
      preview.dataset.localUrl = localUrl
      console.log('[chat] local preview set:', localUrl)
    } else {
      preview.innerHTML = ''
      if (preview.dataset.localUrl) URL.revokeObjectURL(preview.dataset.localUrl)
      delete preview.dataset.localUrl
    }
  })
}

async function handleSend() {
  if (!activeTradeId) return

  const textInput  = document.getElementById('chat-text')
  const fileInput  = document.getElementById('chat-image-input')
  const text       = textInput.value.trim()
  const imageFile  = fileInput.files[0]
  let   imageUrl   = null

  if (!text && !imageFile) return

  const btn = document.getElementById('btn-send-msg')
  btn.disabled = true
  try {
    if (imageFile) {
      // Grab the local object URL from the preview before clearing the input
      const preview = document.getElementById('chat-image-preview')
      const localUrl = preview?.dataset.localUrl || null
      console.log('[chat] compressing image:', imageFile.name)
      imageUrl = await uploadChatImage(imageFile)
      console.log('[chat] image ready, size:', Math.round(imageUrl.length / 1024), 'KB')
      if (localUrl) recentSentImages.set(imageUrl, localUrl)
    }
    console.log('[chat] sending message to backend, tradeId:', activeTradeId, 'imageUrl:', imageUrl)
    await sendMessage(activeTradeId, text || null, imageUrl)
    console.log('[chat] message sent successfully')
    textInput.value  = ''
    fileInput.value  = ''
    // Clear the image preview
    const preview = document.getElementById('chat-image-preview')
    if (preview) {
      preview.innerHTML = ''
      delete preview.dataset.localUrl
    }
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
  const container = document.getElementById('chat-messages')
  try {
    const isNewTrade = lastRenderedTradeId !== activeTradeId
    const wasNearBottom = isNewTrade || isScrolledNearBottom(container)
    const msgs = await getMessages(activeTradeId)
    const sorted = [...msgs].sort((a, b) => a.created_at - b.created_at)
    const messageMarkup = sorted.length ? sorted.map(renderMessage).join('') : '<p class="muted">No messages yet.</p>'
    container.innerHTML = `${messageMarkup}${renderTradeEventCard()}${renderFeedbackSection()}`
    syncChatInputState()
    if (shouldScrollToBottom || wasNearBottom) {
      container.scrollTop = container.scrollHeight
      shouldScrollToBottom = false
    }
    lastRenderedTradeId = activeTradeId
  } catch (e) {
    container.innerHTML = `<p class="error">Could not load messages: ${e.message}</p>`
  }
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

  if (inputArea.querySelector('#btn-send-msg') && inputArea.querySelector('#chat-text') && inputArea.querySelector('#chat-image-preview')) return

  inputArea.innerHTML = `
    <div id="chat-image-preview" class="chat-image-preview"></div>
    <div class="chat-input-row">
      <input id="chat-text" type="text" placeholder="Type a message…" autocomplete="off" />
      <label class="file-btn" title="Attach image">
        📎
        <input id="chat-image-input" type="file" accept="image/*" class="hidden" />
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
      </div>`
    : `
      <div style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-top:0.75rem;">
        <button class="btn" data-feedback-trigger="true">Leave Feedback</button>
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
  const button = event.target.closest('[data-feedback-trigger]')
  if (!button || !activeTradeId) return

  try {
    const result = await showFeedbackModal()
    if (!result) return

    button.disabled = true
    activeTrade = await leaveTradeFeedback(activeTradeId, result.positive, result.comment)
    await loadMessages()
  } catch (e) {
    await showAlert('Feedback failed: ' + e.message)
    button.disabled = false
  }
})

function isChatClosed() {
  return !!activeTrade && ['completed', 'cancelled', 'expired'].includes(activeTrade.status)
}

function terminalStatusLabel(trade) {
  return trade?.status || 'closed'
}

function renderMessage(msg) {
  const time        = new Date(msg.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const isMe        = msg.sender_uid === currentUid
  const displayName = isMe ? 'You' : (partnerUsername || msg.sender_uid.slice(0, 8))
  return `
    <div class="chat-row${isMe ? ' chat-row-mine' : ' chat-row-theirs'}">
      <div class="chat-bubble${isMe ? ' chat-bubble-mine' : ' chat-bubble-theirs'}">
        ${!isMe ? `<span class="bubble-name">${escapeHtml(displayName)}</span>` : ''}
        ${msg.text      ? `<p class="bubble-text">${escapeHtml(msg.text)}</p>` : ''}
        ${renderImagePart(msg, isMe)}
        <span class="bubble-time">${time}</span>
      </div>
    </div>`
}

function renderImagePart(msg, isMe) {
  if (!msg.image_url) return ''
  // Sender always sees their own image. Receiver sees a placeholder until they click it.
  const lastRead = Number(readStatuses[msg.trade_id] || 0)
  const alreadyRead = isMe || Number(msg.created_at) <= lastRead
  console.log('[chat] renderImagePart', { msgId: msg.id, isMe, alreadyRead, lastRead, created_at: msg.created_at })
  if (alreadyRead) {
    // Use local object URL for recently sent images so the sender sees it instantly
    const src = (isMe && recentSentImages.get(msg.image_url)) || msg.image_url
    console.log('[chat] rendering image, src is local?', src !== msg.image_url)
    return `<img class="bubble-image" src="${src}" alt="Shared image" onload="this.style.background='none'" />`
  }
  return `<div class="bubble-image-placeholder" data-image-url="${encodeURIComponent(msg.image_url)}" data-trade-id="${escapeHtml(msg.trade_id)}">
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    <span>Tap to view image</span>
  </div>`
}

async function uploadChatImage(file) {
  // Compress image client-side and encode as base64 data URL — stored directly in RTDB.
  // Max dimension 1024px, JPEG quality 0.72 to keep payload reasonable.
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

/** Prevent XSS in user-generated message text */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
