/**
 * Thin API client. Every request attaches the Firebase ID token so the
 * Rust backend can verify the user via Firebase JWT validation.
 */
import { getIdToken } from './auth.js'
import { cacheGet, cacheSet, cacheInvalidate } from './cache.js'

const BASE = '/api'

const TTL = {
  profile: 10 * 60 * 1000,  // 10 min — changes rarely
  offers:   5 * 60 * 1000,  //  5 min — user's own offers
  trades:  30 * 1000,       // 30 sec — active, status changes often
}

const WALLET_BOOTSTRAP_KEY = 'wallet:bootstrapped'
let walletBootstrapPromise = null

/** Return cached value instantly; on miss fetch, cache, return. */
function cached(key, ttl, fetcher) {
  const hit = cacheGet(key)
  if (hit !== null) return Promise.resolve(hit)
  return fetcher().then(data => { cacheSet(key, data, ttl); return data })
}

async function headers(extra = {}) {
  const token = await getIdToken()
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...extra,
  }
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: await headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return null
  const text = await res.text()
  if (!text.trim()) throw new Error(`Server returned empty response (HTTP ${res.status})`)
  let data
  try { data = JSON.parse(text) } catch {
    throw new Error(`Unexpected server response (HTTP ${res.status}): ${text.slice(0, 120)}`)
  }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

async function requestWithWalletBootstrap(method, path, body) {
  try {
    return await request(method, path, body)
  } catch (e) {
    const msg = String(e?.message || '')
    const walletReadPath = path === '/wallet/ledger' || path === '/wallet/balances' || path === '/wallet/me'
    const needsInit = walletReadPath && /wallet not initialised|wallet not initialized|http 404/i.test(msg)
    if (!needsInit) throw e

    await request('POST', '/wallet/init')
    return request(method, path, body)
  }
}

async function ensureWalletBootstrapped() {
  try {
    if (sessionStorage.getItem(WALLET_BOOTSTRAP_KEY) === '1') return
  } catch {
    // sessionStorage may be unavailable; proceed with in-memory guard
  }

  if (walletBootstrapPromise) {
    await walletBootstrapPromise
    return
  }

  walletBootstrapPromise = request('POST', '/wallet/init')
    .then(() => {
      try { sessionStorage.setItem(WALLET_BOOTSTRAP_KEY, '1') } catch {}
    })
    .finally(() => {
      walletBootstrapPromise = null
    })

  try {
    await walletBootstrapPromise
  } catch {
    // Do not block auth/profile flows if wallet bootstrap fails transiently.
  }
}

// ── Wallet ────────────────────────────────────────────────────────────────────

export const initWallet        = ()                        => request('POST', '/wallet/init')
export const getWalletBalances = ()                        => requestWithWalletBootstrap('GET', '/wallet/balances')
export const getLedgerBalance  = ()                        => requestWithWalletBootstrap('GET', '/wallet/ledger')
export const faucetCredit      = (coin, amount)            => request('POST', '/wallet/faucet', { coin, amount })
export const setDevBalanceUsd  = (coin, usdAmount)         => request('POST', '/wallet/dev/set-balance-usd', { coin, usd_amount: usdAmount })
export const getPlatformFees   = ()                        => request('GET',  '/wallet/platform-fees')
export const sweepPlatformFees = (coin, amount)            => request('POST', '/wallet/platform-fees/sweep', { coin, amount })
export const initTreasury      = ()                        => request('POST', '/wallet/treasury/init')
export const sendInternal      = (to_email, coin, amount)  => request('POST', '/wallet/send',        { to_email, coin, amount })
export const withdraw          = (coin, to_address, amount) => request('POST', '/wallet/withdraw',     { coin, to_address, amount })
export const smartSend         = (to, coin, amount)         => request('POST', '/wallet/smart-send',   { to, coin, amount })
export const claimDeposits     = ()                          => request('POST', '/wallet/claim-deposits')

// ── Users ────────────────────────────────────────────────────────────────

/** Creates user profile on first login; returns existing profile on subsequent calls. */
export const upsertUser       = ()       => cached('profile', TTL.profile, async () => {
  const profile = await request('POST', '/users/me')
  await ensureWalletBootstrapped()
  return profile
})
export const getMyProfile     = ()       => cached('profile', TTL.profile, () => request('GET',  '/users/me'))
export const updateMyProfile  = (data)   => request('PATCH', '/users/me', data).then(r => { cacheSet('profile', r, TTL.profile); return r })
export const getUserProfile   = (uid)    => request('GET', `/users/${uid}`)
export const resolveRecipient  = (identifier, coin) => request('POST', '/users/resolve', { identifier, coin })
export const setWithdrawCode   = (code) => request('POST', '/users/me/set-withdraw-code', { code }).then(r => { cacheSet('profile', r, TTL.profile); return r })

// ── Trades ────────────────────────────────────────────────────────────────────

