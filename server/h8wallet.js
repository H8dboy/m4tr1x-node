/**
 * H8 Wallet — BIP39 HD wallet for H8 Coin (H8C)
 *
 * Key derivation: BIP39 mnemonic → 512-bit seed → SLIP-0010/BIP32 HD tree
 * Path: m/44'/8888'/0'/0/index  (coin_type 8888 = H8C)
 *
 * The wallet privkey is the same secp256k1 keypair used everywhere in M4TR1X.
 * Sending a transaction calls h8coin.createTransaction() directly.
 *
 * Storage (local wallets):
 *   ~/.m4tr1x/wallets/<address>.json  →  { name, address, pubkey, enc_privkey, salt }
 *   The privkey is AES-256-GCM encrypted with a user password + PBKDF2(SHA-512).
 */

'use strict'

const crypto   = require('crypto')
const fs       = require('fs')
const path     = require('path')
const bip39    = require('bip39')
const { hmac }        = require('@noble/hashes/hmac.js')
const { sha512 }      = require('@noble/hashes/sha2.js')
const { sha256 }      = require('@noble/hashes/sha2.js')
const { bytesToHex, hexToBytes } = require('@noble/hashes/utils.js')
const secp     = require('@noble/secp256k1')
const coin     = require('./h8coin')

// ─── Constants ────────────────────────────────────────────────────────────────
const H8C_COIN_TYPE = 8888        // BIP-44 coin type for H8C
const DERIV_PATH    = `m/44'/${H8C_COIN_TYPE}'/0'/0/0`
const WALLETS_DIR   = path.join(
  process.env.M4TR1X_DATA_DIR || path.join(require('os').homedir(), '.m4tr1x'),
  'wallets'
)

if (!fs.existsSync(WALLETS_DIR)) fs.mkdirSync(WALLETS_DIR, { recursive: true })

// ─── SLIP-0010 / BIP32 for secp256k1 ─────────────────────────────────────────

const MASTER_KEY = Buffer.from('Bitcoin seed')   // SLIP-0010 master key constant

function deriveMaster(seed) {
  const I = hmac(sha512, MASTER_KEY, seed)
  return {
    key:    I.slice(0, 32),   // 256-bit private key
    chain:  I.slice(32, 64),  // 256-bit chain code
  }
}

// Hardened child: index >= 0x80000000
// Normal child:   index <  0x80000000
function deriveChild(parentKey, parentChain, index) {
  const hardened = index >= 0x80000000
  let data
  if (hardened) {
    data = Buffer.concat([Buffer.from([0x00]), parentKey, uint32be(index)])
  } else {
    const pubkey = secp.getPublicKey(parentKey, true)
    data = Buffer.concat([pubkey, uint32be(index)])
  }
  const I = hmac(sha512, parentChain, data)
  const IL = I.slice(0, 32)
  const IR = I.slice(32, 64)

  // child key = (IL + parent key) mod n
  const ILnum    = BigInt('0x' + bytesToHex(IL))
  const parNum   = BigInt('0x' + bytesToHex(parentKey))
  const ORDER    = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n
  const childKey = (ILnum + parNum) % ORDER

  if (childKey === 0n || ILnum >= ORDER) throw new Error('HD derivation: invalid key — try next index')

  // Pad to 32 bytes
  const childKeyHex = childKey.toString(16).padStart(64, '0')
  return {
    key:   hexToBytes(childKeyHex),
    chain: IR,
  }
}

function uint32be(n) {
  const buf = Buffer.allocUnsafe(4)
  buf.writeUInt32BE(n >>> 0, 0)
  return buf
}

function parsePath(pathStr) {
  return pathStr.split('/').slice(1).map(seg => {
    const hardened = seg.endsWith("'")
    const idx = parseInt(hardened ? seg.slice(0, -1) : seg, 10)
    return hardened ? idx + 0x80000000 : idx
  })
}

function deriveFromSeed(seedBytes, pathStr = DERIV_PATH) {
  let node = deriveMaster(seedBytes)
  for (const idx of parsePath(pathStr)) {
    node = deriveChild(node.key, node.chain, idx)
  }
  return bytesToHex(node.key)
}

// ─── Wallet creation ──────────────────────────────────────────────────────────

function walletFromPrivkey(privkeyHex) {
  const pubkey  = coin.privkeyToPubkey(privkeyHex)
  const address = coin.pubkeyToAddress(pubkey)
  return { privkeyHex, pubkey, address }
}

