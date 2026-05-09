/**
 * Thin sessionStorage cache.
 * Keys are prefixed with 'cs:' and stored as { data, exp } JSON.
 * Expires silently on read — no background sweeping needed.
 * Falls back silently if sessionStorage is unavailable (private mode etc.).
 */

const PFX = 'cs:'

export function cacheGet(key) {
  try {
    const raw = sessionStorage.getItem(PFX + key)
    if (!raw) return null
    const { data, exp } = JSON.parse(raw)
    if (Date.now() > exp) { sessionStorage.removeItem(PFX + key); return null }
    return data
  } catch { return null }
}

export function cacheSet(key, data, ttlMs) {
  try {
    sessionStorage.setItem(PFX + key, JSON.stringify({ data, exp: Date.now() + ttlMs }))
  } catch { /* quota exceeded or private mode — ignore */ }
}

export function cacheInvalidate(...keys) {
  try {
    keys.forEach(k => sessionStorage.removeItem(PFX + k))
  } catch { /* ignore */ }
}
