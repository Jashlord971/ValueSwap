import { initWallet as apiInitWallet, getLedgerBalance, smartSend, resolveRecipient } from './api.js'
import { COINS } from './coin-meta.js'

let currentWallet = null
let prices = {}
let ledgerBalances = {}

async function fetchPrices() {
  try {
    const ids = COINS.map(c => c.geckoId).join(',')
    const res = await fetch(`/api/wallet/prices?ids=${ids}`)
    if (res.ok)  {
      prices = await res.json();
      console.log(prices);
    }
  } catch {
    // USD values will be hidden if prices are unavailable
  }
}

export async function initWallet() {
  const info = document.getElementById('wallet-info')
  info.innerHTML = '<p class="muted">Loading wallets…</p>'
  try {
    currentWallet = await apiInitWallet()
    renderWallet(currentWallet)
    fetchAndRenderBalances()
  } catch (e) {
    info.innerHTML = `<p class="error">Failed to load wallet: ${e.message}</p>`
  }
}

function renderWallet(wallet) {
  const info = document.getElementById('wallet-info')
  const cards = COINS.map(coin => `
    <div class="wallet-card" data-coin="${coin.id}">
      <div class="wallet-card-header">
        <div class="wallet-coin-info">
          <img class="wallet-coin-logo" src="${coin.logo}" alt="${coin.symbol}" />
          <span class="wallet-symbol">${coin.symbol}</span>
          <span class="wallet-label">${coin.label}</span>
        </div>
        <div class="wallet-actions">
          <button class="btn-wallet-action" data-coin="${coin.id}" data-action="deposit" title="Deposit">Deposit</button>
          <button class="btn-wallet-action" data-coin="${coin.id}" data-action="send" title="Send">Send</button>
        </div>
      </div>
      <div class="wallet-balance-row">
        <div id="balance-${coin.id}" class="wallet-balance-value"><span class="muted">—</span></div>
      </div>
      <div id="usd-${coin.id}" class="wallet-usd-value"></div>
    </div>
  `).join('')

  info.innerHTML = `
    <div class="wallet-grid">${cards}</div>
    <button id="btn-refresh-balances" class="btn-sm" style="margin-top:1rem">↻ Refresh Balances</button>
  `

  document.querySelectorAll('.btn-wallet-action').forEach(btn => {
    btn.addEventListener('click', () => handleWalletAction(btn.dataset.action, btn.dataset.coin))
  })

  document.getElementById('btn-refresh-balances')
    .addEventListener('click', fetchAndRenderBalances)
}

// ── Action routing ────────────────────────────────────────────────────────────

function handleWalletAction(action, coinId) {
  const coin = COINS.find(c => c.id === coinId)
  if (action === 'deposit') showDepositModal(coin)
  else if (action === 'send') showSendModal(coin)
}

// ── Deposit modal ─────────────────────────────────────────────────────────────

function showDepositModal(coin) {
  const overlay = makeModalOverlay()

  const tabs = coin.networks.map((n, i) =>
    `<button class="network-tab${i === 0 ? ' active' : ''}" data-idx="${i}">${n.label}</button>`
  ).join('')

  const defaultAddr = currentWallet[coin.networks[0].addrKey] ?? null

  overlay.querySelector('.modal').innerHTML = `
    <div class="modal-header">
      <h2>Deposit ${coin.symbol}</h2>
      <button class="btn-modal-close">✕</button>
    </div>
    <p class="muted" style="margin-bottom:1rem">Select a network and share your address.</p>
    <div class="network-tabs">${tabs}</div>
    <div class="deposit-addr-box">
      <code id="deposit-address">${defaultAddr ?? '— not yet supported —'}</code>
      <button id="btn-copy-addr" class="btn-sm btn-secondary"${defaultAddr ? '' : ' disabled'}>Copy</button>
    </div>
    <p class="deposit-warning">⚠ Only send ${coin.symbol} on the selected network. Wrong-network transfers are unrecoverable.</p>
  `

  overlay.querySelectorAll('.network-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      overlay.querySelectorAll('.network-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      const network = coin.networks[parseInt(tab.dataset.idx)]
      const addr = network.addrKey ? currentWallet[network.addrKey] : null
      document.getElementById('deposit-address').textContent = addr ?? '— not yet supported —'
      document.getElementById('btn-copy-addr').disabled = !addr
    })
  })

  document.getElementById('btn-copy-addr').addEventListener('click', () => {
    const addr = document.getElementById('deposit-address').textContent
    navigator.clipboard.writeText(addr).then(() => {
      const btn = document.getElementById('btn-copy-addr')
      btn.textContent = 'Copied!'
      setTimeout(() => { btn.textContent = 'Copy' }, 2000)
    })
  })

  bindModalClose(overlay)
}

