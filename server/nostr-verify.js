/**
 * NIP-01 event verification — pure functions, no side effects.
 *
 * Exported separately so relay.js can be tested without starting the WebSocket server.
 *
 * nostr-tools' verifyEvent is broken in CJS mode (ESM/CJS compat issue, returns true always).
 * We implement verification directly with @noble/curves/secp256k1 (schnorr) which IS
 * available correctly in CJS — it is used by h8identity.js as well.
 *
 * NIP-01 §3 verification:
 *   1. event.id === SHA-256(JSON([0, pubkey, created_at, kind, tags, content]))
 *   2. schnorr.verify(sig, id, pubkey) — secp256k1 Schnorr signature
 */

'use strict'

const crypto     = require('crypto')
const { schnorr } = require('@noble/curves/secp256k1')

/**
 * Computes the canonical NIP-01 event ID.
 * The ID must equal SHA-256 of the JSON serialization of:
 *   [0, pubkey, created_at, kind, tags, content]
 */
function computeEventId(ev) {
  const serial = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])
  return crypto.createHash('sha256').update(serial).digest('hex')
}

/**
 * Returns true if ev passes full NIP-01 verification (ID hash + Schnorr signature).
 * Never throws — returns false on any error or malformed input.
 */
function verifyNostrEvent(ev) {
  try {
    if (typeof ev?.id !== 'string' || typeof ev?.pubkey !== 'string' || typeof ev?.sig !== 'string') return false
    // Step 1: ID integrity — protects against content spoofing
    if (computeEventId(ev) !== ev.id) return false
    // Step 2: Schnorr signature — protects against pubkey impersonation
    return schnorr.verify(ev.sig, ev.id, ev.pubkey)
  } catch {
    return false
  }
}

module.exports = { verifyNostrEvent, computeEventId }
