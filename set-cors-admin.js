// set-cors-admin.js — sets CORS on Firebase Storage using firebase-admin SDK
const admin = require('firebase-admin')
const serviceAccount = require('./serviceAccount.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'cardswaphub.firebasestorage.app'
})

const bucket = admin.storage().bucket()

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
  console.log('Bucket name:', bucket.name)
  await bucket.setCorsConfiguration(corsConfig)
  const [metadata] = await bucket.getMetadata()
  console.log('CORS set successfully!')
  console.log(JSON.stringify(metadata.cors, null, 2))
  process.exit(0)
}

main().catch(e => {
  console.error('Error:', e.message)
  process.exit(1)
})
