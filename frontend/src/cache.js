
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
  } catch {  }
}

export function cacheInvalidate(...keys) {
  try {
    keys.forEach(k => sessionStorage.removeItem(PFX + k))
  } catch {  }
}
