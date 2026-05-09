import { scanCard, checkCard } from './api.js'
import { showAlert } from './modal.js'

export function initCards() {
  document.getElementById('btn-scan-card').addEventListener('click', handleScan)
}

async function handleScan() {
  const fileInput = document.getElementById('card-image-input')
  const result    = document.getElementById('scan-result')
  const btn       = document.getElementById('btn-scan-card')
  const file      = fileInput.files[0]

  if (!file) { showAlert('Please select a gift card image first'); return }

  btn.disabled    = true
  btn.textContent = 'Scanning…'
  result.innerHTML = '<p class="muted">Processing image…</p>'

  try {
    // Convert image to base64 and strip the data-URL prefix
    const dataUrl    = await readAsDataURL(file)
    const base64Data = dataUrl.split(',')[1]

    const ocr = await scanCard(base64Data)

    if (!ocr.detected_numbers.length) {
      result.innerHTML = '<p class="muted">No card numbers detected. Try a clearer photo.</p>'
      return
    }

    result.innerHTML = `
      <h3>Detected Numbers</h3>
      <ul class="number-list">
        ${ocr.detected_numbers.map((n) => `<li><code>${n}</code></li>`).join('')}
      </ul>
      <details>
        <summary>Full OCR text</summary>
        <pre class="ocr-raw">${escapeHtml(ocr.raw_text)}</pre>
      </details>
      <div id="check-results"></div>
    `

    // Check every detected number against the platform's card registry
    const checks = document.getElementById('check-results')
    for (const num of ocr.detected_numbers) {
      try {
        const check = await checkCard(num)
        if (check.seen_before) {
          checks.innerHTML += `
            <p class="warning">⚠️ <code>${num}</code> has been seen
            ${check.count} time(s) on this platform — this card may already be used.</p>`
        }
      } catch {
        // Non-critical — continue checking others
      }
    }
    if (!checks.innerHTML) {
      checks.innerHTML = '<p class="success">✓ None of the detected numbers appear in our database.</p>'
    }

  } catch (e) {
    result.innerHTML = `<p class="error">Scan failed: ${e.message}</p>`
  } finally {
    btn.disabled    = false
    btn.textContent = 'Scan Card'
  }
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