export const listTrades  = ()       => cached('trades', TTL.trades, () => request('GET', '/trades'))
export const createTrade = (data)   => request('POST', '/trades', data).then(r    => { cacheInvalidate('trades'); return r })
export const getTrade    = (id)     => request('GET',  `/trades/${id}`)
export const acceptTrade = (id)     => request('POST', `/trades/${id}/accept`).then(r   => { cacheInvalidate('trades'); return r })
export const completeTrade = (id)   => request('POST', `/trades/${id}/complete`).then(r => { cacheInvalidate('trades'); return r })
export const cancelTrade   = (id, reason) => request('POST', `/trades/${id}/cancel`, reason ? { reason } : undefined).then(r => { cacheInvalidate('trades'); return r })
export const markTradePaid = (id)    => request('POST', `/trades/${id}/mark-paid`).then(r  => { cacheInvalidate('trades'); return r })
export const disputeTrade  = (id)    => request('POST', `/trades/${id}/dispute`).then(r    => { cacheInvalidate('trades'); return r })
export const leaveTradeFeedback = (id, positive, comment) => request('POST', `/trades/${id}/feedback`, { positive, comment }).then(r => { cacheInvalidate('trades'); return r })

// ── Offers ────────────────────────────────────────────────────────────────────

/** Pass { fresh: true } to bypass cache (e.g. P2P market browse). */
export const listOffers = ({ fresh = false, ...query } = {}) => {
  const params = new URLSearchParams()
  Object.entries(query).forEach(([k, v]) => {
    if (v === undefined || v === null) return
    if (typeof v === 'string' && !v.trim()) return
    params.set(k, String(v))
  })
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const path = `/offers${suffix}`
  return fresh ? request('GET', path) : cached('offers', TTL.offers, () => request('GET', path))
}
export const createOffer       = (data)         => request('POST',   '/offers', data).then(r        => { cacheInvalidate('offers'); return r })
export const updateOffer       = (id, data)     => request('PATCH',  `/offers/${id}`, data).then(r  => { cacheInvalidate('offers'); return r })
export const deleteOffer       = (id)           => request('DELETE', `/offers/${id}`).then(r        => { cacheInvalidate('offers'); return r })
export const toggleOfferStatus = (id, active)   => request('PATCH',  `/offers/${id}/status`, { active }).then(r => { cacheInvalidate('offers'); return r })

/** Fetch without auth token (public endpoints) */
async function publicFetch(path) {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export const listPaymentMethods = () => publicFetch('/offers/payment-methods')
export const listCurrencies     = () => publicFetch('/offers/currencies')
export const getUsdPrices       = (ids) => {
  const val = Array.isArray(ids) ? ids.join(',') : String(ids || '')
  return publicFetch(`/wallet/prices?ids=${encodeURIComponent(val)}`)
}

export async function getCombinedUsdBalance() {
  const [ledger, prices] = await Promise.all([
    getLedgerBalance(),
    getUsdPrices(['bitcoin', 'ethereum', 'tether', 'usd-coin', 'tron']),
  ])
  const p = (id) => Number(prices?.[id]?.usd || 0)
  const total =
    (Number(ledger?.btc || 0) * p('bitcoin')) +
    (Number(ledger?.eth || 0) * p('ethereum')) +
    (Number(ledger?.usdt || 0) * p('tether')) +
    (Number(ledger?.usdc || 0) * p('usd-coin')) +
    (Number(ledger?.trx || 0) * p('tron'))
  return Number.isFinite(total) ? total : 0
}

// ── Swaps ─────────────────────────────────────────────────────────────────────

export const listSwapOffers = (query = {}) => {
  const params = new URLSearchParams()
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v).length) params.set(k, String(v))
  })
  const suffix = params.toString() ? `?${params.toString()}` : ''
  return request('GET', `/swaps${suffix}`)
}
export const createSwapOffer = (data) => request('POST', '/swaps', data)
export const acceptSwapOffer = (id, take_from_amount) =>
  request('POST', `/swaps/${id}/accept`, { take_from_amount })
export const cancelSwapOffer = (id) => request('DELETE', `/swaps/${id}`)

// ── Chat ──────────────────────────────────────────────────────────────────────

export const getMessages = (tradeId) =>
  request('GET', `/chat/${tradeId}/messages`)

export const sendMessage = (tradeId, text, imageUrl) =>
  request('POST', `/chat/${tradeId}/messages`, {
    text: text || null,
    image_url: imageUrl || null,
  })

export const getChatReadStatuses = () =>
  request('GET', '/chat/read-statuses')

export const markChatRead = (tradeId) =>
  request('POST', `/chat/${tradeId}/mark-read`)

// ── OCR / Cards ───────────────────────────────────────────────────────────────

export const scanCard  = (imageBase64) => request('POST', '/ocr/scan',     { image_base64: imageBase64 })
export const checkCard = (cardNumber)  => request('POST', '/cards/check',  { card_number: cardNumber })
export const registerCard = (data)     => request('POST', '/cards/register', data)
