export const MIN_AVATAR_NUMBER = 1
export const MAX_AVATAR_NUMBER = 21

const AVATAR_FILE_BY_NUMBER = {
  1: '1.png',
  2: '2.jpeg',
  3: '3.jpg',
  4: '4.jpg',
  5: '5.jpg',
  7: '7.jpg',
  8: '8.jpg',
  9: '9.jpg',
  10: '10.jpg',
  11: '11.jpg',
  12: '12.jpg',
  13: '13.jpg',
  14: '14.jpg',
  15: '15.jpg',
  16: '16.jpg',
  17: '17.jpg',
  18: '18.jpg',
  19: '19.jpg',
  20: '20.jpg',
  21: '21.png',
}

export function normalizeAvatarNumber(value, fallback = MIN_AVATAR_NUMBER) {
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) return fallback
  if (parsed < MIN_AVATAR_NUMBER) return MIN_AVATAR_NUMBER
  if (parsed > MAX_AVATAR_NUMBER) return MAX_AVATAR_NUMBER
  return parsed
}

export function avatarPathFromNumber(value) {
  const n = normalizeAvatarNumber(value)
  const fileName = AVATAR_FILE_BY_NUMBER[n] || `${n}.png`
  return `/avatars/${fileName}`
}

export function avatarNumberFromPhotoUrl(photoUrl) {
  if (typeof photoUrl !== 'string') return null
  const match = photoUrl.match(/\/avatars\/(\d+)\.(png|jpg|jpeg|webp)$/i)
  if (!match) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isNaN(parsed) ? null : parsed
}

export function avatarPathFromProfile(profile) {
  if (profile?.avatar_number != null) {
    return avatarPathFromNumber(profile.avatar_number)
  }

  const legacyNumber = avatarNumberFromPhotoUrl(profile?.photo_url)
  return avatarPathFromNumber(legacyNumber ?? MIN_AVATAR_NUMBER)
}

export function profileHref(username) {
  return username ? `/user/${encodeURIComponent(username)}` : null
}
