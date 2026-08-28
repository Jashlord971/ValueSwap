
import { verifyLogin2fa } from './api.js'

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isCodeError(message) {
  return /incorrect code|too many incorrect codes/i.test(String(message || ''))
}

export function runTotpGatedAction(actionLabel, performFn) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px;">
        <div class="modal-header">
          <h2>Enter 2FA Code</h2>
          <button class="btn-modal-close" aria-label="Close">✕</button>
        </div>
        <p style="margin-top:1rem;">Enter the 6-digit code from your authenticator app to ${escapeHtml(actionLabel)}.</p>
        <input id="gated-2fa-input" class="form-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
               placeholder="123456"
               style="width:100%;font-size:1.35rem;letter-spacing:0.4rem;text-align:center;margin-top:0.6rem;" />
        <p id="gated-2fa-error" class="error" style="min-height:1.2em;margin-top:0.5rem;"></p>
        <div class="confirm-modal-actions" style="margin-top:0.5rem;">
          <button class="btn-cancel" id="gated-2fa-cancel">Cancel</button>
          <button class="btn" id="gated-2fa-submit">Confirm</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    const input = overlay.querySelector('#gated-2fa-input')
    const errEl = overlay.querySelector('#gated-2fa-error')
    const submitBtn = overlay.querySelector('#gated-2fa-submit')
    input.focus()

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      overlay.remove()
      resolve(value)
    }

    const cancel = () => finish({ cancelled: true })
    overlay.querySelector('#gated-2fa-cancel').addEventListener('click', cancel)
    overlay.querySelector('.btn-modal-close').addEventListener('click', cancel)

    const submit = async () => {
      const code = input.value.trim()
      if (!/^\d{6}$/.test(code)) {
        errEl.textContent = 'Enter the 6-digit code.'
        return
      }
      submitBtn.disabled = true
      errEl.textContent = ''
      try {
        const result = await performFn(code)
        finish({ result })
      } catch (e) {
        if (isCodeError(e?.message)) {
          errEl.textContent = e.message
          input.select()
        } else {
          finish({ error: e })
        }
      } finally {
        submitBtn.disabled = false
      }
    }

    submitBtn.addEventListener('click', submit)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
  })
}

function sessionKey(uid) {
  return `2fa-verified:${uid}`
}

export function gateLoginTwoFactor(profile) {
  if (!profile?.totp_enabled || !profile?.uid) return Promise.resolve()

  let alreadyVerified = false
  try { alreadyVerified = sessionStorage.getItem(sessionKey(profile.uid)) === '1' } catch {}
  if (alreadyVerified) return Promise.resolve()

  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.id = 'login-2fa-overlay'
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px;">
        <div class="modal-header"><h2>2FA Required</h2></div>
        <p style="margin-top:1rem;">Enter the 6-digit code from your authenticator app to continue.</p>
        <input id="login-2fa-input" class="form-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
               placeholder="123456"
               style="width:100%;font-size:1.35rem;letter-spacing:0.4rem;text-align:center;margin-top:0.6rem;" />
        <p id="login-2fa-error" class="error" style="min-height:1.2em;margin-top:0.5rem;"></p>
        <button class="btn" id="login-2fa-submit" style="width:100%;margin-top:0.4rem;">Verify</button>
      </div>
    `
    document.body.appendChild(overlay)

    const input = overlay.querySelector('#login-2fa-input')
    const errEl = overlay.querySelector('#login-2fa-error')
    const btn = overlay.querySelector('#login-2fa-submit')
    input.focus()

    const submit = async () => {
      const code = input.value.trim()
      if (!/^\d{6}$/.test(code)) {
        errEl.textContent = 'Enter the 6-digit code.'
        return
      }
      btn.disabled = true
      errEl.textContent = ''
      try {
        await verifyLogin2fa(code)
        try { sessionStorage.setItem(sessionKey(profile.uid), '1') } catch {}
        overlay.remove()
        resolve()
      } catch (e) {
        errEl.textContent = e.message || 'Incorrect code.'
        input.select()
      } finally {
        btn.disabled = false
      }
    }

    btn.addEventListener('click', submit)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })

  })
}
