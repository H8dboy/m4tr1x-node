#!/usr/bin/env node
/**
 * Test: Nostr key encryption at rest (Audit fix #2)
 *
 * Verifies that nostr.js no longer stores the Nostr private key in plaintext.
 * Covers: save → disk check, save/unlock roundtrip, wrong-password rejection,
 * and automatic migration from old plaintext format.
 *
 * Does NOT start any server or relay. Runs in a temporary directory.
 */
'use strict'

const assert  = require('node:assert/strict')
const fs      = require('fs')
const os      = require('os')
const path    = require('path')
const { webcrypto } = require('crypto')
if (!globalThis.crypto) globalThis.crypto = webcrypto

// ── Isolated temp directory so tests never touch real user data ───────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4tr1x-nostr-test-'))
process.env.M4TR1X_DATA_DIR = tmpDir

// Force a fresh module load with the test DATA_DIR
delete require.cache[require.resolve('../server/nostr')]
const nostr = require('../server/nostr')

let passed = 0
let failed = 0

function test (name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`)
    failed++
  }
}

function resetKeys () {
  const kf = nostr.getKeysPath()
  if (fs.existsSync(kf))         fs.unlinkSync(kf)
  if (fs.existsSync(kf + '.bak')) fs.unlinkSync(kf + '.bak')
  // Clear in-memory session state by locking
  nostr.lockNostrKeys()
}

console.log('\n=== Nostr Key Encryption Tests (Audit #2) ===\n')

// ── Test 1: after saveKeys the file on disk must NOT contain the privkey hex ──
test('saved key file does not contain privkey in plaintext', () => {
  resetKeys()
  const keys = nostr.generateKeys()
  nostr.saveKeys(keys, 'test-password-1')

  const raw = fs.readFileSync(nostr.getKeysPath(), 'utf8')
  assert.ok(!raw.includes(keys.privkey),
    'privkey hex must not appear in the key file')
  assert.ok(!raw.includes(keys.nsec || ''),
    'nsec must not appear in the key file')

  const parsed = JSON.parse(raw)
  assert.equal(parsed.version, 2, 'file must carry version:2')
  assert.ok(parsed.encrypted,  'file must carry encrypted field')
  assert.ok(parsed.salt,       'file must carry salt field')
  assert.ok(parsed.iv,         'file must carry iv field')
  assert.ok(parsed.authTag,    'file must carry authTag field')
  assert.ok(!parsed.privkey,   'file must NOT have a plaintext privkey field')
})

// ── Test 2a: unlock with correct password returns the original privkey ────────
test('roundtrip: save with password A then unlock with A returns correct privkey', () => {
  resetKeys()
  const keys = nostr.generateKeys()
  nostr.saveKeys(keys, 'correct-password')

  const result = nostr.unlockNostrKeys('correct-password')
  assert.equal(result.pubkey, keys.pubkey, 'pubkey from unlock must match original')

  const recovered = nostr.getUnlockedNostrPrivkey()
  assert.equal(recovered, keys.privkey, 'recovered privkey must match original')
})

// ── Test 2b: unlock with wrong password must throw ───────────────────────────
test('roundtrip: unlock with wrong password throws error (original bug prevention)', () => {
  // Keys were saved in previous test — just lock and retry with wrong password
  nostr.lockNostrKeys()
  assert.throws(
    () => nostr.unlockNostrKeys('wrong-password'),
    /Password errata|corrotto/,
    'wrong password must throw'
  )
  assert.equal(nostr.getUnlockedNostrPrivkey(), null,
    'privkey must remain null after failed unlock')
})

// ── Test 3: auto-migration from old plaintext format ─────────────────────────
test('migration: old plaintext nostr_keys.json is migrated to encrypted format', () => {
  resetKeys()

  // Write old-format plaintext file (pre-fix format)
  const keys = nostr.generateKeys()
  const oldFormat = {
    privkey: keys.privkey,
    pubkey:  keys.pubkey,
    npub:    keys.npub,
    nsec:    keys.nsec,
  }
  fs.writeFileSync(nostr.getKeysPath(), JSON.stringify(oldFormat, null, 2), { mode: 0o600 })

  // Unlock — should auto-migrate
  const result = nostr.unlockNostrKeys('migration-password')
  assert.equal(result.pubkey, keys.pubkey, 'pubkey must survive migration')

  // Backup file must exist
  assert.ok(fs.existsSync(nostr.getKeysPath() + '.bak'),
    'backup .bak file must be created during migration')

  // New file must be encrypted
  const raw = fs.readFileSync(nostr.getKeysPath(), 'utf8')
  assert.ok(!raw.includes(keys.privkey),
    'migrated file must not contain privkey in plaintext')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.version, 2, 'migrated file must have version:2')
  assert.ok(parsed.encrypted, 'migrated file must have encrypted field')

  // Privkey must be accessible in memory after migration
  assert.equal(nostr.getUnlockedNostrPrivkey(), keys.privkey,
    'privkey must be in memory after migration unlock')
})

// ── Test 4: loadSavedKeys never returns privkey ───────────────────────────────
test('loadSavedKeys returns only public info (no privkey field)', () => {
  // Keys were saved & migrated in previous test
  nostr.lockNostrKeys()
  const info = nostr.loadSavedKeys()
  assert.ok(info !== null,    'loadSavedKeys must return an object when file exists')
  assert.ok(info.pubkey,      'loadSavedKeys must return pubkey')
  assert.ok(!info.privkey,    'loadSavedKeys must NOT return privkey')
  assert.ok(!info.nsec,       'loadSavedKeys must NOT return nsec')
  assert.ok(!info.encrypted,  'loadSavedKeys must NOT expose encrypted blob')
})

// ── Cleanup ───────────────────────────────────────────────────────────────────
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
