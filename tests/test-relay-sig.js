#!/usr/bin/env node
/**
 * Test: Relay Schnorr signature verification (Audit fix #1)
 *
 * Tests verifyNostrEvent() in isolation — no WebSocket server is started.
 * Covers the bug where relay.js accepted events without verifying the Schnorr signature,
 * allowing any client to impersonate any pubkey.
 */
'use strict'

const assert = require('node:assert/strict')
const { webcrypto } = require('crypto')
if (!globalThis.crypto) globalThis.crypto = webcrypto

const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools')
const { verifyNostrEvent } = require('../server/nostr-verify')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`)
    failed++
  }
}

console.log('\n=== Relay Signature Verification Tests (Audit #1) ===\n')

// Generate a real Nostr keypair and a properly-signed event
const sk = generateSecretKey()

const validEvent = finalizeEvent({
  kind:       1,
  content:    'M4TR1X test event',
  created_at: Math.floor(Date.now() / 1000),
  tags:       [],
}, sk)

// Test 1: a properly signed event must be accepted
test('valid event with correct Schnorr signature is accepted', () => {
  assert.ok(verifyNostrEvent(validEvent) === true,
    'Expected verifyNostrEvent(validEvent) to return true')
})

// Test 2: same event with the last 2 hex chars of sig flipped — must be rejected
// This is the original bug: the relay accepted this without checking
test('event with tampered signature is rejected (original bug)', () => {
  const lastTwo  = validEvent.sig.slice(-2)
  const flipped  = lastTwo === '00' ? 'ff' : '00'
  const tampered = { ...validEvent, sig: validEvent.sig.slice(0, -2) + flipped }
  assert.ok(verifyNostrEvent(tampered) === false,
    'Expected verifyNostrEvent(tampered) to return false')
})

// Test 3: event whose ID does not match its content — must be rejected
test('event with mismatched ID (content spoofing) is rejected', () => {
  const spoofed = { ...validEvent, id: '00'.repeat(32) }
  assert.ok(verifyNostrEvent(spoofed) === false,
    'Expected verifyNostrEvent(spoofed) to return false')
})

// Test 4: event with a completely different (wrong) pubkey — must be rejected
// This replicates the impersonation attack the bug enabled
test('event with wrong pubkey (impersonation) is rejected', () => {
  const otherSk   = generateSecretKey()
  const otherPk   = getPublicKey(otherSk)
  const impersonated = { ...validEvent, pubkey: otherPk }
  assert.ok(verifyNostrEvent(impersonated) === false,
    'Expected verifyNostrEvent(impersonated) to return false')
})

// Test 5: malformed input must never throw
test('malformed event (missing sig) returns false without throwing', () => {
  const noSig = { ...validEvent, sig: undefined }
  assert.doesNotThrow(() => verifyNostrEvent(noSig))
  assert.ok(verifyNostrEvent(noSig) === false)
})

test('null input returns false without throwing', () => {
  assert.doesNotThrow(() => verifyNostrEvent(null))
  assert.ok(verifyNostrEvent(null) === false)
})

console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