function generateWallet() {
  const mnemonic  = bip39.generateMnemonic(128)   // 12 words
  const seed      = bip39.mnemonicToSeedSync(mnemonic)
  const privkey   = deriveFromSeed(seed)
  const wallet    = walletFromPrivkey(privkey)
  return { mnemonic, ...wallet, path: DERIV_PATH }
}

function importWallet(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic.trim())) throw new Error('INVALID_MNEMONIC')
  const seed    = bip39.mnemonicToSeedSync(mnemonic.trim())
  const privkey = deriveFromSeed(seed)
  return walletFromPrivkey(privkey)
}

// ─── Encryption helpers (privkey at rest) ─────────────────────────────────────
// AES-256-GCM, key derived via PBKDF2-SHA512(password, salt, 210000 iter)

function encryptPrivkey(privkeyHex, password) {
  const salt    = crypto.randomBytes(32)
  const key     = crypto.pbkdf2Sync(password, salt, 210_000, 32, 'sha512')
  const iv      = crypto.randomBytes(12)
  const cipher  = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc     = Buffer.concat([cipher.update(Buffer.from(privkeyHex, 'hex')), cipher.final()])
  const tag     = cipher.getAuthTag()
  return {
    salt: salt.toString('hex'),
    iv:   iv.toString('hex'),
    tag:  tag.toString('hex'),
    ct:   enc.toString('hex'),
  }
}

function decryptPrivkey(enc, password) {
  const salt   = Buffer.from(enc.salt, 'hex')
  const key    = crypto.pbkdf2Sync(password, salt, 210_000, 32, 'sha512')
  const iv     = Buffer.from(enc.iv, 'hex')
  const tag    = Buffer.from(enc.tag, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    const dec = Buffer.concat([decipher.update(Buffer.from(enc.ct, 'hex')), decipher.final()])
    return dec.toString('hex')
  } catch {
    throw new Error('WRONG_PASSWORD')
  }
}

// ─── Local wallet storage ─────────────────────────────────────────────────────

function walletFile(address) {
  return path.join(WALLETS_DIR, address + '.json')
}

function saveWallet({ address, pubkey, privkeyHex, name = '' }, password) {
  const enc  = encryptPrivkey(privkeyHex, password)
  const data = { version: 1, name, address, pubkey, enc_privkey: enc, created_at: Math.floor(Date.now() / 1000) }
  fs.writeFileSync(walletFile(address), JSON.stringify(data, null, 2))
  return data
}

function loadWallet(address, password) {
  const file = walletFile(address)
  if (!fs.existsSync(file)) throw new Error('WALLET_NOT_FOUND')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const privkeyHex = decryptPrivkey(data.enc_privkey, password)
  return { ...data, privkeyHex }
}

function listWallets() {
  return fs.readdirSync(WALLETS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(WALLETS_DIR, f), 'utf8'))
        return { address: d.address, name: d.name || '', pubkey: d.pubkey, created_at: d.created_at }
      } catch { return null }
    })
    .filter(Boolean)
}

function deleteWallet(address) {
  const file = walletFile(address)
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

// ─── High-level wallet API ────────────────────────────────────────────────────

async function walletSend({ address, password, toAddress, amountH8C, memo = '' }) {
  const w         = loadWallet(address, password)
  const amountSat = coin.parseH8C(String(amountH8C))
  return coin.createTransaction({ fromPrivkey: w.privkeyHex, toAddress, amountSat, memo })
}

function walletBalance(address) {
  const satoshis = coin.getBalance(address)
  return { address, satoshis: String(satoshis), h8c: coin.formatH8C(satoshis) }
}

function walletHistory(address, limit = 50) {
  return coin.getTxHistory(address, limit).map(tx => ({
    txid:       tx.txid,
    direction:  tx.from_addr === address ? 'out' : 'in',
    from:       tx.from_addr,
    to:         tx.to_addr,
    amount_sat: tx.amount_sat,
    h8c:        coin.formatH8C(BigInt(tx.amount_sat)),
    fee_sat:    tx.fee_sat,
    memo:       tx.memo,
    created_at: tx.created_at,
    status:     tx.status,
  }))
}

// ─── Nostr-wallet bridge (use node identity key for transactions) ─────────────
// The node operator can bind their Nostr privkey to a wallet without a separate mnemonic.

function walletFromNostrKey(nostrPrivkeyHex) {
  return walletFromPrivkey(nostrPrivkeyHex)
}

module.exports = {
  generateWallet,
  importWallet,
  saveWallet,
  loadWallet,
  listWallets,
  deleteWallet,
  walletSend,
  walletBalance,
  walletHistory,
  walletFromNostrKey,
  walletFromPrivkey,
  DERIV_PATH,
  H8C_COIN_TYPE,
}
