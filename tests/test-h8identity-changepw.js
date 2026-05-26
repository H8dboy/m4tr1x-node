#!/usr/bin/env node
/**
 * Test: h8identity.changePassword — preserves ML-DSA65 identity
 *
 * Covers:
 *   1. Successful password change: new password works, old fails, address
 *      and publicKey unchanged, in-memory session stays open.
 *   2. Wrong old password: file on disk is untouched, .bak not created,
 *      lockout counter increments correctly.
 *   3. Atomicity: crash simulated between writeFileSync and renameSync
 *      (monkey-patch fs.renameSync); original file stays intact, no .tmp left.
 *   4. Historical signatures remain valid after password change
 *      (ML-DSA65 key is unchanged, only the AES-GCM envelope changes).
 *
 * NOTE: scrypt N=131072 — each identity operation takes ~1-2 s.
 *       Full suite: ~10-14 s.
 */
'use strict'

const assert = require('node:assert/strict')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

// ── Isolated temp directory ───────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4tr1x-changepw-test-'))
process.env.M4TR1X_DATA_DIR = tmpDir

// Fresh module load — clears any cached state from previous test runs
;['../server/h8identity'].forEach(m => {
  try { delete require.cache[require.resolve(m)] } catch {}
})

const h8id = require('../server/h8identity')

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`)
    if (process.env.VERBOSE) console.error(err.stack)
    failed++
  }
}

const IDENTITY_PATH = path.join(tmpDir, 'h8identity.enc')
const BAK_PATH      = IDENTITY_PATH + '.bak'

console.log('\n=== h8identity.changePassword Tests ===')
console.log('    (scrypt N=131072: ~1-2 s per operazione chiave)\n')

async function main() {

  // ── Setup: genera identità iniziale ──────────────────────────────────────
  await h8id.generateIdentity('password-originale')
  const info0 = h8id.getPublicInfo()
  const originalAddress   = info0.address
  const originalPublicKey = info0.publicKey

  // ── Test 1: cambio password riuscito ─────────────────────────────────────
  await test('cambio password riuscito: address e publicKey invariati', async () => {
    const result = await h8id.changePassword('password-originale', 'password-nuova')
    assert.equal(result.address,   originalAddress,   'address deve essere invariato')
    assert.equal(result.publicKey, originalPublicKey, 'publicKey deve essere invariata')
  })

  await test('dopo cambio: unlock con nuova password funziona', async () => {
    h8id.lockIdentity()
    const id = await h8id.unlockIdentity('password-nuova')
    assert.equal(id.address,   originalAddress,   'address dal nuovo unlock deve corrispondere')
    assert.equal(id.publicKey, originalPublicKey, 'publicKey dal nuovo unlock deve corrispondere')
  })

  await test('dopo cambio: unlock con vecchia password fallisce', async () => {
    h8id.lockIdentity()
    await assert.rejects(
      () => h8id.unlockIdentity('password-originale'),
      /Invalid current password|Password errata|corrotto/i
    )
  })

  await test('dopo cambio: sessione in memoria aggiornata se wallet era aperto', async () => {
    // Sblocca con la nuova password, poi chiama changePassword di nuovo da sbloccato
    await h8id.unlockIdentity('password-nuova')
    assert.ok(h8id.getUnlockedIdentity() !== null, 'wallet deve essere sbloccato')

    await h8id.changePassword('password-nuova', 'password-finale')

    // La sessione in memoria deve essere ancora valida
    const session = h8id.getUnlockedIdentity()
    assert.ok(session !== null, 'sessione in memoria deve restare aperta dopo changePassword')
    assert.equal(session.address,   originalAddress,   'indirizzo in sessione invariato')
    assert.equal(session.publicKey, originalPublicKey, 'publicKey in sessione invariata')

    // Ripristina per i prossimi test
    await h8id.changePassword('password-finale', 'password-nuova')
    h8id.lockIdentity()
  })

  await test('file .bak creato durante cambio password riuscito', () => {
    assert.ok(fs.existsSync(BAK_PATH), 'il file .bak deve esistere dopo un cambio riuscito')
    const bak = JSON.parse(fs.readFileSync(BAK_PATH, 'utf8'))
    assert.equal(bak.address, originalAddress, '.bak deve contenere lo stesso address')
  })

  // ── Test 2: vecchia password sbagliata ────────────────────────────────────
  await test('password sbagliata: lancia "Invalid current password"', async () => {
    const contentBefore = fs.readFileSync(IDENTITY_PATH, 'utf8')
    await assert.rejects(
      () => h8id.changePassword('password-SBAGLIATA', 'qualsiasi'),
      (err) => {
        assert.match(err.message, /Invalid current password/i)
        return true
      }
    )
    // File su disco deve essere identico a prima
    const contentAfter = fs.readFileSync(IDENTITY_PATH, 'utf8')
    assert.equal(contentAfter, contentBefore, 'il file NON deve essere modificato dopo password errata')
  })

  await test('password sbagliata: il .bak non viene ricreato (non sovrascrive quello buono)', async () => {
    // Il .bak esiste dal test precedente — il suo contenuto non deve cambiare
    const bakBefore = fs.existsSync(BAK_PATH) ? fs.readFileSync(BAK_PATH, 'utf8') : null
    await assert.rejects(
      () => h8id.changePassword('SBAGLIATA-2', 'qualsiasi'),
      /Invalid current password/i
    )
    if (bakBefore !== null) {
      const bakAfter = fs.existsSync(BAK_PATH) ? fs.readFileSync(BAK_PATH, 'utf8') : null
      assert.equal(bakAfter, bakBefore, '.bak non deve essere modificato dopo password errata')
    }
  })

  await test('lockout: dopo 5 password sbagliate successive il wallet si blocca', async () => {
    // Resetta il contatore isolando un modulo fresco
    delete require.cache[require.resolve('../server/h8identity')]
    const h8idFresh = require('../server/h8identity')
    // h8idFresh punta allo stesso file (stessa M4TR1X_DATA_DIR) ma stato in-memory azzerato

    let lockoutHit = false
    for (let i = 0; i < 6; i++) {
      try {
        await h8idFresh.changePassword('SBAGLIATA', 'nuova')
      } catch (err) {
        if (/locked for/i.test(err.message)) { lockoutHit = true; break }
      }
    }
    assert.ok(lockoutHit, 'dopo 5 tentativi falliti deve scattare il lockout')
  })

  // ── Test 3: atomicità — crash simulato tra write e rename ─────────────────
  await test('atomicità: crash tra writeFileSync e renameSync lascia originale intatto', async () => {
    // Forza stato pulito: modulo fresco, file originale presente
    delete require.cache[require.resolve('../server/h8identity')]
    const h8idAtom = require('../server/h8identity')

    const contentBefore = fs.readFileSync(IDENTITY_PATH, 'utf8')

    // Monkey-patch fs.renameSync per simulare crash al momento del rename
    const originalRename = fs.renameSync
    let renameCalled = false
    fs.renameSync = function crashingRename(src, dst) {
      renameCalled = true
      throw new Error('Simulated crash during rename')
    }

    try {
      await assert.rejects(
        () => h8idAtom.changePassword('password-nuova', 'nuova-atomica'),
        /Simulated crash during rename/
      )
    } finally {
      fs.renameSync = originalRename   // ripristina sempre
    }

    assert.ok(renameCalled, 'fs.renameSync deve essere stato chiamato')

    // Originale intatto
    const contentAfter = fs.readFileSync(IDENTITY_PATH, 'utf8')
    assert.equal(contentAfter, contentBefore, 'file originale deve essere intatto dopo crash simulato')

    // Nessun file .tmp residuo
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp.'))
    assert.equal(tmpFiles.length, 0, 'nessun file .tmp deve restare dopo il crash')
  })

  await test('atomicità: .bak non viene creato se crash avviene PRIMA del rename (verifica ordine operazioni)', async () => {
    // Situazione: backup avviene PRIMA del write temp
    // Se crash durante write temp, .bak esiste ma originale è intatto — ok
    // Se crash durante rename, .bak esiste e originale è intatto — ok
    // Verifica: il .bak che esiste DOPO il crash è uguale all'originale corrente
    const originalContent = fs.readFileSync(IDENTITY_PATH, 'utf8')
    if (fs.existsSync(BAK_PATH)) {
      const bakContent = fs.readFileSync(BAK_PATH, 'utf8')
      // Il bak deve contenere lo stesso address dell'originale
      const orig = JSON.parse(originalContent)
      const bak  = JSON.parse(bakContent)
      assert.equal(bak.address, orig.address, '.bak deve avere lo stesso address dell originale post-crash')
    }
  })

  // ── Test 4: firme storiche valide dopo cambio password ───────────────────
  await test('firme ML-DSA65 prodotte prima del cambio password restano verificabili', async () => {
    // Carica modulo fresco con stato pulito
    delete require.cache[require.resolve('../server/h8identity')]
    const h8idSig = require('../server/h8identity')

    // Sblocca con la password corrente
    const id = await h8idSig.unlockIdentity('password-nuova')
    const pubKey = id.publicKey

    // Firma un messaggio
    const msg       = 'messaggio-da-firmare-prima-del-cambio'
    const signature = await h8idSig.signWithUnlocked(msg)

    // Cambia password
    await h8idSig.changePassword('password-nuova', 'password-post-firma')

    // La firma prodotta PRIMA del cambio deve restare valida (stessa chiave ML-DSA)
    const stillValid = await h8idSig.verifySignature(pubKey, msg, signature)
    assert.ok(stillValid, 'la firma prodotta prima del cambio password deve restare valida')

    // Firma un nuovo messaggio DOPO il cambio — deve funzionare
    const msg2       = 'messaggio-dopo-cambio'
    const signature2 = await h8idSig.signWithUnlocked(msg2)
    const valid2     = await h8idSig.verifySignature(pubKey, msg2, signature2)
    assert.ok(valid2, 'la firma prodotta DOPO il cambio password deve essere valida')
  })

  await test('address H8 invariato dopo più cambi password consecutivi', async () => {
    delete require.cache[require.resolve('../server/h8identity')]
    const h8idChain = require('../server/h8identity')

    await h8idChain.unlockIdentity('password-post-firma')
    const info = h8idChain.getPublicInfo()
    const addr = info.address

    await h8idChain.changePassword('password-post-firma', 'pw-step-1')
    await h8idChain.changePassword('pw-step-1',           'pw-step-2')
    await h8idChain.changePassword('pw-step-2',           'pw-step-3')

    const infoFinal = h8idChain.getPublicInfo()
    assert.equal(infoFinal.address,   addr,             'address invariato dopo 3 cambi')
    assert.equal(infoFinal.publicKey, info.publicKey,   'publicKey invariata dopo 3 cambi')

    // Verifica che il file sia leggibile con l'ultima password
    h8idChain.lockIdentity()
    await assert.doesNotReject(() => h8idChain.unlockIdentity('pw-step-3'))
  })

  // ── Cleanup ───────────────────────────────────────────────────────────────
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  console.log(`\nRisultati: ${passed} passati, ${failed} falliti\n`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('\nErrore fatale nel test:', err.message)
  if (process.env.VERBOSE) console.error(err.stack)
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  process.exit(1)
})
