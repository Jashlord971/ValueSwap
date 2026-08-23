export const ACTIVE_WINDOW_SECS = 60
export const RECENT_WINDOW_SECS = 2 * 60 * 60
export const OFFLINE_GRAY_WINDOW_SECS = 24 * 60 * 60
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 20000
export const PARTNER_PRESENCE_RECALC_INTERVAL_MS = 10000

export function isActiveFromLastActive(lastActiveAt, windowSecs = ACTIVE_WINDOW_SECS) {
  const ts = Number(lastActiveAt || 0)
  if (!ts) return false
  return Math.max(0, Math.floor(Date.now() / 1000) - ts) <= windowSecs
}

export function formatPresenceLastSeen(lastActiveAt) {
  const ts = Number(lastActiveAt || 0)
  if (!ts) return 'Offline'
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (delta < 60) return `Last seen ${delta}s ago`
  if (delta < 3600) return `Last seen ${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `Last seen ${Math.floor(delta / 3600)}h ago`
  return `Last seen ${Math.floor(delta / 86400)}d ago`
}

export function getPresenceBadgeState(lastActiveAt) {
  const ts = Number(lastActiveAt || 0)
  if (!ts) {
    return {
      state: 'offline',
      label: 'Offline',
    }
  }

  const delta = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (delta <= ACTIVE_WINDOW_SECS) {
    return {
      state: 'active',
      label: 'Active now',
    }
  }
  if (delta <= RECENT_WINDOW_SECS) {
    return {
      state: 'recent',
      label: `Seen ${Math.floor(delta / 60)}m ago`,
    }
  }
  if (delta < OFFLINE_GRAY_WINDOW_SECS) {
    return {
      state: 'stale',
      label: `Seen ${Math.floor(delta / 3600)}h ago`,
    }
  }
  return {
    state: 'offline',
    label: `Seen ${Math.floor(delta / 86400)}d ago`,
  }
}