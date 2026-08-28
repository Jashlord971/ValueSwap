import { listOffers, createOffer, updateOffer, deleteOffer, toggleOfferStatus, listPaymentMethods, listCurrencies } from './api.js'
import { cacheGet } from './cache.js'

let currentUser = null
let editingOfferId = null
let paymentMethods = []
let allCurrencies  = []

export function initTrades(user) {
  currentUser = user
  loadMeta().then(() => {
    bindModal()
    loadMyOffers()
  })
}

async function loadMeta() {
  try {
    [paymentMethods, allCurrencies] = await Promise.all([listPaymentMethods(), listCurrencies()])
  } catch {  }
}

function bindSearchable(searchInput, hiddenInput, dropdown, getItems, onSelect) {
  let suppressBlur = false

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
        hiddenInput.value = item.value
        searchInput.value = item.label
        dropdown.classList.add('hidden')
        suppressBlur = false
        onSelect(item)
      })
    })
  }

  searchInput.addEventListener('input', () => render(searchInput.value.trim()))
  searchInput.addEventListener('focus', () => render(searchInput.value.trim()))
  searchInput.addEventListener('blur', () => {
    if (suppressBlur) return
    setTimeout(() => dropdown.classList.add('hidden'), 150)
  })

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
    .map(c => ({ value: c.code, label: `${c.code} â€” ${c.name}` }))
}

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

  document.getElementById('close-delete-modal').addEventListener('click', closeDeleteModal)
  document.getElementById('btn-delete-cancel').addEventListener('click', closeDeleteModal)
  document.getElementById('delete-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('delete-modal')) closeDeleteModal()
  })

  bindSearchable(
    document.getElementById('offer-card-search'),
    document.getElementById('offer-card'),
    document.getElementById('offer-card-dropdown'),
    pmItems,
    (item) => {
      updateCurrencyConstraint(item?.value ?? null)
      const currencyRow = document.getElementById('currency-field-row')
      if (item) {
        const pm = paymentMethods.find(p => p.id === item.value)
        if (pm?.allowed_currencies?.length === 1) {
          const code = pm.allowed_currencies[0]
          const cur = allCurrencies.find(c => c.code === code)
          document.getElementById('offer-currency').value = code
          document.getElementById('offer-currency-search').value = cur ? `${cur.code} â€” ${cur.name}` : code
        } else {

          document.getElementById('offer-currency').value = ''
          document.getElementById('offer-currency-search').value = ''
        }
        if (currencyRow) currencyRow.style.display = ''
        showEscrowInfo(pm)
      } else {

        document.getElementById('offer-currency').value = ''
        document.getElementById('offer-currency-search').value = ''
        if (currencyRow) currencyRow.style.display = 'none'
      }
    }
  )

  bindSearchable(
    document.getElementById('offer-currency-search'),
    document.getElementById('offer-currency'),
    document.getElementById('offer-currency-dropdown'),
    (query) => {
      const pmId = document.getElementById('offer-card').value
      const pm = paymentMethods.find(p => p.id === pmId)
      return currencyItems(query, pm?.allowed_currencies ?? null)
    },
    () => {}
  )
}

function updateCurrencyConstraint(pmId) {

  const pm = paymentMethods.find(p => p.id === pmId)
  const search = document.getElementById('offer-currency-search')
  if (search) {

    search.dispatchEvent(new Event('input'))
  }
  _ = pm
}

function showEscrowInfo(pm) {
  const info = document.getElementById('offer-escrow-info')
  if (!info || !pm) { if (info) info.style.display = 'none'; return }
  info.textContent = `Escrow fee: ${pm.escrow_fee_pct}% Â· Dispute fee: 5%`
  info.style.display = 'block'
}

