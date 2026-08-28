
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')

const sa = JSON.parse(fs.readFileSync('./serviceAccount.json'))

function getToken() {
  return new Promise((resolve, reject) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      sub: sa.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: [
        'https://www.googleapis.com/auth/devstorage.full_control',
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/firebase'
      ].join(' ')
    })).toString('base64url')
    const sig = crypto.createSign('RSA-SHA256').update(header + '.' + payload).sign(sa.private_key, 'base64url')
    const jwt = header + '.' + payload + '.' + sig
    const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        const parsed = JSON.parse(d)
        if (!parsed.access_token) reject(new Error('No token: ' + d))
        else resolve(parsed.access_token)
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function request(hostname, path, method, token, body) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: 'Bearer ' + token }
    if (body) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(body)
    }
    const req = https.request({ hostname, path, method, headers }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function main() {
  console.log('Getting service account token...')
  const token = await getToken()
  console.log('Token obtained.')

  console.log('\nListing all Firebase Storage buckets...')
  const list = await request('firebasestorage.googleapis.com', '/v1beta/projects/cardswaphub/buckets', 'GET', token)
  console.log('List status:', list.status, list.body.substring(0, 600))

  const bucketId = 'cardswaphub.firebasestorage.app'
  const encodedBucket = encodeURIComponent(bucketId)

  console.log('\nGetting bucket via Firebase Storage Management API...')
  const getBucket = await request('firebasestorage.googleapis.com', `/v1beta/projects/cardswaphub/buckets/${encodedBucket}`, 'GET', token)
  console.log('GET status:', getBucket.status)
  console.log(getBucket.body.substring(0, 400))

  if (getBucket.status === 200) {

    const corsBody = JSON.stringify({
      cors: [{
        origin: ['http://localhost:5173', 'http://localhost:5174', 'https://cardswaphub.web.app', 'https://cardswaphub.firebaseapp.com'],
        method: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
        responseHeader: ['Content-Type', 'Authorization', 'Content-Length'],
        maxAgeSeconds: 3600
      }]
    })
    console.log('\nPatching CORS...')
    const patch = await request('firebasestorage.googleapis.com', `/v1beta/projects/cardswaphub/buckets/${encodedBucket}?updateMask=cors`, 'PATCH', token, corsBody)
    console.log('PATCH status:', patch.status)
    console.log(patch.body)
  } else {

    console.log('\nTrying GCS JSON API fallback...')
    const corsBody = JSON.stringify({
      cors: [{
        origin: ['http://localhost:5173', 'http://localhost:5174', 'https://cardswaphub.web.app', 'https://cardswaphub.firebaseapp.com'],
        method: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
        responseHeader: ['Content-Type', 'Authorization', 'Content-Length'],
        maxAgeSeconds: 3600
      }]
    })
    const patch = await request('storage.googleapis.com', `/storage/v1/b/${encodedBucket}?fields=cors`, 'PATCH', token, corsBody)
    console.log('GCS PATCH status:', patch.status)
    console.log(patch.body.substring(0, 400))
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })
