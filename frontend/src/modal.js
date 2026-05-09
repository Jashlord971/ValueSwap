function makeOverlay(id) {
  document.getElementById(id)?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.id = id
  overlay.innerHTML = '<div class="modal wallet-action-modal"></div>'
  document.body.appendChild(overlay)
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  return overlay
}

export function showAlert(message) {
  const overlay = makeOverlay('alert-modal-overlay')
  overlay.querySelector('.modal').innerHTML = `
    <div class="modal-header">
      <h2>Notice</h2>
      <button class="btn-modal-close">✕</button>
    </div>
    <p style="margin-top:1rem">${message}</p>
    <button class="btn" style="margin-top:1.25rem;width:100%">OK</button>
  `
  const close = () => overlay.remove()
  overlay.querySelector('.btn-modal-close').addEventListener('click', close)
  overlay.querySelector('.btn').addEventListener('click', close)
}

export function showConfirm(message) {
  return new Promise(resolve => {
    const overlay = makeOverlay('confirm-modal-overlay')
    overlay.querySelector('.modal').innerHTML = `
      <div class="modal-header">
        <h2>Confirm</h2>
        <button class="btn-modal-close">✕</button>
      </div>
      <p style="margin-top:1rem">${message}</p>
      <div class="confirm-modal-actions" style="margin-top:1.25rem">
        <button class="btn-cancel">Cancel</button>
        <button class="btn btn-danger">Confirm</button>
      </div>
    `
    const dismiss = (result) => { overlay.remove(); resolve(result) }
    overlay.querySelector('.btn-modal-close').addEventListener('click', () => dismiss(false))
    overlay.querySelector('.btn-cancel').addEventListener('click', () => dismiss(false))
    overlay.querySelector('.btn-danger').addEventListener('click', () => dismiss(true))
  })
}

export function showFeedbackModal() {
  return new Promise(resolve => {
    const overlay = makeOverlay('feedback-modal-overlay')
    overlay.querySelector('.modal').innerHTML = `
      <div class="modal-header">
        <h2>Leave Feedback</h2>
        <button class="btn-modal-close">✕</button>
      </div>
      <p style="margin-top:1rem">Choose a rating and write at least 5 characters.</p>
      <div style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-top:1rem;">
        <button class="btn" data-feedback-value="positive">Positive</button>
        <button class="btn" data-feedback-value="negative">Negative</button>
      </div>
      <textarea id="feedback-comment" rows="5" maxlength="500" placeholder="Share your experience with this trader" style="width:100%;margin-top:1rem;resize:vertical;padding:0.75rem;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;"></textarea>
      <p id="feedback-error" class="error" style="display:none;margin-top:0.75rem"></p>
      <div class="confirm-modal-actions" style="margin-top:1.25rem">
        <button class="btn-cancel">Cancel</button>
        <button class="btn">Submit</button>
      </div>
    `

    let positive = true
    const close = (result) => { overlay.remove(); resolve(result) }
    const errorEl = overlay.querySelector('#feedback-error')
    const textarea = overlay.querySelector('#feedback-comment')
    const optionButtons = [...overlay.querySelectorAll('[data-feedback-value]')]

    const syncSelected = () => {
      optionButtons.forEach(btn => {
        const selected = (btn.dataset.feedbackValue === 'positive') === positive
        btn.classList.toggle('btn-success', selected && positive)
        btn.classList.toggle('btn-danger', selected && !positive)
      })
    }

    syncSelected()
    optionButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        positive = btn.dataset.feedbackValue === 'positive'
        syncSelected()
      })
    })

    const submit = () => {
      const comment = textarea.value.trim()
      if (comment.length < 5 || comment.length > 500) {
        errorEl.textContent = 'Feedback text must be between 5 and 500 characters.'
        errorEl.style.display = 'block'
        return
      }
      close({ positive, comment })
    }

    overlay.querySelector('.btn-modal-close').addEventListener('click', () => close(null))
    overlay.querySelector('.btn-cancel').addEventListener('click', () => close(null))
    overlay.querySelector('.confirm-modal-actions .btn').addEventListener('click', submit)
  })
}
