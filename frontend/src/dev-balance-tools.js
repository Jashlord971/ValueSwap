import { setDevBalanceUsd, getCombinedUsdBalance } from './api.js'

function isDevLocal() {
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV) return true
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1'
}

export function ensureDevBalanceTools() {
  if (!isDevLocal()) return
  const nav = document.getElementById('navbar')
  if (!nav) return
  let btn = document.getElementById('dev-balance-btn')
  if (!btn) {
    btn = document.createElement('button')
    btn.id = 'dev-balance-btn'
    btn.className = 'btn-sm dev-balance-btn'
    btn.type = 'button'
    btn.textContent = 'Dev Balance'
    btn.title = 'Set coin balance from USD value (dev only)'

    btn.addEventListener('click', async () => {
      const coinRaw = window.prompt('Coin (btc, eth, usdt, usdc, trx):', 'btc')
      if (coinRaw == null) return
      const coin = coinRaw.trim().toLowerCase()
      if (!['btc', 'eth', 'usdt', 'usdc', 'trx'].includes(coin)) {
        window.alert('Invalid coin')
        return
      }

      const usdRaw = window.prompt('USD value to set for this coin:', '100')
      if (usdRaw == null) return
      const usd = Number(usdRaw)
      if (!Number.isFinite(usd) || usd < 0) {
        window.alert('Enter a valid USD amount >= 0')
        return
      }

      btn.disabled = true
      const old = btn.textContent
      btn.textContent = 'Setting...'
      try {
        const r = await setDevBalanceUsd(coin, usd)
        const combined = await getCombinedUsdBalance()
        await refreshNavCombinedBalance()
        window.dispatchEvent(new CustomEvent('ledger-updated'))
        window.alert(`Set ${r.coin} to ${Number(r.coin_amount).toFixed(8)} (${usd.toFixed(2)} USD).\nCombined balance: $${combined.toFixed(2)}`)
      } catch (e) {
        window.alert(`Failed: ${e.message || e}`)
      } finally {
        btn.disabled = false
        btn.textContent = old
      }
    })
  }

  let navLeft = nav.querySelector('.nav-left')
  if (!navLeft) {
    navLeft = document.createElement('div')
    navLeft.className = 'nav-left'
    nav.insertBefore(navLeft, nav.firstChild)
  }

  const logo = nav.querySelector('.logo')
  if (logo && logo.parentElement !== navLeft) {
    navLeft.appendChild(logo)
  }

  if (logo && logo.parentElement === navLeft) {
    logo.insertAdjacentElement('afterend', btn)
  } else {
    navLeft.insertBefore(btn, navLeft.firstChild)
  }
}

export async function refreshNavCombinedBalance() {
  const badge = document.getElementById('nav-available-balance')
  if (!badge) return
  try {
    const total = await getCombinedUsdBalance()
    badge.textContent = `Bal: $${total.toFixed(2)}`
  } catch {
    badge.textContent = 'Bal: unavailable'
  }
}
