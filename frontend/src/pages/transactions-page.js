
import { initializeApp } from 'firebase/app'
import { firebaseConfig } from '../firebase-config.js'
import { initAuth, onAuthChange, logOut } from '../auth.js'
import { upsertUser, listTransactions, listWithdrawals, getUserProfile } from '../api.js'
import { initChat } from '../chat.js'
import { avatarPathFromProfile } from '../avatar.js'
import { setupUnreadTradeNotifications } from '../unread-notifications.js'
import { ensureDevBalanceTools, refreshNavCombinedBalance } from '../dev-balance-tools.js'

const firebaseApp = initializeApp(firebaseConfig)
initAuth(firebaseApp)
initChat(firebaseApp)

const profileCache = new Map()

const KIND_META = {
  internal_transfer: { label: 'Internal transfer', icon: '↔️' },
  deposit:            { label: 'Deposit',           icon: '⬇️' },
  withdrawal:         { label: 'Withdrawal',        icon: '⬆️' },
  trade:              { label: 'Trade payout',      icon: '🔄' },
  swap:               { label: 'Swap',              icon: '🔀' },
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

onAuthChange(async (user) => {
  if (!user) { window.location.href = '/'; return }

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

  await Promise.all([loadPendingWithdrawals(), loadTransactions()])
})

const WITHDRAWAL_STATUS_META = {
  queued:    { label: 'Queued',    color: 'var(--warn, #eab308)' },
  completed: { label: 'Completed', color: 'var(--success)' },
  failed:    { label: 'Failed',    color: 'var(--danger)' },
}

async function loadPendingWithdrawals() {
  const section = document.getElementById('pending-withdrawals-section')
  const list = document.getElementById('pending-withdrawals-list')
  if (!section || !list) return

  try {
    const withdrawals = await listWithdrawals()
    const pending = withdrawals.filter(w => w.status === 'queued' || w.status === 'failed')
    if (!pending.length) {
      section.style.display = 'none'
      return
    }

    section.style.display = ''
    list.innerHTML = pending.map((w) => {
      const meta = WITHDRAWAL_STATUS_META[w.status] || { label: w.status, color: 'var(--muted)' }
      const when = w.created_at ? new Date(w.created_at * 1000).toLocaleString() : '—'
      return `
        <div style="display:flex;align-items:center;gap:0.85rem;padding:0.85rem 0;border-bottom:1px solid var(--border);">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;">
              ${Number(w.amount).toFixed(8)} ${escHtml(w.coin.toUpperCase())} to
              <code style="font-size:0.82em;word-break:break-all;">${escHtml(w.to_address)}</code>
            </div>
            <div class="muted" style="font-size:0.78rem;margin-top:0.15rem;">${escHtml(when)}</div>
            ${w.status === 'failed' && w.error ? `<div style="font-size:0.8rem;color:var(--danger);margin-top:0.25rem;">${escHtml(w.error)}</div>` : ''}
          </div>
          <div style="font-weight:700;color:${meta.color};white-space:nowrap;">${meta.label}</div>
        </div>`
    }).join('')
  } catch {
    section.style.display = 'none'
  }
}

async function resolveUsername(uid) {
  if (!uid) return null
  if (profileCache.has(uid)) return profileCache.get(uid)
  try {
    const p = await getUserProfile(uid)
    const name = p?.username ? `@${p.username}` : null
    profileCache.set(uid, name)
    return name
  } catch {
    profileCache.set(uid, null)
    return null
  }
}

function describeTransaction(tx, counterpartyName) {
  const isOut = tx.direction === 'out'
  switch (tx.kind) {
    case 'internal_transfer':
      return isOut
        ? `Sent to ${counterpartyName || 'another platform user'}`
        : `Received from ${counterpartyName || 'another platform user'}`
    case 'deposit':
      return `On-chain deposit${tx.counterparty_label ? ` (${escHtml(tx.counterparty_label)})` : ''}`
    case 'withdrawal':
      return `Withdrawn to external address${tx.counterparty_label ? ` <code style="font-size:0.78em;">${escHtml(tx.counterparty_label)}</code>` : ''}`
    case 'trade':
      return isOut
        ? `Trade payout to ${counterpartyName || 'trade counterparty'}${tx.counterparty_label ? ` — ${escHtml(tx.counterparty_label)}` : ''}`
        : `Trade payout from ${counterpartyName || 'trade counterparty'}${tx.counterparty_label ? ` — ${escHtml(tx.counterparty_label)}` : ''}`
    case 'swap':
      return isOut
        ? `Swapped to ${counterpartyName || 'another platform user'}`
        : `Swapped from ${counterpartyName || 'another platform user'}`
    default:
      return isOut ? 'Sent' : 'Received'
  }
}

async function loadTransactions() {
  const list = document.getElementById('transactions-list')
  try {
    const txs = await listTransactions()
    if (!txs.length) {
      list.innerHTML = '<p class="muted">No transactions yet.</p>'
      return
    }

    const uids = [...new Set(txs.map(t => t.counterparty_uid).filter(Boolean))]
    await Promise.all(uids.map(resolveUsername))

    list.innerHTML = txs.map((tx) => {
      const meta = KIND_META[tx.kind] || { label: tx.kind, icon: '•' }
      const counterpartyName = tx.counterparty_uid ? profileCache.get(tx.counterparty_uid) : null
      const when = tx.created_at ? new Date(tx.created_at * 1000).toLocaleString() : '—'
      const isOut = tx.direction === 'out'
      return `
        <div style="display:flex;align-items:center;gap:0.85rem;padding:0.85rem 0;border-bottom:1px solid var(--border);">
          <div style="font-size:1.4rem;">${meta.icon}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;">${escHtml(meta.label)}</div>
            <div class="muted" style="font-size:0.85rem;">${describeTransaction(tx, counterpartyName)}</div>
            <div class="muted" style="font-size:0.78rem;margin-top:0.15rem;">${escHtml(when)}</div>
          </div>
          <div style="font-weight:700;color:${isOut ? 'var(--danger)' : 'var(--success)'};white-space:nowrap;">
            ${isOut ? '-' : '+'}${Number(tx.amount).toFixed(8)} ${escHtml(tx.coin)}
          </div>
        </div>`
    }).join('')
  } catch (e) {
    list.innerHTML = `<p class="error">Failed to load transactions: ${escHtml(e.message)}</p>`
  }
}
