#!/usr/bin/env node
/**
 * Test: verifyChain ML-DSA signature verification (Audit fix #3)
 *
 * Previously verifyChain() only checked hash integrity; it did not call
 * verifySignature() on ML-DSA block signatures. A ledger with valid hashes
 * but fake signatures passed verification — this is the bug being fixed.
 *
 * Tests:
 *   1. Valid chain (genesis + real ML-DSA transfers) passes verifyChain
 *   2. Tampered ML-DSA signature on a non-genesis block is detected
 *   3. from_pubkey stored in block corresponds to the correct signing address
 *
 * Node-repo note: genesis uses deterministic 'genesis:...' signatures (not ML-DSA).
 * verifyChain must skip them and only verify ML-DSA on regular transfer blocks.
 *
 * NOTE: scrypt(N=131072) is used in h8identity — tests take ~3-4s total.
 */
'use strict'

const assert  = require('node:assert/strict')
const fs      = require('fs')
const os      = require('os')
const path    = require('path')

// ── Isolated temp directory ───────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4tr1x-node-h8token-test-'))
process.env.M4TR1X_DATA_DIR = tmpDir

// Load h8identity first (to get the test address before setting H8_FOUNDER_ADDRESS)
;[
  '../server/h8identity',
  '../server/h8token',
].forEach(m => { try { delete require.cache[require.resolve(m)] } catch {} })

const h8id = require('../server/h8identity')

let passed = 0
let failed = 0

async function test (name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`)
    failed++
  }
}

console.log('\n=== H8 Token verifyChain Signature Verification Tests — node repo (Audit #3) ===')
console.log('    (note: scrypt key derivation ~1-2s per identity operation)\n')

async function main () {
  // Generate identity first — need the address to set as genesis founder
  await h8id.generateIdentity('audit3-node-test')
  const identity = await h8id.unlockIdentity('audit3-node-test')

  // Set genesis allocation target to the test identity so we can transfer later
  process.env.H8_FOUNDER_ADDRESS = identity.address

  // Now load h8token with the founder address set
  delete require.cache[require.resolve('../server/h8token')]
  const h8token = require('../server/h8token')

  h8token.initLedger()
  const testDest = 'H8' + 'b'.repeat(38)

  // Transfer creates a signed (ML-DSA) block with from_pubkey stored
  await h8token.transfer(testDest, 100, 'audit3-test-transfer')

  // ── Test 1: valid chain passes verifyChain ────────────────────────────────
  await test('valid chain (genesis + ML-DSA transfer) passes verifyChain', async () => {
    const result = await h8token.verifyChain()
    assert.ok(result.valid, `Chain should be valid. Got: ${JSON.stringify(result)}`)
    assert.ok(result.blocks >= 4, 'Should have at least 3 genesis blocks + 1 transfer block')
  })

  // ── Test 2: tampered ML-DSA signature on a transfer block is detected ─────
  await test('tampered ML-DSA signature on a non-genesis block is detected — original bug prevention', async () => {
    const Database = require('../server/node_modules/better-sqlite3')
    const db2 = new Database(path.join(tmpDir, 'h8ledger.db'))

    // Find a block with a real ML-DSA signature (has from_pubkey, not genesis)
    const signed = db2.prepare(
      "SELECT block_index, signature FROM ledger WHERE from_pubkey IS NOT NULL LIMIT 1"
    ).get()

    assert.ok(signed, 'Test ledger must have at least one ML-DSA signed block')

    // Flip last two hex chars of signature
    const lastTwo = signed.signature.slice(-2)
    const flipped = lastTwo === '00' ? 'ff' : '00'
    db2.prepare('UPDATE ledger SET signature = ? WHERE block_index = ?')
       .run(signed.signature.slice(0, -2) + flipped, signed.block_index)
    db2.close()

    const result = await h8token.verifyChain()
    assert.ok(!result.valid, 'Chain with tampered signature should be invalid')
    assert.equal(result.firstInvalidBlock, signed.block_index, 'Must report the correct invalid block')
    assert.equal(result.reason, 'invalid ML-DSA signature', 'Must report the ML-DSA reason')
  })

  // ── Test 3: from_pubkey corresponds to correct from_addr ──────────────────
  await test('from_pubkey stored in block corresponds to from_addr — correct pubkey used for verification', async () => {
    const Database = require('../server/node_modules/better-sqlite3')
    const db2 = new Database(path.join(tmpDir, 'h8ledger.db'))
    const signed = db2.prepare(
      "SELECT from_addr, from_pubkey FROM ledger WHERE from_pubkey IS NOT NULL LIMIT 1"
    ).get()
    db2.close()

    assert.ok(signed, 'Test ledger must have at least one block with from_pubkey')

    const derivedAddr = h8id.h8AddressFrom(signed.from_pubkey)
    assert.equal(derivedAddr, signed.from_addr,
      'from_pubkey must derive to from_addr — prevents pubkey substitution attack')
  })

  // ── Cleanup ───────────────────────────────────────────────────────────────
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('\nFatal test error:', err.message)
  process.exit(1)
})
