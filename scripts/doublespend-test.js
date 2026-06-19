/**
 * M4TR1X — test mirato sui fix anti-double-spend intra-nodo.
 *   #1 lock per-sender: spese concorrenti dallo stesso indirizzo non superano
 *      entrambe il check del saldo.
 *   #2 guardia saldo negativo: nessuna spesa porta il saldo sotto zero.
 * Exit 0 se tutto passa, 1 al primo fail.
 */
const os   = require('os')
const fs   = require('fs')
const path = require('path')

const TMP = path.join(os.tmpdir(), 'm4tr1x-ds-' + Date.now())
fs.mkdirSync(TMP, { recursive: true })
process.env.M4TR1X_DATA_DIR  = TMP
process.env.H8_ADMIN_MINT_KEY = 'test_admin_key'

const h8id    = require(path.join(__dirname, '..', 'server', 'h8identity'))
const h8token = require(path.join(__dirname, '..', 'server', 'h8token'))

let failed = false
const ok   = (m) => console.log('✓ ' + m)
const bad  = (m) => { console.error('✗ ' + m); failed = true }

const RECIPIENT = 'H8' + 'a'.repeat(38)

;(async () => {
  h8token.initLedger()
  await h8id.generateIdentity('pass1234')
  const { address } = await h8id.unlockIdentity('pass1234')

  await h8token.mintTokens(address, 100, 'test_admin_key')
  const start = h8token.getBalance(address)
  start === 100 ? ok(`mint → saldo 100`) : bad(`saldo iniziale atteso 100, trovato ${start}`)

  // ── #1: 5 transfer concorrenti da 100 su un saldo di 100 ────────────────────
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => h8token.transfer(RECIPIENT, 100, 'race'))
  )
  const okCount  = results.filter(r => r.status === 'fulfilled').length
  const rejCount = results.filter(r => r.status === 'rejected').length

  okCount === 1
    ? ok(`5 spese concorrenti → 1 sola riuscita (lock per-sender regge)`)
    : bad(`atteso esattamente 1 successo, trovati ${okCount} (rej ${rejCount}) — DOUBLE SPEND!`)

  const after = h8token.getBalance(address)
  after === 0   ? ok(`saldo dopo la corsa = 0`) : bad(`saldo atteso 0, trovato ${after}`)
  after >= 0    ? ok(`saldo mai negativo`)       : bad(`SALDO NEGATIVO: ${after}`)

  // ── #2: spesa su saldo 0 deve fallire ───────────────────────────────────────
  try {
    await h8token.transfer(RECIPIENT, 100, 'overspend')
    bad(`spesa su saldo 0 NON rifiutata`)
  } catch (e) {
    /Insufficient balance/.test(e.message)
      ? ok(`spesa su saldo 0 rifiutata: "${e.message}"`)
      : bad(`rifiutata con errore inatteso: ${e.message}`)
  }

  const end = h8token.getBalance(address)
  end === 0 ? ok(`saldo finale stabile = 0`) : bad(`saldo finale atteso 0, trovato ${end}`)

  // catena integra
  const chain = await h8token.verifyChain()
  chain.valid ? ok(`catena valida (${chain.blocks} blocchi)`) : bad(`catena invalida: ${chain.reason}`)

  console.log(failed ? '\n✗ TEST FALLITO' : '\n✓ TUTTI I TEST DOUBLE-SPEND PASSATI')
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('ERRORE FATALE:', e); process.exit(1) })
