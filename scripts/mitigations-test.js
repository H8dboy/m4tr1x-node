/**
 * M4TR1X — test delle mitigazioni lancio (pre-head canonico):
 *   #1 finestra di conferma: entrate fresche via gossip non sono spendibili subito.
 *   #2 tetto fondi non confermati: solo MAX_UNCONFIRMED di entrate fresche è
 *      spendibile prima della conferma.
 * Inserisce blocchi remoti già verificati con received_at controllato e verifica
 * getSpendable / getBalanceBreakdown. Exit 0 se passa.
 */
const os   = require('os')
const fs   = require('fs')
const path = require('path')
const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'))

const TMP = path.join(os.tmpdir(), 'm4tr1x-mit-' + Date.now())
fs.mkdirSync(TMP, { recursive: true })
process.env.M4TR1X_DATA_DIR     = TMP
process.env.H8_CONFIRM_WINDOW_MS = '3600000'  // 1h: rende deterministico "fresco" vs "confermato"
process.env.H8_MAX_UNCONFIRMED   = '1000'

const h8id    = require(path.join(__dirname, '..', 'server', 'h8identity'))
const h8token = require(path.join(__dirname, '..', 'server', 'h8token'))

let failed = false
const ok  = (m) => console.log('✓ ' + m)
const bad = (m) => { console.error('✗ ' + m); failed = true }
const eq  = (label, got, want) => got === want ? ok(`${label} = ${got}`) : bad(`${label}: atteso ${want}, trovato ${got}`)

;(async () => {
  h8token.initLedger()
  const { address: ME } = await h8id.generateIdentity('pass1234').then(() => h8id.unlockIdentity('pass1234'))

  // Trigger creazione del remote_blocks.db (via getSync) prima di aprirlo a mano
  h8token.getBalance(ME)
  const rdb = new Database(path.join(TMP, 'remote_blocks.db'))

  const nowSec = Math.floor(Date.now() / 1000)
  let n = 0
  function insertIncoming(amount, receivedAtSec) {
    n++
    rdb.prepare(`INSERT INTO remote_blocks
      (signature, hash, ts, from_addr, to_addr, amount, tx_type, content_id, signer_pubkey, verified, received_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?)`)
      .run('sig'+n, 'hash'+n, nowSec, 'H8'+'b'.repeat(38), ME, amount, 'transfer', null, 'pub'+n, receivedAtSec)
  }

  // Entrata fresca (ricevuta ora) da 5000 → tutta "pending"
  insertIncoming(5000, nowSec)
  let bd = h8token.getBalanceBreakdown(ME)
  eq('totale', bd.total, 5000)
  eq('pending', bd.pending_unconfirmed, 5000)
  // spendibile = 5000 - max(5000 - 1000, 0) = 1000 (solo il tetto è spendibile subito)
  eq('spendibile (solo cap su fondi freschi)', bd.spendable, 1000)

  // Entrata vecchia (2h fa, oltre la finestra) da 2000 → confermata
  insertIncoming(2000, nowSec - 7200)
  bd = h8token.getBalanceBreakdown(ME)
  eq('totale dopo entrata confermata', bd.total, 7000)
  eq('pending invariato', bd.pending_unconfirmed, 5000)
  // spendibile = 7000 - max(5000 - 1000, 0) = 3000 (= 2000 confermati + 1000 di cap)
  eq('spendibile (confermati + cap)', bd.spendable, 3000)

  // getSpendable deve combaciare col breakdown
  bd.spendable === h8token.getSpendable(ME)
    ? ok('getSpendable coerente con breakdown')
    : bad('getSpendable diverge dal breakdown')

  rdb.close()
  console.log(failed ? '\n✗ TEST FALLITO' : '\n✓ TUTTE LE MITIGAZIONI VERIFICATE')
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('ERRORE FATALE:', e); process.exit(1) })
