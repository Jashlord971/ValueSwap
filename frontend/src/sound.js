// sound.js — shared "toy" notification chime used across chat + popups.
// Browsers block audio until the user has interacted with the page at least
// once, so failures here are expected/harmless and always swallowed.

let audio = null
let unlocked = false

function getAudio() {
  if (!audio) {
    audio = new Audio('/sounds/notify.wav')
    audio.volume = 0.55
  }
  return audio
}

export function playNotifySound() {
  try {
    const el = getAudio()
    el.currentTime = 0
    void el.play().then(() => { unlocked = true }).catch(() => {})
  } catch {
    // ignore — autoplay restrictions or unsupported environment
  }
}

// Call once on first user gesture (click/keydown) to "warm up" playback so
// the very first real notification isn't swallowed by autoplay restrictions.
export function primeNotifySound() {
  if (unlocked) return
  const handler = () => {
    unlocked = true
    document.removeEventListener('click', handler)
    document.removeEventListener('keydown', handler)
  }
  document.addEventListener('click', handler, { once: true })
  document.addEventListener('keydown', handler, { once: true })
}