function resetModal() {
  editingOfferId = null
  const buyRadio = document.querySelector('input[name="offer-type"][value="buy"]')
  if (buyRadio) buyRadio.checked = true
  document.getElementById('offer-card-search').value            = ''
  document.getElementById('offer-card').value                   = ''
  document.getElementById('offer-currency-search').value        = ''
  document.getElementById('offer-currency').value               = ''
  const currencyFieldRow = document.getElementById('currency-field-row')
  if (currencyFieldRow) currencyFieldRow.style.display = 'none'
  const defaultTerms = `Welcome! To complete this trade:\n1. Start the trade and say "Hello" in chat â€” wait for my response.\n2. I'll send you the payment details. Send payment, then share proof (screenshot or confirmation number).\n3. Once verified, I'll release immediately.\n\nNo invalid payments, chargebacks, or scams â€” violations will be disputed and reported.\n\nThanks for trading!`
  document.getElementById('offer-terms').value                  = defaultTerms
  document.getElementById('offer-profit').value                 = ''
  const timeLimitSel = document.getElementById('offer-time-limit')
  if (timeLimitSel) timeLimitSel.value = '1800'
  document.getElementById('offer-terms-count').textContent      = `${defaultTerms.length} / 500`
  document.getElementById('offer-modal-error').textContent      = ''
  document.getElementById('offer-modal-title').textContent      = 'New Offer'
  document.getElementById('btn-submit-offer').textContent       = 'Post Offer'
  const info = document.getElementById('offer-escrow-info')
  if (info) info.style.display = 'none'
}

function openEditModal(offer) {
  editingOfferId = offer.id
  const radio = document.querySelector(`input[name="offer-type"][value="${offer.offer_type}"]`)
  if (radio) radio.checked = true

  const pm = paymentMethods.find(p => p.id === offer.card)
          || paymentMethods.find(p => p.name.toLowerCase() === offer.card.toLowerCase())
  document.getElementById('offer-card').value        = pm ? pm.id : offer.card
  document.getElementById('offer-card-search').value = pm ? pm.name : offer.card

  const currencyFieldRowEdit = document.getElementById('currency-field-row')
  if (currencyFieldRowEdit) currencyFieldRowEdit.style.display = ''
  const cur = allCurrencies.find(c => c.code === offer.currency)
  document.getElementById('offer-currency').value        = offer.currency
  document.getElementById('offer-currency-search').value = cur ? `${cur.code} â€” ${cur.name}` : offer.currency

  document.getElementById('offer-terms').value             = offer.terms
  document.getElementById('offer-terms-count').textContent = `${offer.terms.length} / 500`
  document.getElementById('offer-profit').value            = offer.profit_pct
  const timeLimitSel = document.getElementById('offer-time-limit')
  if (timeLimitSel) timeLimitSel.value = String(offer.time_limit_secs || 1800)
  document.getElementById('offer-modal-error').textContent = ''
  document.getElementById('offer-modal-title').textContent = 'Edit Offer'
  document.getElementById('btn-submit-offer').textContent  = 'Save Changes'
  if (pm) showEscrowInfo(pm)
  document.getElementById('offer-modal').classList.remove('hidden')
}

