import {
  listOffers,
  createOffer,
  updateOffer,
  deleteOffer,
  toggleOfferStatus,
  listPaymentMethods,
  listCurrencies,
  listSwapOffers,
  createSwapOffer,
  acceptSwapOffer,
  cancelSwapOffer,
  listTrades,
} from './api.js'
import { cacheGet } from './cache.js'
import { COIN_LOGOS } from './coin-logos.js'

let currentUser = null
let editingOfferId = null
let paymentMethods = []   // [{id, name, method_type, allowed_currencies, escrow_fee_pct}]
let allCurrencies  = []   // [{code, name}]
let allTrades      = []   // [{id, offer_id, ...}]

export function initTrades(user) {
  currentUser = user
  loadMeta().then(() => {
    bindModal()
    loadMyOffers()
  })
}

export function initSwapOffers(user) {
  currentUser = user
  loadMeta().then(() => {
    bindSwapModal()
    loadSwapMarketOffers()
    loadMySwapOffers()
    if (window.location.hash === '#swap') {
      document.getElementById('swap-modal')?.classList.remove('hidden')
    }
  })
}

async function loadMeta() {
  try {
    [paymentMethods, allCurrencies] = await Promise.all([listPaymentMethods(), listCurrencies()])
  } catch { /* use empty arrays — form will show no suggestions */ }
}

// ── Searchable combo-box helper ───────────────────────────────────────────────

/**
 * Wires a searchable dropdown onto:
 *   searchInput  — visible text input
 *   hiddenInput  — stores the selected value
 *   dropdown     — <ul> element to populate
 * getItems(query) → [{value, label, secondary?}]
 * onSelect(item) — called when user picks an item
 */
function bindSearchable(searchInput, hiddenInput, dropdown, getItems, onSelect) {
  let suppressBlur = false

  function commitSelection(item) {
    hiddenInput.value = item?.value ?? ''
    searchInput.value = item?.label ?? ''
    dropdown.classList.add('hidden')
    suppressBlur = false
    onSelect(item ?? null)
  }

  function findExactMatch(query) {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return null
    return getItems(query).find(item =>
      item.label.toLowerCase() === normalized || item.value.toLowerCase() === normalized
    ) || null
  }

  function render(query) {
    const items = getItems(query)
    if (!items.length) { dropdown.classList.add('hidden'); return }
    dropdown.innerHTML = items.map(it => `
      <li data-value="${esc(it.value)}">
        <span class="sd-label">${esc(it.label)}</span>
        ${it.secondary ? `<span class="sd-secondary">${esc(it.secondary)}</span>` : ''}
      </li>`).join('')
    dropdown.classList.remove('hidden')
    dropdown.querySelectorAll('li').forEach(li => {
      li.addEventListener('mousedown', () => { suppressBlur = true })
      li.addEventListener('click', () => {
        const item = items.find(i => i.value === li.dataset.value)
        commitSelection(item)
      })
    })
  }

  searchInput.addEventListener('input', () => render(searchInput.value.trim()))
  searchInput.addEventListener('focus', () => render(searchInput.value.trim()))
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const item = findExactMatch(searchInput.value)
    if (!item) return
    e.preventDefault()
    commitSelection(item)
  })
  searchInput.addEventListener('blur', () => {
    if (suppressBlur) return
    setTimeout(() => {
      const query = searchInput.value.trim()
      if (!query) {
        dropdown.classList.add('hidden')
        return
      }
      const item = findExactMatch(query)
      if (item) {
        commitSelection(item)
        return
      }
      hiddenInput.value = ''
      onSelect(null)
      dropdown.classList.add('hidden')
    }, 150)
  })
  // Clear hidden value if user empties text
  searchInput.addEventListener('input', () => {
    if (!searchInput.value.trim()) { hiddenInput.value = ''; onSelect(null) }
  })
}

function pmItems(query) {
  const q = query.toLowerCase()
  return paymentMethods
    .filter(pm => pm.name.toLowerCase().includes(q) || pm.id.toLowerCase().includes(q))
    .slice(0, 12)
    .map(pm => ({
      value: pm.id,
      label: pm.name,
      secondary: pm.method_type === 'gift_card' ? 'Gift Card'
                : pm.method_type === 'bank_transfer' ? 'Bank Transfer'
                : 'Mobile App',
    }))
}

