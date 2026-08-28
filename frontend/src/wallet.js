import { initWallet as apiInitWallet, getLedgerBalance, smartSend, resolveRecipient, getMyProfile } from './api.js'
import { COINS } from './coin-meta.js'
import { initializeApp, getApps } from 'firebase/app'
import { getDatabase, ref, onValue } from 'firebase/database'
import { firebaseConfig } from './firebase-config.js'
import { runTotpGatedAction } from './two-factor.js'

let currentWallet = null
let prices = {}
let ledgerBalances = {}
let balanceListenerUnsub = null
let balancePollTimer = null

function getFirebaseApp() {
  return getApps()[0] || initializeApp(firebaseConfig)
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function startLiveBalanceListener(uid) {
  if (balanceListenerUnsub) balanceListenerUnsub()
  if (!uid) return
  const db = getDatabase(getFirebaseApp())
  balanceListenerUnsub = onValue(ref(db, `balances/${uid}`), (snap) => {
    const val = snap.val() || {}
    ledgerBalances = COINS.reduce((acc, c) => {
      acc[c.id] = Number(val[c.id] || 0)
      return acc
    }, {})
    COINS.forEach((coin) => setBalance(coin.id, coin.symbol, coin.geckoId, ledgerBalances[coin.id] ?? 0))
  })
}

async function fetchPrices() {
  try {
    const ids = COINS.map(c => c.geckoId).join(',')
    const res = await fetch(`/api/wallet/prices?ids=${ids}`)
    if (res.ok)  {
      prices = await res.json();
      console.log(prices);
    }
  } catch {

  }
}

export async function initWallet(uid) {
  const info = document.getElementById('wallet-info')
  info.innerHTML = '<p class="muted">Loading wallets…</p>'
  try {
    currentWallet = await apiInitWallet()
    renderWallet(currentWallet)
    fetchAndRenderBalances()
    startLiveBalanceListener(uid)

    if (balancePollTimer) clearInterval(balancePollTimer)

    balancePollTimer = setInterval(() => fetchAndRenderBalances({ silent: true }), 45000)
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

function handleWalletAction(action, coinId) {
  const coin = COINS.find(c => c.id === coinId)
  if (action === 'deposit') showDepositModal(coin)
  else if (action === 'send') showSendModal(coin)
}

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

function showSendModal(coin) {
  const overlay = makeModalOverlay()
  const maxBal = Number(ledgerBalances[coin.id] ?? 0)
  const platformBal = maxBal.toFixed(8)
  const FEE = { btc: '0.00005', eth: '0.001', usdt: '1', usdc: '1' }
  const fee = FEE[coin.id] ?? '—'
  const addrHint = coin.id === 'btc' ? 'bc1q…' : '0x…'
  const coinPriceUsd = Number(prices[coin.geckoId]?.usd) || null
  const maxBalUsd = coinPriceUsd ? maxBal * coinPriceUsd : null
  // Default to entering the amount in fiat when we have a price to convert
  // with — most people think in dollars first — falling back to the coin
  // unit when there's no price feed to switch with anyway.
  const defaultUnit = coinPriceUsd ? 'usd' : 'coin'

  overlay.querySelector('.modal').innerHTML = `
    <div class="modal-header">
      <h2>Send ${coin.symbol}</h2>
      <button class="btn-modal-close">✕</button>
    </div>
    <p class="muted" style="margin-bottom:0.75rem">
      Platform balance: <strong>${platformBal} ${coin.symbol}</strong>${maxBalUsd != null ? ` <span class="muted">(≈ $${maxBalUsd.toFixed(2)} USD)</span>` : ''}
    </p>
    <label class="form-label">Recipient</label>
    <input id="send-to" class="form-input" type="text"
      placeholder="@username or ${addrHint}" autocomplete="off" />
    <div id="send-recipient-preview" class="recipient-preview" style="display:none"></div>
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:0.75rem;">
      <label class="form-label" id="send-amount-label" style="margin:0;">Amount (${defaultUnit === 'usd' ? 'USD' : coin.symbol})</label>
      ${coinPriceUsd ? `<button id="btn-send-unit-toggle" type="button" class="btn-sm btn-secondary" style="font-size:0.75rem;padding:0.2rem 0.55rem;">Switch to ${defaultUnit === 'usd' ? coin.symbol : 'USD'}</button>` : ''}
    </div>
    <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.35rem;">
      <input id="send-amount" class="form-input" type="number" min="0" max="${defaultUnit === 'usd' ? maxBalUsd : maxBal}" step="any" placeholder="0.00" style="flex:1;" />
      <button id="btn-send-max" type="button" class="btn-sm btn-secondary">Max</button>
    </div>
    <p id="send-amount-equiv" class="muted" style="font-size:0.78rem;margin-top:0.3rem;"></p>
    <p class="muted" style="font-size:0.78rem;margin-top:0.2rem">
      On-chain fee if sending externally: ${fee} ${coin.symbol}
    </p>
    <div id="send-error" class="error" style="display:none;margin-top:0.5rem"></div>
    <button id="btn-send" class="btn-primary" style="margin-top:1rem;width:100%">Send</button>
  `
  bindModalClose(overlay)

  const amountInput = overlay.querySelector('#send-amount')
  const amountLabel = overlay.querySelector('#send-amount-label')
  const equivEl      = overlay.querySelector('#send-amount-equiv')
  const unitToggleBtn = overlay.querySelector('#btn-send-unit-toggle')
  let amountUnit = defaultUnit

  function amountInCoin() {
    const raw = parseFloat(amountInput.value)
    if (!raw || raw <= 0) return 0
    return amountUnit === 'usd' && coinPriceUsd ? raw / coinPriceUsd : raw
  }

  function updateEquivHint() {
    const coinAmount = amountInCoin()
    if (!coinAmount || !coinPriceUsd) { equivEl.textContent = ''; return }
    equivEl.textContent = amountUnit === 'coin'
      ? `≈ $${(coinAmount * coinPriceUsd).toFixed(2)} USD`
      : `≈ ${coinAmount.toFixed(8)} ${coin.symbol}`
  }

  amountInput.addEventListener('input', updateEquivHint)

  if (unitToggleBtn) {
    unitToggleBtn.addEventListener('click', () => {
      const coinAmount = amountInCoin()
      amountUnit = amountUnit === 'coin' ? 'usd' : 'coin'
      if (amountUnit === 'usd') {
        amountLabel.textContent = 'Amount (USD)'
        unitToggleBtn.textContent = `Switch to ${coin.symbol}`
        amountInput.max = maxBalUsd
        if (coinAmount > 0) amountInput.value = (coinAmount * coinPriceUsd).toFixed(2)
      } else {
        amountLabel.textContent = `Amount (${coin.symbol})`
        unitToggleBtn.textContent = 'Switch to USD'
        amountInput.max = maxBal
        if (coinAmount > 0) amountInput.value = coinAmount.toFixed(8)
      }
      updateEquivHint()
    })
  }

  overlay.querySelector('#btn-send-max').addEventListener('click', () => {
    if (amountUnit === 'usd' && maxBalUsd != null) {
      amountInput.value = maxBalUsd > 0 ? maxBalUsd.toFixed(2) : ''
    } else {
      amountInput.value = maxBal > 0 ? maxBal : ''
    }
    updateEquivHint()
  })

  const toInput   = overlay.querySelector('#send-to')
  const previewEl = overlay.querySelector('#send-recipient-preview')
  const errEl     = overlay.querySelector('#send-error')
  const btn       = overlay.querySelector('#btn-send')
  let resolveTimer = null
  let lastResolve  = null

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

    const amount = amountInCoin()
    errEl.style.display = 'none'
    if (!to)            { errEl.textContent = 'Enter a recipient.';   errEl.style.display = 'block'; return }
    if (!amount || amount <= 0) { errEl.textContent = 'Enter a valid amount.'; errEl.style.display = 'block'; return }

    if (amount > maxBal) {
      errEl.textContent = `You only have ${platformBal} ${coin.symbol} available.`
      errEl.style.display = 'block'
      return
    }

    let codeRequired = false
    try {
      const profile = await getMyProfile()
      codeRequired = !!profile?.withdraw_code_required
    } catch {
      // If we can't confirm the setting, fall through and let the backend
      // enforce it — it'll return a clear error if a code was actually required.
    }

    const handleSendResult = (res) => {
      overlay.remove()
      fetchAndRenderBalances()

      if (res.transfer_type === 'onchain' && res.withdrawal) {
        const done = makeModalOverlay()
        done.querySelector('.modal').innerHTML = `
          <div class="modal-header">
            <h2>Withdrawal queued</h2>
            <button class="btn-modal-close">✕</button>
          </div>
          <p class="muted">
            Your withdrawal has been queued and will be paid out shortly — it isn't sent
            instantly, since it's paid from the platform's treasury rather than signed on
            the spot. You can check its status on the Transactions page once it's processed.
          </p>
          <p style="margin-top:0.75rem;">
            <strong>${Number(res.withdrawal.amount).toFixed(8)} ${escHtml(coin.symbol)}</strong> to
            <code style="word-break:break-all;">${escHtml(res.withdrawal.to_address)}</code>
          </p>
          <p class="muted" style="font-size:0.8rem;margin-top:0.5rem">
            Fee deducted: ${res.withdrawal.fee_deducted} ${coin.symbol}
          </p>
        `
        bindModalClose(done)
      } else if (res.transfer_type === 'internal' && res.transfer) {
        const recipientLabel = lastResolve?.username ? `@${escHtml(lastResolve.username)}` : escHtml(to)
        const done = makeModalOverlay()
        done.querySelector('.modal').innerHTML = `
          <div class="modal-header">
            <h2>Sent</h2>
            <button class="btn-modal-close">✕</button>
          </div>
          <p class="muted">Transfer completed instantly — no network fee.</p>
          <p style="margin-top:0.75rem;">
            <strong>${Number(res.transfer.amount).toFixed(8)} ${escHtml(coin.symbol)}</strong> sent to <strong>${recipientLabel}</strong>
          </p>
        `
        bindModalClose(done)
      }
    }

    if (codeRequired) {
      const { result, cancelled, error } = await runTotpGatedAction(
        'send this', (code) => smartSend(to, coin.id, amount, code)
      )
      if (cancelled) return
      if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
      handleSendResult(result)
      return
    }

    btn.disabled = true; btn.textContent = 'Sending…'
    try {
      const res = await smartSend(to, coin.id, amount)
      handleSendResult(res)
    } catch (e) {
      errEl.textContent = e.message; errEl.style.display = 'block'
      btn.disabled = false; btn.textContent = 'Send'
    }
  })
}

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

async function fetchAndRenderBalances({ silent = false } = {}) {
  const btn = document.getElementById('btn-refresh-balances')
  if (!silent) {
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…' }
    COINS.forEach(({ id }) => {
      const el = document.getElementById(`balance-${id}`)
      if (el) el.innerHTML = '<span class="muted">…</span>'
      const usd = document.getElementById(`usd-${id}`)
      if (usd) usd.innerHTML = ''
    })
  }

  await fetchPrices()

  try {

    const ledger = await getLedgerBalance()
    setBalance('btc',  'BTC',  'bitcoin',  ledger.btc  ?? 0)
    setBalance('eth',  'ETH',  'ethereum', ledger.eth  ?? 0)
    setBalance('usdt', 'USDT', 'tether',   ledger.usdt ?? 0)
    setBalance('usdc', 'USDC', 'usd-coin', ledger.usdc ?? 0)
    ledgerBalances = { btc: ledger.btc ?? 0, eth: ledger.eth ?? 0, usdt: ledger.usdt ?? 0, usdc: ledger.usdc ?? 0 }
  } catch {
    if (!silent) {
      COINS.forEach(({ id }) => {
        const el = document.getElementById(`balance-${id}`)
        if (el) el.innerHTML = '<span class="muted">unavailable</span>'
      })
    }
  } finally {
    if (!silent && btn) { btn.disabled = false; btn.textContent = '↻ Refresh Balances' }
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