async function handleSubmit() {
  const btn       = document.getElementById('btn-submit-offer')
  const errEl     = document.getElementById('offer-modal-error')
  const offerType = document.querySelector('input[name="offer-type"]:checked')?.value
  const card      = document.getElementById('offer-card').value
  const currency  = document.getElementById('offer-currency').value
  const terms     = document.getElementById('offer-terms').value.trim().replace(/[<>]/g, '')
  const profitPct = parseFloat(document.getElementById('offer-profit').value)
  const timeLimitSecs = parseInt(document.getElementById('offer-time-limit')?.value || '1800', 10)

  errEl.textContent = ''
  if (!offerType)                                               { errEl.textContent = 'Select buy or sell.'; return }
  if (!card)                                                    { errEl.textContent = 'Select a payment method.'; return }
  if (!currency)                                                { errEl.textContent = 'Select a currency.'; return }
  if (!terms)                                                   { errEl.textContent = 'Enter trade terms.'; return }
  if (terms.length > 500)                                       { errEl.textContent = 'Terms must be 500 characters or fewer.'; return }
  if (isNaN(profitPct) || profitPct < -100 || profitPct > 200) { errEl.textContent = 'Profit rate must be between -100 and 200.'; return }

  btn.disabled = true
  try {
    const data = { offer_type: offerType, card, currency, terms, profit_pct: profitPct, time_limit_secs: timeLimitSecs }
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

async function loadMyOffers() {
  const list = document.getElementById('offers-list')

  const cached = cacheGet('offers')
  if (cached) {
    renderOfferList(list, cached.filter(o => o.creator_uid === currentUser?.uid))
  } else {
    list.innerHTML = '<div class="list-loading"><span class="list-spinner"></span>Loading offersâ€¦</div>'
  }

  try {
    const all  = await listOffers()
    const mine = all.filter(o => o.creator_uid === currentUser?.uid)
    renderOfferList(list, mine)
  } catch (e) {
    if (!cached) list.innerHTML = `<p class="error">Failed to load offers: ${e.message}</p>`
  }
}

function renderOfferList(list, mine) {
  if (!mine.length) {
    list.innerHTML = '<p class="muted">You have no offers yet â€” click <strong>Add Offer</strong> to post one.</p>'
    return
  }

  list.innerHTML = `
    <div class="offer-rows">
      <div class="offer-row offer-row-header">
        <span class="offer-col-type">Type</span>
        <span class="offer-col-card">Payment Method</span>
        <span class="offer-col-currency">Currency</span>
        <span class="offer-col-status">Active</span>
        <span class="offer-col-satisfaction">Satisfaction</span>
        <span class="offer-col-profit">Profit</span>
        <span class="offer-col-actions">Actions</span>
      </div>
      ${mine.map(renderOfferRow).join('')}
    </div>`

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
      e.currentTarget.disabled = true
      const activate = o.status === 'inactive'
      try {
        await toggleOfferStatus(o.id, activate)
        await loadMyOffers()
      } catch (err) {
        showToast('Error: ' + err.message, 'error')
        e.currentTarget.disabled = false
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

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function renderSatisfaction(o) {
  const pos   = o.feedback_pos ?? 0
  const total = (o.feedback_pos ?? 0) + (o.feedback_neg ?? 0)
  if (total === 0) return `<span class="sat-none">â€”</span>`
  const pct = Math.round((pos / total) * 100)
  const cls = pct >= 75 ? 'sat-high' : pct >= 40 ? 'sat-mid' : 'sat-low'
  return `<span class="${cls}">${pos}/${total}</span>`
}

function renderOfferRow(o) {
  const isActive  = o.status === 'active'
  const typeLabel = o.offer_type === 'buy' ? 'BUY' : 'SELL'
  const typeClass = o.offer_type === 'buy' ? 'badge-buy' : 'badge-sell'
  const sign      = o.profit_pct >= 0 ? '+' : ''
  const pm        = paymentMethods.find(p => p.id === o.card)
  const pmName    = pm ? pm.name : esc(o.card)
  return `
    <div class="offer-row">
      <span class="offer-col-type"><span class="type-badge ${typeClass}">${typeLabel}</span></span>
      <span class="offer-col-card offer-row-card">${pmName}</span>
      <span class="offer-col-currency"><span class="currency-badge">${esc(o.currency || 'â€”')}</span></span>
      <span class="offer-col-status">
        <span class="status-pill ${isActive ? 'pill-active' : 'pill-inactive'}">${isActive ? 'Yes' : 'No'}</span>
      </span>
      <span class="offer-col-satisfaction">${renderSatisfaction(o)}</span>
      <span class="offer-col-profit offer-row-profit ${o.profit_pct >= 0 ? 'profit-pos' : 'profit-neg'}">${sign}${o.profit_pct}%</span>
      <span class="offer-col-actions">
        <div class="offer-menu">
          <button id="menu-btn-${o.id}" class="btn-menu-dots" title="Actions">&hellip;</button>
          <div id="menu-drop-${o.id}" class="offer-menu-dropdown hidden">
            <button id="toggle-${o.id}" class="menu-item">
              ${isActive ? 'Deactivate' : 'Activate'}
            </button>
            <button id="edit-${o.id}" class="menu-item">Edit</button>
            <button id="delete-${o.id}" class="menu-item menu-item-danger">Delete</button>
          </div>
        </div>
      </span>
    </div>`
}

export function openChat(tradeId, trade) {
  const section = document.getElementById('chat-section')
  section.classList.remove('hidden')
  document.getElementById('chat-trade-label').textContent =
    `Trade #${tradeId.slice(0, 8)}\u2026 \u2014 ${trade?.gift_card_brand ?? ''}`
  section.scrollIntoView({ behavior: 'smooth' })
  document.dispatchEvent(new CustomEvent('open-chat', { detail: { tradeId } }))
}