function currencyItems(query, allowedCodes) {
  const q = query.toLowerCase()
  return allCurrencies
    .filter(c => {
      if (allowedCodes && !allowedCodes.includes(c.code)) return false
      return c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
    })
    .slice(0, 15)
    .map(c => ({ value: c.code, label: `${c.code} — ${c.name}` }))
}

function findPaymentMethodByValue(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  return paymentMethods.find(pm =>
    pm.id.toLowerCase() === normalized || pm.name.toLowerCase() === normalized
  ) || null
}

function getActivePaymentMethod() {
  const hiddenValue = document.getElementById('offer-card')?.value || ''
  const searchValue = document.getElementById('offer-card-search')?.value || ''
  return findPaymentMethodByValue(hiddenValue) || findPaymentMethodByValue(searchValue)
}

function syncCurrencyField(pm = getActivePaymentMethod()) {
  const currencySearch = document.getElementById('offer-currency-search')
  const currencyHidden = document.getElementById('offer-currency')
  const dropdown = document.getElementById('offer-currency-dropdown')
  if (!currencySearch || !currencyHidden) return

  if (pm) {
    document.getElementById('offer-card').value = pm.id
    currencySearch.disabled = false
    currencySearch.placeholder = 'Search currency…'
    return
  }

  currencySearch.disabled = true
  currencySearch.placeholder = 'Choose payment method first'
  currencySearch.value = ''
  currencyHidden.value = ''
  dropdown?.classList.add('hidden')
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function bindModal() {
  const modal    = document.getElementById('offer-modal')
  const btnNew   = document.getElementById('btn-new-offer')
  const btnClose = document.getElementById('close-offer-modal')
  const textarea = document.getElementById('offer-terms')
  const counter  = document.getElementById('offer-terms-count')

  btnNew.addEventListener('click', () => { resetModal(); modal.classList.remove('hidden') })
  btnClose.addEventListener('click', () => modal.classList.add('hidden'))
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden') })
  textarea.addEventListener('input', () => {
    counter.textContent = `${textarea.value.length} / 500`
  })
  document.getElementById('btn-submit-offer').addEventListener('click', handleSubmit)

  // Wire delete confirm modal
  document.getElementById('close-delete-modal').addEventListener('click', closeDeleteModal)
  document.getElementById('btn-delete-cancel').addEventListener('click', closeDeleteModal)
  document.getElementById('delete-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('delete-modal')) closeDeleteModal()
  })

  // Wire payment method picker — when PM selected, filter currencies
  bindSearchable(
    document.getElementById('offer-card-search'),
    document.getElementById('offer-card'),
    document.getElementById('offer-card-dropdown'),
    pmItems,
    (item) => {
      updateCurrencyConstraint(item?.value ?? null)
      if (item) {
        const pm = paymentMethods.find(p => p.id === item.value)
        syncCurrencyField(pm)
        if (pm?.allowed_currencies?.length === 1) {
          const code = pm.allowed_currencies[0]
          const cur = allCurrencies.find(c => c.code === code)
          document.getElementById('offer-currency').value = code
          document.getElementById('offer-currency-search').value = cur ? `${cur.code} — ${cur.name}` : code
        } else {
          // Clear currency when PM changes
          document.getElementById('offer-currency').value = ''
          document.getElementById('offer-currency-search').value = ''
        }
        showEscrowInfo(pm)
      } else {
        syncCurrencyField(null)
      }
    }
  )

  document.getElementById('offer-card-search').addEventListener('blur', () => {
    const pm = getActivePaymentMethod()
    syncCurrencyField(pm)
    if (pm) showEscrowInfo(pm)
  })

  // Wire currency picker (constraints applied dynamically)
  bindSearchable(
    document.getElementById('offer-currency-search'),
    document.getElementById('offer-currency'),
    document.getElementById('offer-currency-dropdown'),
    (query) => {
      const pm = getActivePaymentMethod()
      return pm ? currencyItems(query, pm.allowed_currencies ?? null) : []
    },
    () => {}
  )

  syncCurrencyField(null)
}

