import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth'

function clearAllCache() {
  try {
    const keysToRemove = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith('cs:')) keysToRemove.push(k)
    }
    keysToRemove.forEach(k => sessionStorage.removeItem(k))
  } catch { /* ignore */ }
}

let auth

export function initAuth(app) {
  auth = getAuth(app)
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback)
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider()
  return signInWithPopup(auth, provider)
}

export async function logOut() {
  clearAllCache()
  return signOut(auth)
}

/** Returns a fresh Firebase ID token for the current user */
export async function getIdToken() {
  const user = auth.currentUser
  if (!user) throw new Error('Not authenticated')
  return user.getIdToken(/* forceRefresh= */ false)
}
