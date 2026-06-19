/**
 * M4TR1X — test del session guard (una sola sessione attiva per identità).
 * Stubba il layer Nostr per iniettare un claim concorrente in modo deterministico
 * e verifica che: (a) il conflitto venga rilevato, (b) h8token sospenda le spese.
 * Exit 0 se passa.
 */
const os   = require('os')
const fs   = require('fs')
const path = require('path')

const TMP = path.join(os.tmpdir(), 'm4tr1x-sg-' + Date.now())
fs.mkdirSync(TMP, { recursive: true })
process.env.M4TR1X_DATA_DIR      = TMP
process.env.H8_ADMIN_MINT_KEY    = 'test_admin_key'
process.env.H8_SESSION_REFRESH_MS = '3000'

// ── Stub del layer Nostr PRIMA di caricare session_guard (che destruttura le fn) ──
const nostr = require(path.join(__dirname, '..', 'server', 'nostr'))
let fedHandler = null
nostr.subscribeToFilter   = (filter, cb) => { fedHandler = cb }
nostr.publishEvent        = async () => {}
nostr.getUnlockedNostrPrivkey = () => 'stub-privkey'

const guard   = require(path.join(__dirname, '..', 'server', 'session_guard'))
const h8id    = require(path.join(__dirname, '..', 'server', 'h8identity'))
const h8token = require(path.join(__dirname, '..', 'server', 'h8token'))

let failed = false
const ok  = (m) => console.log('✓ ' + m)
const bad = (m) => { console.error('✗ ' + m); failed = true }

const RECIPIENT = 'H8' + 'a'.repeat(38)

;(async () => {
  h8token.initLedger()
  const { address: ME } = await h8id.generateIdentity('pass1234').then(() => h8id.unlockIdentity('pass1234'))
  await h8token.mintTokens(ME, 100, 'test_admin_key')

  guard.claim(ME)
  const mySid = guard.getState().sid
  fedHandler ? ok('subscription registrata') : bad('subscription non registrata')

  // Nessun conflitto ancora → la spesa passa
  guard.hasConflict(ME) === false ? ok('nessun conflitto iniziale') : bad('conflitto fantasma')
  try { await h8token.transfer(RECIPIENT, 10); ok('spesa consentita senza conflitto') }
  catch (e) { bad('spesa rifiutata erroneamente: ' + e.message) }

  // Il guard deve ignorare il PROPRIO claim (stesso sid) e quelli di ALTRE identità
  fedHandler({ tags: [['t','m4tr1x-session'], ['h8', ME], ['sid', mySid], ['node','self']] })
  fedHandler({ tags: [['t','m4tr1x-session'], ['h8','H8'+'b'.repeat(38)], ['sid','other-id'], ['node','altro']] })
  guard.hasConflict(ME) === false
    ? ok('ignora il proprio claim e quelli di altre identità')
    : bad('falso conflitto da claim proprio/altrui')

  // Inietta un claim concorrente per LA MIA identità con sid diverso
  fedHandler({ tags: [['t','m4tr1x-session'], ['h8', ME], ['sid','EVIL-SESSION'], ['node','nodo-malevolo']] })
  guard.hasConflict(ME) === true ? ok('conflitto rilevato dopo claim concorrente') : bad('conflitto NON rilevato')

  const st = guard.getState()
  st.conflict === true && st.otherNode === 'nodo-malevolo'
    ? ok(`stato espone conflitto (nodo="${st.otherNode}")`)
    : bad(`getState non riflette il conflitto: ${JSON.stringify(st)}`)

  // Ora la spesa deve essere sospesa
  try {
    await h8token.transfer(RECIPIENT, 10)
    bad('spesa NON sospesa durante conflitto')
  } catch (e) {
    /Sessione concorrente/.test(e.message) ? ok('spesa sospesa: "' + e.message.slice(0, 45) + '..."')
                                            : bad('errore inatteso: ' + e.message)
  }

  // release azzera lo stato
  guard.release()
  guard.hasConflict(ME) === false ? ok('release azzera il conflitto') : bad('release non ha funzionato')

  console.log(failed ? '\n✗ TEST FALLITO' : '\n✓ SESSION GUARD VERIFICATO')
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('ERRORE FATALE:', e); process.exit(1) })