function updateCurrencyConstraint(pmId) {
  // Re-render with new constraints when PM changes
  const search = document.getElementById('offer-currency-search')
  if (search) {
    // Trigger re-filter
    search.dispatchEvent(new Event('input'))
  }
}

function showEscrowInfo(pm) {
  const info = document.getElementById('offer-escrow-info')
  if (!info || !pm) { if (info) info.style.display = 'none'; return }
  info.textContent = `Escrow fee: ${pm.escrow_fee_pct}% · Dispute fee: 5%`
  info.style.display = 'block'
}

function resolveCurrencySelection() {
  const hidden = document.getElementById('offer-currency')
  const search = document.getElementById('offer-currency-search')
  const hiddenValue = String(hidden?.value || '').trim().toUpperCase()
  if (hiddenValue) return hiddenValue

  const raw = String(search?.value || '').trim()
  if (!raw) return ''

  // Accept either "USD" or "USD — United States Dollar" typed in the search box.
  const typedCode = raw.split('—')[0].trim().toUpperCase()
  const exact = allCurrencies.find(c => c.code === typedCode)
  if (!exact) return ''

  if (hidden) hidden.value = exact.code
  return exact.code
}

function resetModal() {
  editingOfferId = null
  const buyRadio = document.querySelector('input[name="offer-type"][value="buy"]')
  if (buyRadio) buyRadio.checked = true
  document.getElementById('offer-card-search').value            = ''
  document.getElementById('offer-card').value                   = ''
  document.getElementById('offer-currency-search').value        = ''
  document.getElementById('offer-currency').value               = ''
  document.getElementById('offer-coin').value                   = ''
  syncCurrencyField(null)
  const defaultTerms = `Welcome! To complete this trade:\n1. Start the trade and say "Hello" in chat — wait for my response.\n2. I'll send you the payment details. Send payment, then share proof (screenshot or confirmation number).\n3. Once verified, I'll release immediately.\n\nNo invalid payments, chargebacks, or scams — violations will be disputed and reported.\n\nThanks for trading!`
  document.getElementById('offer-terms').value                  = defaultTerms
  document.getElementById('offer-profit').value                 = ''
  const timeLimitSel = document.getElementById('offer-time-limit')
  if (timeLimitSel) timeLimitSel.value = '1800'
  document.getElementById('offer-terms-count').textContent      = `${defaultTerms.length} / 500`
  document.getElementById('offer-modal-error').textContent      = ''
  document.getElementById('offer-modal-title').textContent      = 'New Offer'
  document.getElementById('btn-submit-offer').textContent       = 'Post Offer'
  document.getElementById('offer-min-amount').value             = ''
  document.getElementById('offer-max-amount').value             = ''
  const info = document.getElementById('offer-escrow-info')
  if (info) info.style.display = 'none'
}

function openEditModal(offer) {
  editingOfferId = offer.id
  const radio = document.querySelector(`input[name="offer-type"][value="${offer.offer_type}"]`)
  if (radio) radio.checked = true

  // Restore payment method — match by id first, fall back to name for old offers
  const pm = paymentMethods.find(p => p.id === offer.card)
          || paymentMethods.find(p => p.name.toLowerCase() === offer.card.toLowerCase())
  document.getElementById('offer-card').value        = pm ? pm.id : offer.card
  document.getElementById('offer-card-search').value = pm ? pm.name : offer.card

    // Restore currency
    syncCurrencyField(pm || findPaymentMethodByValue(offer.card))
  const cur = allCurrencies.find(c => c.code === offer.currency)
  document.getElementById('offer-currency').value        = offer.currency
  document.getElementById('offer-currency-search').value = cur ? `${cur.code} — ${cur.name}` : offer.currency

  // Restore coin
  document.getElementById('offer-coin').value = offer.coin || ''

  document.getElementById('offer-terms').value             = offer.terms
  document.getElementById('offer-terms-count').textContent = `${offer.terms.length} / 500`
  document.getElementById('offer-profit').value            = offer.profit_pct
  const timeLimitSel = document.getElementById('offer-time-limit')
  if (timeLimitSel) timeLimitSel.value = String(offer.time_limit_secs || 1800)
  document.getElementById('offer-modal-error').textContent = ''
  document.getElementById('offer-modal-title').textContent = 'Edit Offer'
  document.getElementById('btn-submit-offer').textContent  = 'Save Changes'
  document.getElementById('offer-min-amount').value       = offer.min_amount || ''
  document.getElementById('offer-max-amount').value       = offer.max_amount || ''
  if (pm) showEscrowInfo(pm)
  document.getElementById('offer-modal').classList.remove('hidden')
}