// ── Send modal (Internal tab + Withdraw on-chain tab) ─────────────────────────

function showSendModal(coin) {
  const overlay = makeModalOverlay()
  const platformBal = (ledgerBalances[coin.id] ?? 0).toFixed(8)
  const FEE = { btc: '0.00005', eth: '0.001', usdt: '1', usdc: '1', trx: '1' }
  const fee = FEE[coin.id] ?? '—'
  const addrHint = coin.id === 'btc' ? 'bc1q…' : coin.id === 'trx' ? 'T…' : '0x…'

  overlay.querySelector('.modal').innerHTML = `
    <div class="modal-header">
      <h2>Send ${coin.symbol}</h2>
      <button class="btn-modal-close">✕</button>
    </div>
    <p class="muted" style="margin-bottom:0.75rem">
      Platform balance: <strong>${platformBal} ${coin.symbol}</strong>
    </p>
    <label class="form-label">Recipient</label>
    <input id="send-to" class="form-input" type="text"
      placeholder="@username or ${addrHint}" autocomplete="off" />
    <div id="send-recipient-preview" class="recipient-preview" style="display:none"></div>
    <label class="form-label" style="margin-top:0.75rem">Amount (${coin.symbol})</label>
    <input id="send-amount" class="form-input" type="number" min="0" step="any" placeholder="0.00" />
    <p class="muted" style="font-size:0.78rem;margin-top:0.2rem">
      On-chain fee if sending externally: ${fee} ${coin.symbol}
    </p>
    <div id="send-error" class="error" style="display:none;margin-top:0.5rem"></div>
    <button id="btn-send" class="btn-primary" style="margin-top:1rem;width:100%">Send</button>
  `
  bindModalClose(overlay)

  const toInput   = overlay.querySelector('#send-to')
  const previewEl = overlay.querySelector('#send-recipient-preview')
  const errEl     = overlay.querySelector('#send-error')
  const btn       = overlay.querySelector('#btn-send')
  let resolveTimer = null
  let lastResolve  = null   // { is_platform_user, uid, username } | null

  async function doResolve() {
    const identifier = toInput.value.trim()
    if (!identifier) {
      previewEl.style.display = 'none'
      lastResolve = null
      return
    }
    try {
      const res = await resolveRecipient(identifier, coin.id)
      lastResolve = res
      if (res.is_platform_user) {
        const name = res.username ? `@${res.username}` : res.uid
        previewEl.className = 'recipient-preview platform'
        previewEl.textContent = `✓ Platform user ${name} — instant & free`
      } else {
        previewEl.className = 'recipient-preview external'
        previewEl.textContent = `→ External address — on-chain, fee: ${fee} ${coin.symbol}`
      }
      previewEl.style.display = ''
    } catch (e) {
      lastResolve = null
      previewEl.className = 'recipient-preview bad'
      previewEl.textContent = `✗ ${e.message}`
      previewEl.style.display = ''
    }
  }

  toInput.addEventListener('input', () => {
    clearTimeout(resolveTimer)
    previewEl.style.display = 'none'
    lastResolve = null
    resolveTimer = setTimeout(doResolve, 500)
  })
  toInput.addEventListener('blur', () => {
    clearTimeout(resolveTimer)
    doResolve()
  })

  btn.addEventListener('click', async () => {
    const to     = toInput.value.trim()
    const amount = parseFloat(overlay.querySelector('#send-amount').value)
    errEl.style.display = 'none'
    if (!to)            { errEl.textContent = 'Enter a recipient.';   errEl.style.display = 'block'; return }
    if (!amount || amount <= 0) { errEl.textContent = 'Enter a valid amount.'; errEl.style.display = 'block'; return }

    btn.disabled = true; btn.textContent = 'Sending…'
    try {
      const res = await smartSend(to, coin.id, amount)
      overlay.remove()
      fetchAndRenderBalances()

      if (res.transfer_type === 'onchain' && res.withdrawal) {
        const done = makeModalOverlay()
        done.querySelector('.modal').innerHTML = `
          <div class="modal-header">
            <h2>Withdrawal sent</h2>
            <button class="btn-modal-close">✕</button>
          </div>
          <p class="muted">Transaction broadcast successfully.</p>
          <p style="font-size:0.8rem;word-break:break-all">
            <strong>Tx hash:</strong><br>
            <code style="color:#a78bfa">${res.withdrawal.tx_hash}</code>
          </p>
          <p class="muted" style="font-size:0.8rem">
            Fee deducted: ${res.withdrawal.fee_deducted} ${coin.symbol}
          </p>
        `
        bindModalClose(done)
      }
    } catch (e) {
      errEl.textContent = e.message; errEl.style.display = 'block'
      btn.disabled = false; btn.textContent = 'Send'
    }
  })
}

