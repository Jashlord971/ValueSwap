// set-cors.js — applies CORS config to Firebase Storage bucket using a service account key
// Usage: node set-cors.js
// Requires: serviceAccount.json in the same directory (download from Firebase Console →
//   Project Settings → Service accounts → Generate new private key)

const { Storage } = require('@google-cloud/storage')

const storage = new Storage({ keyFilename: './serviceAccount.json' })
const bucket  = storage.bucket('cardswaphub.firebasestorage.app')

const corsConfig = [
  {
    origin: [
      'http://localhost:5173',
      'http://localhost:5174',
      'https://cardswaphub.web.app',
      'https://cardswaphub.firebaseapp.com',
    ],
    method: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
    responseHeader: ['Content-Type', 'Authorization', 'Content-Length'],
    maxAgeSeconds: 3600,
  },
]

async function main() {
  await bucket.setCorsConfiguration(corsConfig)
  const [metadata] = await bucket.getMetadata()
  console.log('CORS set successfully!')
  console.log(JSON.stringify(metadata.cors, null, 2))
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