async function handleSubmit() {
  const btn       = document.getElementById('btn-submit-offer')
  const errEl     = document.getElementById('offer-modal-error')
  const offerType = document.querySelector('input[name="offer-type"]:checked')?.value
  const card      = document.getElementById('offer-card').value
  const currency  = resolveCurrencySelection()
  const coin      = document.getElementById('offer-coin').value
  const terms     = document.getElementById('offer-terms').value.trim().replace(/[<>]/g, '')
  const profitPct = parseFloat(document.getElementById('offer-profit').value)
  const timeLimitSecs = parseInt(document.getElementById('offer-time-limit')?.value || '1800', 10)
  const minAmount = document.getElementById('offer-min-amount').value
  const maxAmount = document.getElementById('offer-max-amount').value
  const minAmountVal = minAmount ? parseFloat(minAmount) : undefined
  const maxAmountVal = maxAmount ? parseFloat(maxAmount) : undefined

  errEl.textContent = ''
  if (!offerType)                                               { errEl.textContent = 'Select buy or sell.'; return }
  if (!card)                                                    { errEl.textContent = 'Select a payment method.'; return }
  if (!currency)                                                { errEl.textContent = 'Select a currency.'; return }
  if (!coin)                                                    { errEl.textContent = 'Select a cryptocurrency.'; return }
  if (minAmountVal === undefined || maxAmountVal === undefined) { errEl.textContent = 'Set both minimum and maximum trade amounts.'; return }
  if (!terms)                                                   { errEl.textContent = 'Enter trade terms.'; return }
  if (terms.length > 500)                                       { errEl.textContent = 'Terms must be 500 characters or fewer.'; return }
  if (isNaN(profitPct) || profitPct < -100 || profitPct > 200) { errEl.textContent = 'Profit rate must be between -100 and 200.'; return }
  if (minAmountVal !== undefined && minAmountVal <= 0)          { errEl.textContent = 'Minimum amount must be positive.'; return }
  if (maxAmountVal !== undefined && maxAmountVal <= 0)          { errEl.textContent = 'Maximum amount must be positive.'; return }
  if (maxAmountVal !== undefined && minAmountVal !== undefined && maxAmountVal <= minAmountVal) { errEl.textContent = 'Maximum amount must be greater than minimum amount.'; return }

  btn.disabled = true
  try {
    const data = { offer_type: offerType, card, currency, coin, terms, profit_pct: profitPct, time_limit_secs: timeLimitSecs }
    if (minAmountVal !== undefined) data.min_amount = minAmountVal
    if (maxAmountVal !== undefined) data.max_amount = maxAmountVal
    if (editingOfferId) {
      await updateOffer(editingOfferId, data)
    } else {
      await createOffer(data)
    }
    document.getElementById('offer-modal').classList.add('hidden')
    await loadMyOffers()
  } catch (e) {
    errEl.textContent = e.message
  } finally {
    btn.disabled = false
  }
}

// ── Delete confirmation modal ────────────────────────────────────────────────

let pendingDeleteId = null

function confirmDelete(offerId) {
  pendingDeleteId = offerId
  document.getElementById('delete-modal').classList.remove('hidden')
  document.getElementById('btn-delete-confirm').onclick = async () => {
    const btn = document.getElementById('btn-delete-confirm')
    btn.disabled = true
    try {
      await deleteOffer(pendingDeleteId)
      closeDeleteModal()
      await loadMyOffers()
    } catch (err) {
      closeDeleteModal()
      showToast('Error: ' + err.message, 'error')
    } finally {
      btn.disabled = false
    }
  }
}

function closeDeleteModal() {
  pendingDeleteId = null
  document.getElementById('delete-modal').classList.add('hidden')
}

