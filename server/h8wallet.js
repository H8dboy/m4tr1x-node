/**
 * H8 Wallet v3 — thin layer on h8token + h8identity
 *
 * Key management: h8identity.js (ML-DSA65, NIST FIPS-204, post-quantum)
 * Ledger ops:     h8token.js   (SHA3-256 hash chain, fixed supply 100M H8)
 *
 * The heavy secp256k1/BIP39/argon2id wallet logic is removed.
 * There is one identity per node; all token operations use the unlocked identity.
 */

'use strict'

const token = require('./h8token')
const h8id  = require('./h8identity')

// ─── Identity management (delegates to h8identity) ────────────────────────────

function identityExists() { return h8id.identityExists() }
function isLocked()       { return !h8id.getUnlockedIdentity() }

function getAddress() {
  const id = h8id.getUnlockedIdentity()
  return id ? id.address : (h8id.getPublicInfo()?.address || null)
}

function getPublicInfo() { return h8id.getPublicInfo() }

/** Create a new ML-DSA65 identity (replaces BIP39 generateWallet). */
async function generateWallet(password) {
  if (!password) throw new Error('password required')
  const id = await h8id.generateIdentity(password)
  return {
    address: id.address,
    pubkey:  id.publicKey,
    mnemonic: null,         // ML-DSA65 has no mnemonic — user must back up the identity file
    path: 'ML-DSA65 (NIST FIPS-204)',
    warning: 'Back up your identity file — there is no seed phrase recovery.',
  }
}

/** Unlock the identity with password. */
async function unlockWallet(password) {
  return h8id.unlockIdentity(password)
}

/** Lock the identity. */
function lockWallet() { return h8id.lockIdentity() }

/**
 * saveWallet — no-op in v3.
 * h8identity manages its own encrypted storage; there is nothing to save separately.
 */
function saveWallet(params) {
  return { address: params.address }
}

/**
 * importWallet — BIP39 mnemonic import is not supported in ML-DSA65 architecture.
 * Use the identity file backup to restore on a new node.
 */
function importWallet() {
  throw new Error('BIP39 import not available in post-quantum architecture. Restore the identity file from backup.')
}

/**
 * listWallets — returns the single node identity as a one-element array
 * so existing callers (e.g. heartbeat registration) keep working.
 */
function listWallets() {
  const info = h8id.getPublicInfo()
  if (!info) return []
  return [{
    address:         info.address,
    pubkey:          info.publicKey,
    version:         3,
    scheme:          'ML-DSA65',
    locked:          isLocked(),
    failed_attempts: 0,
    created_at:      0,
  }]
}

/**
 * changePassword — ri-cifra il secretKey ML-DSA65 con la nuova password.
 * Delega a h8identity.changePassword: address, publicKey e chiave ML-DSA immutati.
 * `address` è ignorato — esiste una sola identità per nodo.
 *
 * @param {string} address    - ignorato (compat firma pubblica)
 * @param {string} oldPassword
 * @param {string} newPassword
 * @returns {{ address: string, publicKey: string }}
 */
async function changePassword(address, oldPassword, newPassword) {
  if (!oldPassword || !newPassword) throw new Error('old_password and new_password required')
  return h8id.changePassword(oldPassword, newPassword)
}

/**
 * resetLockout — ML-DSA65 identity has no lockout counter in the current implementation.
 */
function resetLockout() {
  return { ok: true, note: 'No lockout in ML-DSA65 identity.' }
}

/**
 * deleteWallet — destroying the node identity via API is intentionally disallowed.
 * Delete the identity file manually if needed.
 */
function deleteWallet() {
  throw new Error('Deleting the node identity via API is not permitted. Remove the identity file manually.')
}

// ─── Token operations (delegates to h8token) ──────────────────────────────────

/**
 * walletBalance — returns H8 token balance for an address.
 * If address is omitted, uses the current node identity address.
 */
function walletBalance(address) {
  const addr = address || getAddress() || ''
  const bal  = token.getBalance(addr)
  return { address: addr, balance: bal, symbol: 'H8' }
}

/**
 * walletHistory — returns ledger history for an address.
 */
function walletHistory(address, limit = 50) {
  const addr = address || getAddress() || ''
  return token.getHistory(addr, limit)
}

/**
 * walletSend — transfer H8 tokens to another address.
 *
 * Compatible with the old API: { address, password, toAddress, amountH8C, memo }
 * In v3, `address` and `password` are ignored if the identity is already unlocked.
 * If the identity is locked and `password` is provided, it is unlocked first.
 */
async function walletSend({ address, password, toAddress, amountH8C, memo = '' }) {
  if (!toAddress || !amountH8C) throw new Error('toAddress and amountH8C required')

  if (isLocked()) {
    if (!password) throw new Error('H8 wallet locked — provide password or unlock first')
    await h8id.unlockIdentity(password)
  }

  const amount = Math.floor(parseFloat(amountH8C))
  if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount')

  return token.transfer(toAddress, amount, memo || '')
}

// ─── Backward-compat constants ────────────────────────────────────────────────
const WALLET_VERSION = 3
const DERIV_PATH     = 'ML-DSA65/NIST-FIPS-204'

module.exports = {
  // Identity
  identityExists,
  isLocked,
  getAddress,
  getPublicInfo,
  generateWallet,
  unlockWallet,
  lockWallet,
  saveWallet,
  importWallet,
  listWallets,
  changePassword,
  resetLockout,
  deleteWallet,
  // Token ops
  walletBalance,
  walletHistory,
  walletSend,
  // Compat constants
  WALLET_VERSION,
  DERIV_PATH,
}
