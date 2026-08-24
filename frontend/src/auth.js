import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth'
import { PRESENCE_HEARTBEAT_INTERVAL_MS } from './presence.js'

function clearAllCache() {
  try {
    const keysToRemove = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith('cs:')) keysToRemove.push(k)
    }
    keysToRemove.forEach(k => sessionStorage.removeItem(k))
  } catch {  }
}

let auth
let presenceTimer = null
let presenceEventsBound = false
let presencePingInFlight = false
let lastPresencePingAtMs = 0

export function initAuth(app) {
  auth = getAuth(app)
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, (user) => {
    if (user) {
      startPresenceHeartbeat()
      void pingPresenceNow(true)
    } else {
      stopPresenceHeartbeat()
    }
    callback(user)
  })
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider()
  return signInWithPopup(auth, provider)
}

export async function logOut() {
  clearAllCache()
  return signOut(auth)
}

function shouldPingPresence() {
  if (!auth?.currentUser) return false
  if (document.hidden) return false
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false
  return true
}

async function pingPresenceNow(force = false) {
  if (!shouldPingPresence()) return
  const now = Date.now()
  if (!force && now - lastPresencePingAtMs < PRESENCE_HEARTBEAT_INTERVAL_MS - 1000) return
  if (presencePingInFlight) return

  const user = auth.currentUser
  if (!user) return

  presencePingInFlight = true
  try {
    const token = await user.getIdToken(false)
    await fetch('/api/users/me/ping-active', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    })
    lastPresencePingAtMs = Date.now()
  } catch {

  } finally {
    presencePingInFlight = false
  }
}

function bindPresenceEventsOnce() {
  if (presenceEventsBound) return
  presenceEventsBound = true

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void pingPresenceNow(true)
  })
  window.addEventListener('focus', () => {
    void pingPresenceNow(true)
  })
  window.addEventListener('pageshow', () => {
    void pingPresenceNow(true)
  })
}

function startPresenceHeartbeat() {
  bindPresenceEventsOnce()
  if (presenceTimer) return
  presenceTimer = setInterval(() => {
    void pingPresenceNow(false)
  }, PRESENCE_HEARTBEAT_INTERVAL_MS)
}

function stopPresenceHeartbeat() {
  if (!presenceTimer) return
  clearInterval(presenceTimer)
  presenceTimer = null
  lastPresencePingAtMs = 0
}

export async function getIdToken() {
  const user = auth.currentUser
  if (!user) throw new Error('Not authenticated')
  return user.getIdToken( false)
}
