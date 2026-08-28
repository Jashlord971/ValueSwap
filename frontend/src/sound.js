
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

  }
}

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