// ── Coming-soon placeholder ───────────────────────────────────────────────────

function showComingSoonModal(title) {
  const overlay = makeModalOverlay()
  overlay.querySelector('.modal').innerHTML = `
    <div class="modal-header">
      <h2>${title}</h2>
      <button class="btn-modal-close">✕</button>
    </div>
    <p class="muted">This feature is coming soon.</p>
  `
  bindModalClose(overlay)
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function makeModalOverlay() {
  document.getElementById('wallet-modal-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.id = 'wallet-modal-overlay'
  overlay.innerHTML = '<div class="modal wallet-action-modal"></div>'
  document.body.appendChild(overlay)
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  return overlay
}

function bindModalClose(overlay) {
  overlay.querySelector('.btn-modal-close')?.addEventListener('click', () => overlay.remove())
}



async function fetchAndRenderBalances() {
  const btn = document.getElementById('btn-refresh-balances')
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…' }

  COINS.forEach(({ id }) => {
    const el = document.getElementById(`balance-${id}`)
    if (el) el.innerHTML = '<span class="muted">…</span>'
    const usd = document.getElementById(`usd-${id}`)
    if (usd) usd.innerHTML = ''
  })

  await fetchPrices()

  try {
    const ledger = await getLedgerBalance()
    setBalance('btc',  'BTC',  'bitcoin',  ledger.btc  ?? 0)
    setBalance('eth',  'ETH',  'ethereum', ledger.eth  ?? 0)
    setBalance('usdt', 'USDT', 'tether',   ledger.usdt ?? 0)
    setBalance('usdc', 'USDC', 'usd-coin', ledger.usdc ?? 0)
    setBalance('trx',  'TRX',  'tron',     ledger.trx  ?? 0)
    ledgerBalances = { btc: ledger.btc ?? 0, eth: ledger.eth ?? 0, usdt: ledger.usdt ?? 0, usdc: ledger.usdc ?? 0, trx: ledger.trx ?? 0 }
  } catch {
    COINS.forEach(({ id }) => {
      const el = document.getElementById(`balance-${id}`)
      if (el) el.innerHTML = '<span class="muted">unavailable</span>'
    })
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh Balances' }
  }
}

function setBalance(id, symbol, geckoId, amount) {
  const balEl = document.getElementById(`balance-${id}`)
  const usdEl = document.getElementById(`usd-${id}`)
  if (!balEl) return

  balEl.innerHTML = amount > 0
    ? `<strong>${amount.toFixed(6)} ${symbol}</strong>`
    : `<span class="muted">0 ${symbol}</span>`

  if (usdEl) {
    const price = prices[geckoId]?.usd
    if (price != null) {
      const usdVal = (amount * price).toFixed(2)
      usdEl.innerHTML = `<span class="wallet-usd">$${usdVal} USD</span>`
    }
  }
}

