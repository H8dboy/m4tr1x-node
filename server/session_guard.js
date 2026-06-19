'use strict'
/**
 * M4TR1X — Session Guard
 * Mitigazione lancio (pre-head canonico): una sola sessione attiva per identità.
 *
 * Senza head canonico non possiamo IMPEDIRE in modo assoluto che la stessa
 * identità giri su due nodi, ma possiamo RILEVARLO. Ogni sessione sbloccata
 * pubblica periodicamente un "claim" effimero su Nostr, firmato con la chiave
 * derivata dall'identità (quindi auto-autenticato: solo chi possiede la chiave
 * può rivendicare quell'indirizzo). Se un nodo riceve un claim della PROPRIA
 * identità con un session-id diverso, c'è una sessione concorrente → le spese
 * vengono sospese finché non si risolve.
 *
 * È una cintura di sicurezza, non consenso: il claim è effimero e best-effort,
 * la finestra di rilevamento è ~REFRESH_MS. Combinata con finestra di conferma
 * e tetto fondi non confermati, riduce il raggio d'azione del double-spend
 * cross-nodo finché l'head node canonico non lo chiude del tutto.
 */
const crypto = require('crypto')
const { publishEvent, subscribeToFilter, getUnlockedNostrPrivkey } = require('./nostr')

const KIND       = 27425   // range effimero NIP-01 (non memorizzato, solo broadcast live)
const TAG        = 'm4tr1x-session'
const REFRESH_MS = Math.max(3000, parseInt(process.env.H8_SESSION_REFRESH_MS || '15000'))
const NODE_NAME  = process.env.NODE_NAME || 'alpha'

let _state      = null   // { address, sid, conflict, otherNode, since } | null
let _timer      = null
let _subscribed = false

function _publishClaim() {
  if (!_state || !getUnlockedNostrPrivkey()) return
  publishEvent({
    kind: KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d',    `session-${_state.address}`],
      ['t',    TAG],
      ['h8',   _state.address],
      ['sid',  _state.sid],
      ['node', NODE_NAME],
    ],
    content: '',
  }).catch(() => {})
}

function _ensureSubscription() {
  if (_subscribed) return
  _subscribed = true
  subscribeToFilter({ kinds: [KIND], '#t': [TAG] }, ev => {
    try {
      if (!_state) return
      const get = t => ev.tags.find(x => x[0] === t)?.[1]
      if (get('h8') !== _state.address) return   // claim di un'altra identità
      const sid = get('sid')
      if (!sid || sid === _state.sid) return       // il mio stesso claim
      if (!_state.conflict) {
        _state.conflict  = true
        _state.otherNode = get('node') || 'sconosciuto'
        console.warn(`[SESSION_GUARD] ⚠️ CONFLITTO: identità ${_state.address.slice(0, 12)} attiva anche sul nodo "${_state.otherNode}". Spese sospese.`)
      }
    } catch {}
  })
}

/** Avvia una sessione per l'identità appena sbloccata. */
function claim(address) {
  if (!address) return
  release()
  _state = { address, sid: crypto.randomBytes(8).toString('hex'), conflict: false, otherNode: null, since: Date.now() }
  _ensureSubscription()
  _publishClaim()
  _timer = setInterval(_publishClaim, REFRESH_MS)
  if (_timer.unref) _timer.unref()   // non tenere vivo il processo solo per questo
}

/** Termina la sessione corrente (lock o cambio identità). */
function release() {
  if (_timer) { clearInterval(_timer); _timer = null }
  _state = null
}

/** true se per questa identità è stata rilevata una sessione concorrente altrove. */
function hasConflict(address) {
  return !!(_state && _state.address === address && _state.conflict)
}

function getState() {
  if (!_state) return { active: false }
  const { address, sid, conflict, otherNode, since } = _state
  return { active: true, address, sid, conflict, otherNode, since }
}

module.exports = { claim, release, hasConflict, getState }