// ── Toast notification ────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'toast-container'
    document.body.appendChild(container)
  }
  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`
  toast.textContent = message
  container.appendChild(toast)
  requestAnimationFrame(() => toast.classList.add('toast-visible'))
  setTimeout(() => {
    toast.classList.remove('toast-visible')
    setTimeout(() => toast.remove(), 300)
  }, 3500)
}

// ── My Offers list ────────────────────────────────────────────────────────────

async function loadMyOffers() {
  const list = document.getElementById('offers-list')

  // Render from cache instantly if available
  const cached = cacheGet('offers')
  if (cached) {
    renderOfferList(list, sortMyOffers(cached.filter(o => o.creator_uid === currentUser?.uid)))
  } else {
    list.innerHTML = '<div class="list-loading"><span class="list-spinner"></span>Loading offers…</div>'
  }

  try {
    const [all, trades] = await Promise.all([listOffers(), listTrades()])
    allTrades = trades || []
    const mine = all.filter(o => o.creator_uid === currentUser?.uid)
    renderOfferList(list, sortMyOffers(mine))
  } catch (e) {
    if (!cached) list.innerHTML = `<p class="error">Failed to load offers: ${e.message}</p>`
  }
}

async function loadMySwapOffers() {
  const list = document.getElementById('swap-offers-list')
  if (!list) return
  list.innerHTML = '<div class="list-loading"><span class="list-spinner"></span>Loading swap offers…</div>'

  try {
    const mine = await listSwapOffers({ mine: true })
    const onlyMine = mine.filter((o) => o.creator_uid === currentUser?.uid)
    renderSwapOfferList(list, onlyMine)
  } catch (e) {
    list.innerHTML = `<p class="error">Failed to load swaps: ${e.message}</p>`
  }
}

async function loadSwapMarketOffers() {
  const list = document.getElementById('swap-market-list')
  if (!list) return
  list.innerHTML = '<div class="list-loading"><span class="list-spinner"></span>Loading market swaps…</div>'

  try {
    const offers = await listSwapOffers({ status: 'open' })
    const market = offers
      .filter((o) => o.creator_uid !== currentUser?.uid)
      .sort((a, b) => b.created_at - a.created_at)

    if (!market.length) {
      list.innerHTML = '<p class="muted">No open market swap offers right now.</p>'
      return
    }

    list.innerHTML = market.map((offer) => {
      const from = String(offer.from_coin || '').toUpperCase()
      const to = String(offer.to_coin || '').toUpperCase()
      const makerGets = Number(offer.to_amount || 0)
      const takerGets = Number(offer.from_amount || 0)
      const profitPct = Number(offer.taker_profit_pct || 0)
      return `
        <div class="offer-card" style="margin-bottom:0.75rem">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;">
            <div>
              <strong>Swap ${esc(to)} → ${esc(from)}</strong>
              <div class="muted" style="font-size:0.82rem">
                You pay ${makerGets.toFixed(8)} ${esc(to)} and receive ${takerGets.toFixed(8)} ${esc(from)}
              </div>
              <div class="muted" style="font-size:0.82rem">Taker profit: ${profitPct.toFixed(2)}%</div>
            </div>
            <button class="btn-sm" data-accept-swap="${esc(offer.id)}">Accept Swap</button>
          </div>
        </div>
      `
    }).join('')

    list.querySelectorAll('[data-accept-swap]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true
        try {
          await acceptSwapOffer(btn.getAttribute('data-accept-swap'))
          showToast('Swap accepted', 'info')
          await loadMySwapOffers()
        } catch (e) {
          showToast(`Error: ${e.message}`, 'error')
          btn.disabled = false
        }
      })
    })
  } catch (e) {
    list.innerHTML = `<p class="error">Failed to load market swaps: ${e.message}</p>`
  }
}

function bindSwapModal() {
  const modal = document.getElementById('swap-modal')
  const openBtn = document.getElementById('btn-new-swap')
  const closeBtn = document.getElementById('close-swap-modal')
  const submit = document.getElementById('btn-submit-swap')

  if (!modal || !openBtn || !closeBtn || !submit) return

  openBtn.addEventListener('click', () => {
    resetSwapModal()
    modal.classList.remove('hidden')
  })
  closeBtn.addEventListener('click', () => modal.classList.add('hidden'))
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden')
  })

  submit.addEventListener('click', async () => {
    const fromCoin = document.getElementById('swap-from-coin').value
    const toCoin = document.getElementById('swap-to-coin').value
    const fromAmount = parseFloat(document.getElementById('swap-from-amount').value)
    const takerProfitPct = parseFloat(document.getElementById('swap-taker-profit').value)
    const expiresInSecs = parseInt(document.getElementById('swap-expiry').value, 10)
    const errEl = document.getElementById('swap-modal-error')

    errEl.textContent = ''
    if (!fromCoin || !toCoin) {
      errEl.textContent = 'Choose both coins.'
      return
    }
    if (fromCoin === toCoin) {
      errEl.textContent = 'From and to coin must be different.'
      return
    }
    if (!Number.isFinite(fromAmount) || fromAmount <= 0) {
      errEl.textContent = 'Enter a valid amount to send.'
      return
    }
    if (!Number.isFinite(takerProfitPct) || takerProfitPct < 0 || takerProfitPct > 50) {
      errEl.textContent = 'Enter a valid taker profit between 0% and 50%.'
      return
    }

    submit.disabled = true
    try {
      await createSwapOffer({
        from_coin: fromCoin,
        to_coin: toCoin,
        from_amount: fromAmount,
        taker_profit_pct: takerProfitPct,
        expires_in_secs: expiresInSecs,
      })
      modal.classList.add('hidden')
      await loadMySwapOffers()
      showToast('Swap offer posted', 'info')
    } catch (e) {
      errEl.textContent = e.message
    } finally {
      submit.disabled = false
    }
  })
}

function resetSwapModal() {
  const fromCoin = document.getElementById('swap-from-coin')
  const toCoin = document.getElementById('swap-to-coin')
  const fromAmount = document.getElementById('swap-from-amount')
  const takerProfit = document.getElementById('swap-taker-profit')
  const expiry = document.getElementById('swap-expiry')
  const err = document.getElementById('swap-modal-error')
  if (fromCoin) fromCoin.value = 'usdc'
  if (toCoin) toCoin.value = 'eth'
  if (fromAmount) fromAmount.value = ''
  if (takerProfit) takerProfit.value = '2.5'
  if (expiry) expiry.value = '3600'
  if (err) err.textContent = ''
}

function renderSwapOfferList(list, offers) {
  if (!offers.length) {
    list.innerHTML = '<p class="muted">No swap offers yet — click <strong>Add Swap</strong> to create one.</p>'
    return
  }

  list.innerHTML = offers
    .sort((a, b) => b.created_at - a.created_at)
    .map((offer) => {
      const remainingFrom = offer.remaining_from_amount ?? offer.from_amount
      const remainingTo = offer.remaining_to_amount ?? offer.to_amount
      const status = String(offer.status || 'open').toLowerCase()
      const isOpen = status === 'open'
      return `
        <div class="offer-card" style="margin-bottom:0.75rem">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem">
            <div>
              <strong>${esc(offer.from_coin.toUpperCase())}</strong> → <strong>${esc(offer.to_coin.toUpperCase())}</strong>
              <div class="muted" style="font-size:0.82rem">
                Total: ${Number(offer.from_amount).toFixed(8)} ${esc(offer.from_coin.toUpperCase())} for ${Number(offer.to_amount).toFixed(8)} ${esc(offer.to_coin.toUpperCase())}
              </div>
              <div class="muted" style="font-size:0.82rem">
                Taker profit: ${Number(offer.taker_profit_pct || 0).toFixed(2)}%
              </div>
              <div class="muted" style="font-size:0.82rem">
                Remaining: ${Number(remainingFrom).toFixed(8)} / ${Number(remainingTo).toFixed(8)}
              </div>
            </div>
            <div style="display:flex;gap:0.5rem;align-items:center">
              <span class="status-pill ${isOpen ? 'pill-active' : 'pill-inactive'}">${esc(status)}</span>
              ${isOpen ? `<button class="btn-sm" data-cancel-swap="${esc(offer.id)}">Cancel</button>` : ''}
            </div>
          </div>
        </div>
      `
    })
    .join('')

  list.querySelectorAll('[data-cancel-swap]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true
      try {
        await cancelSwapOffer(btn.getAttribute('data-cancel-swap'))
        await loadMySwapOffers()
      } catch (e) {
        showToast(`Error: ${e.message}`, 'error')
        btn.disabled = false
      }
    })
  })
}

function sortMyOffers(offers) {
  return [...offers].sort((a, b) => {
    const pmA = getPaymentMethodSortLabel(a)
    const pmB = getPaymentMethodSortLabel(b)
    const pmCompare = pmA.localeCompare(pmB, undefined, { sensitivity: 'base' })
    if (pmCompare !== 0) return pmCompare

    const aActive = a.status === 'active' ? 1 : 0
    const bActive = b.status === 'active' ? 1 : 0
    if (aActive !== bActive) return bActive - aActive

    const currencyCompare = String(a.currency || '').localeCompare(String(b.currency || ''), undefined, { sensitivity: 'base' })
    if (currencyCompare !== 0) return currencyCompare

    return (b.created_at || 0) - (a.created_at || 0)
  })
}

function getPaymentMethodSortLabel(offer) {
  const pm = paymentMethods.find(p => p.id === offer.card)
        || paymentMethods.find(p => p.name.toLowerCase() === String(offer.card || '').toLowerCase())
  return String(pm?.name || offer.card || '').toLowerCase()
}

function countTradesForOffer(offerId) {
  return (allTrades || []).filter(t => t.offer_id === offerId).length
}

function renderOfferList(list, mine) {
  if (!mine.length) {
    list.innerHTML = '<p class="muted">You have no offers yet — click <strong>Add Offer</strong> to post one.</p>'
    return
  }

  list.innerHTML = `
    <div class="offer-card-stack">
      ${mine.map(renderOfferCard).join('')}
    </div>`

  // close any open dropdown when clicking outside
  document.addEventListener('click', e => {
    if (!e.target.closest('.offer-menu')) {
      document.querySelectorAll('.offer-menu-dropdown').forEach(d => d.classList.add('hidden'))
    }
  }, { capture: true })

  mine.forEach(o => {
    document.getElementById(`menu-btn-${o.id}`)?.addEventListener('click', e => {
      e.stopPropagation()
      const drop = document.getElementById(`menu-drop-${o.id}`)
      document.querySelectorAll('.offer-menu-dropdown').forEach(d => {
        if (d !== drop) d.classList.add('hidden')
      })
      drop.classList.toggle('hidden')
    })

    document.getElementById(`toggle-${o.id}`)?.addEventListener('click', async e => {
      const btn = e.currentTarget
      if (btn) btn.disabled = true
      const inlineErr = document.getElementById(`offer-error-${o.id}`)
      if (inlineErr) {
        inlineErr.textContent = ''
        inlineErr.classList.add('hidden')
      }
      const activate = o.status === 'inactive'
      try {
        await toggleOfferStatus(o.id, activate)
        await loadMyOffers()
      } catch (err) {
        const msg = err?.message || 'Unable to update offer status'
        if (inlineErr) {
          inlineErr.textContent = msg
          inlineErr.classList.remove('hidden')
        }
        showToast('Error: ' + msg, 'error')
        if (btn && btn.isConnected) btn.disabled = false
      }
    })

    document.getElementById(`edit-${o.id}`)?.addEventListener('click', () => {
      openEditModal(o)
    })

    document.getElementById(`delete-${o.id}`)?.addEventListener('click', () => {
      confirmDelete(o.id)
    })
  })
}

// Escape user content before inserting into innerHTML
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function renderSatisfaction(o) {
  const pos   = o.feedback_pos ?? 0
  const total = (o.feedback_pos ?? 0) + (o.feedback_neg ?? 0)
  if (total === 0) return `<span class="sat-none">—</span>`
  const pct = Math.round((pos / total) * 100)
  const cls = pct >= 75 ? 'sat-high' : pct >= 40 ? 'sat-mid' : 'sat-low'
  return `<span class="${cls}">${pos}/${total}</span>`
}

function getCoinIcon(coin) {
  const normalized = String(coin || '').trim().toUpperCase()
  const logo = COIN_LOGOS[normalized]
  if (!logo) {
    return `<span class="offer-coin-fallback">${esc(normalized || '?')}</span>`
  }
  return `
    <span class="offer-coin-logo-wrap" title="${esc(normalized)}">
      <img class="offer-coin-logo" src="${logo}" alt="${esc(normalized)} logo" />
    </span>`
}

function renderOfferCard(o) {
  const isActive  = o.status === 'active'
  const typeLabel = o.offer_type === 'buy' ? 'BUY' : 'SELL'
  const typeClass = o.offer_type === 'buy' ? 'badge-buy' : 'badge-sell'
  const sign      = o.profit_pct >= 0 ? '+' : ''
  const pm        = paymentMethods.find(p => p.id === o.card)
  const pmName    = esc(pm ? pm.name : o.card)
  const min = o.min_amount != null ? `${Number(o.min_amount).toFixed(2)} ${esc(o.currency)}` : '—'
  const max = o.max_amount != null ? `${Number(o.max_amount).toFixed(2)} ${esc(o.currency)}` : '—'
  const tradeCount = countTradesForOffer(o.id)

  return `
    <article class="offer-card offer-card--my">
      <div class="offer-card-top">
        <div class="offer-card-badges">
          <span class="type-badge ${typeClass}">${typeLabel}</span>
          ${getCoinIcon(o.coin || '?')}
          <span class="status-pill ${isActive ? 'pill-active' : 'pill-inactive'}">${isActive ? 'Active' : 'Inactive'}</span>
          ${o.max_amount_auto_adjusted ? '<span class="flag-auto-adjusted" title="Max amount auto-adjusted based on your balance">Auto-adjusted</span>' : ''}
        </div>
        <div class="offer-menu">
          <button id="menu-btn-${o.id}" class="btn-menu-dots" title="Actions">&hellip;</button>
          <div id="menu-drop-${o.id}" class="offer-menu-dropdown hidden">
            <button id="toggle-${o.id}" class="menu-item">${isActive ? 'Deactivate' : 'Activate'}</button>
            <button id="edit-${o.id}" class="menu-item">Edit</button>
            <button id="delete-${o.id}" class="menu-item menu-item-danger">Delete</button>
          </div>
        </div>
      </div>

      <div class="offer-card-body">
        <div class="offer-card-main">
          <div class="offer-card-title">${pmName}</div>
          <div class="offer-card-subtitle">${esc(o.currency || '—')}</div>
        </div>
        <div class="offer-card-stats">
          <div class="offer-card-stat">
            <span class="offer-card-stat-label">Satisfaction</span>
            <span class="offer-card-stat-value">${renderSatisfaction(o)}</span>
          </div>
          <div class="offer-card-stat">
            <span class="offer-card-stat-label">Profit</span>
            <span class="offer-card-stat-value offer-row-profit ${o.profit_pct >= 0 ? 'profit-pos' : 'profit-neg'}">${sign}${o.profit_pct}%</span>
          </div>
        </div>
      </div>

      <div class="offer-card-meta">
        <div class="offer-card-meta-item">
          <span class="offer-card-meta-label">Trade amounts</span>
          <span class="offer-card-meta-value">${min} to ${max}</span>
        </div>
        <span class="offer-card-meta-divider" aria-hidden="true"></span>
        <div class="offer-card-meta-item offer-card-meta-item--trades">
          <span class="offer-card-meta-label">Trades</span>
          <span class="offer-card-meta-value offer-card-trades-value">${tradeCount}</span>
        </div>
      </div>

      <div id="offer-error-${o.id}" class="offer-card-inline-error hidden" style="margin-top:0.85rem;color:var(--danger);font-weight:600;line-height:1.35"></div>
    </article>`
}

export function openChat(tradeId, trade) {
  const section = document.getElementById('chat-section')
  section.classList.remove('hidden')
  document.getElementById('chat-trade-label').textContent =
    `Trade #${tradeId.slice(0, 8)}\u2026 \u2014 ${trade?.gift_card_brand ?? ''}`
  section.scrollIntoView({ behavior: 'smooth' })
  document.dispatchEvent(new CustomEvent('open-chat', { detail: { tradeId } }))
}
