/**
 * H8 Identity — Post-Quantum (ML-DSA65 / CRYSTALS-Dilithium)
 *
 * Ogni utente M4TR1X ha un H8-ID derivato da una keypair ML-DSA65.
 * ML-DSA65 è lo standard NIST FIPS-204 (2024) — resistente a computer quantistici.
 *
 * H8 Address = 'H8' + SHA3-256(publicKey)[0:38]  → 40 caratteri totali
 *
 * Il secret key è cifrato a riposo con AES-256-GCM + scrypt (password utente).
 * In sessione, l'identità sbloccata vive in memoria.
 */

const crypto = require('crypto')
const path   = require('path')
const fs     = require('fs')
const { sha3_256 } = require('@noble/hashes/sha3')
const { bytesToHex } = require('@noble/hashes/utils')

// ─── ESM lazy load (noble è ESM-only) ────────────────────────────────────────
let _lib = null
async function getLib() {
  if (!_lib) _lib = await import('@noble/post-quantum/ml-dsa.js')
  return _lib
}

// ─── Session state ────────────────────────────────────────────────────────────
let _unlocked = null   // { address, publicKey, secretKey } — null quando wallet bloccato

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getIdentityPath() {
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'h8identity.enc')
  } catch {
    const base = process.env.M4TR1X_DATA_DIR || process.cwd()
    return path.join(base, 'h8identity.enc')
  }
}

function h8AddressFrom(publicKeyHex) {
  const buf = Buffer.from(publicKeyHex, 'hex')
  return 'H8' + bytesToHex(sha3_256(buf)).substring(0, 38)
}

function encryptSecret(secretKeyHex, password) {
  const salt    = crypto.randomBytes(32)
  const key     = crypto.scryptSync(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })
  const iv      = crypto.randomBytes(12)
  const cipher  = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc     = Buffer.concat([cipher.update(secretKeyHex, 'utf8'), cipher.final()])
  return {
    salt:      salt.toString('hex'),
    iv:        iv.toString('hex'),
    authTag:   cipher.getAuthTag().toString('hex'),
    encrypted: enc.toString('hex'),
  }
}

function decryptSecret(stored, password) {
  const opts = stored.version === 2 ? { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } : {}
  const key     = crypto.scryptSync(password, Buffer.from(stored.salt, 'hex'), 32, opts)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(stored.authTag, 'hex'))
  return decipher.update(Buffer.from(stored.encrypted, 'hex'), null, 'utf8') + decipher.final('utf8')
}

// ─── API pubblica ─────────────────────────────────────────────────────────────

/**
 * Genera una nuova identità H8 e la salva cifrata su disco.
 * Restituisce address e publicKey (il secretKey NON viene mai esposto).
 */
async function generateIdentity(password) {
  const { ml_dsa65 } = await getLib()
  const { secretKey, publicKey } = ml_dsa65.keygen()
  const pubHex = Buffer.from(publicKey).toString('hex')
  const secHex = Buffer.from(secretKey).toString('hex')
  const address = h8AddressFrom(pubHex)

  const stored = {
    version:   2,
    algorithm: 'ML-DSA65',
    address,
    publicKey: pubHex,
    ...encryptSecret(secHex, password),
  }

  fs.writeFileSync(getIdentityPath(), JSON.stringify(stored))
  console.log(`[H8] Identità creata: ${address}`)
  return { address, publicKey: pubHex }
}

/**
 * Sblocca il wallet. Il secret key resta in memoria per tutta la sessione.
 * @returns {{ address, publicKey }}
 */
async function unlockIdentity(password) {
  const p = getIdentityPath()
  if (!fs.existsSync(p)) throw new Error('H8 identity non trovata. Crea prima un wallet.')

  const stored = JSON.parse(fs.readFileSync(p, 'utf8'))
  let secretKey
  try {
    secretKey = decryptSecret(stored, password)
  } catch {
    throw new Error('Password errata o file identità corrotto.')
  }

  _unlocked = { address: stored.address, publicKey: stored.publicKey, secretKey }

  if (stored.version !== 2) {
    const fresh = encryptSecret(secretKey, password)
    const upgraded = { ...stored, version: 2, ...fresh }
    fs.writeFileSync(p, JSON.stringify(upgraded))
    console.log('[H8] scrypt migrated v1→v2 (N=131072)')
  }

  console.log(`[H8] Wallet sbloccato: ${stored.address}`)
  return { address: stored.address, publicKey: stored.publicKey }
}

function lockIdentity() {
  _unlocked = null
  console.log('[H8] Wallet bloccato.')
}

function getUnlockedIdentity() {
  return _unlocked
}

// Deriva una chiave secp256k1 (schnorr/Nostr) in modo deterministico dalla chiave H8.
// La chiave privata non lascia mai il server.
function deriveSigningKey() {
  if (!_unlocked) return null
  const sk   = Buffer.from(_unlocked.secretKey, 'hex')
  const seed = crypto.createHash('sha256').update(sk.slice(0, 64)).digest()
  const { schnorr } = require('@noble/curves/secp256k1')
  return { privKey: seed, pubKeyHex: Buffer.from(schnorr.getPublicKey(seed)).toString('hex') }
}

function identityExists() {
  return fs.existsSync(getIdentityPath())
}

/** Legge address e publicKey senza sbloccare (non richiede password). */
function getPublicInfo() {
  const p = getIdentityPath()
  if (!fs.existsSync(p)) return null
  const stored = JSON.parse(fs.readFileSync(p, 'utf8'))
  return { address: stored.address, publicKey: stored.publicKey }
}

/**
 * Firma dati con il secret key dell'identità sbloccata.
 * Lancia errore se il wallet è bloccato.
 */
async function signWithUnlocked(data) {
  if (!_unlocked) throw new Error('H8 wallet bloccato.')
  const { ml_dsa65 } = await getLib()
  const sk  = Buffer.from(_unlocked.secretKey, 'hex')
  const msg = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))
  return Buffer.from(ml_dsa65.sign(msg, sk)).toString('hex')
}

/**
 * Verifica una firma ML-DSA65.
 */
async function verifySignature(publicKeyHex, data, signatureHex) {
  const { ml_dsa65 } = await getLib()
  const pk  = Buffer.from(publicKeyHex, 'hex')
  const msg = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))
  const sig = Buffer.from(signatureHex, 'hex')
  try {
    return ml_dsa65.verify(sig, msg, pk)
  } catch {
    return false
  }
}

module.exports = {
  generateIdentity,
  unlockIdentity,
  lockIdentity,
  getUnlockedIdentity,
  deriveSigningKey,
  identityExists,
  getPublicInfo,
  h8AddressFrom,
  signWithUnlocked,
  verifySignature,
}
