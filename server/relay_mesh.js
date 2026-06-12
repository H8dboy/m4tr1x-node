/**
 * M4TR1X — Relay Mesh
 *
 * Sincronizza il relay locale con i relay degli altri nodi usando SOLO
 * protocollo Nostr standard (REQ/EVENT). Nessun protocollo proprietario:
 * qualsiasi relay NIP-01 può partecipare alla mesh.
 *
 * Come funziona:
 *  - I peer arrivano da RELAY_PEERS (statici) e dal head node (dinamici,
 *    via /api/v1/head/nodes, aggiornati ogni 5 minuti).
 *  - Per ogni peer apre una WebSocket persistente e fa REQ degli eventi
 *    dal cursore dell'ultimo sync (con 5 min di overlap per sicurezza).
 *  - Ogni evento ricevuto viene inoltrato al relay locale come EVENT:
 *    il relay verifica la firma Schnorr, deduplica (INSERT OR IGNORE) e
 *    notifica i subscriber locali. Niente loop: i duplicati muoiono lì.
 *  - Il client/app continua a parlare solo con ws://localhost:RELAY_PORT.
 *
 * L'app resta funzionante in air-gap: senza peer la mesh semplicemente
 * non ha nulla da sincronizzare.
 */

'use strict'

const WS   = require('ws')
const fs   = require('fs')
const os   = require('os')
const path = require('path')
const http = require('http')

const RELAY_PORT     = parseInt(process.env.RELAY_PORT || '4848', 10)
const LOCAL_RELAY    = `ws://127.0.0.1:${RELAY_PORT}`
const DATA_DIR       = process.env.M4TR1X_DATA_DIR || process.cwd()
const STATE_FILE     = path.join(DATA_DIR, 'mesh_state.json')
const HEAD_URL       = process.env.HEAD_NODE_URL || null
const STATIC_PEERS   = (process.env.RELAY_PEERS || '').split(',').map(s => s.trim()).filter(Boolean)
const REFRESH_MS     = 5 * 60 * 1000   // refresh lista peer dal head
const OVERLAP_S      = 300             // overlap cursore: i duplicati sono gratis
const MAX_BACKOFF    = 5 * 60 * 1000

// peer url → { ws, state, imported, lastEventAt, backoff, timer, sub }
const _peers = new Map()
let _localWs    = null
let _localQueue = []
let _started    = false
let _refreshTimer = null

// ─── Cursori persistenti (per peer) ───────────────────────────────────────────
let _state = { cursors: {} }
try { _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch {}
let _saveTimer = null
function _saveState () {
  if (_saveTimer) return
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(_state)) } catch {}
  }, 2000)
}

// ─── Indirizzi propri (per non connettersi a se stessi) ───────────────────────
function _ownHosts () {
  const hosts = new Set(['localhost', '127.0.0.1', '::1'])
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) hosts.add(i.address)
  }
  return hosts
}

function _isSelf (url) {
  try {
    const u = new URL(url)
    const port = parseInt(u.port) || 80
    return port === RELAY_PORT && _ownHosts().has(u.hostname)
  } catch { return true }   // URL malformato → scarta
}

// ─── Connessione al relay locale (coda se non pronto) ─────────────────────────
function _connectLocal () {
  if (_localWs && (_localWs.readyState === WS.OPEN || _localWs.readyState === WS.CONNECTING)) return
  _localWs = new WS(LOCAL_RELAY)
  _localWs.on('open', () => {
    const q = _localQueue; _localQueue = []
    for (const msg of q) { try { _localWs.send(msg) } catch {} }
  })
  _localWs.on('error', () => {})
  _localWs.on('close', () => { setTimeout(_connectLocal, 3000) })
}

function _forwardToLocal (ev) {
  const msg = JSON.stringify(['EVENT', ev])
  if (_localWs && _localWs.readyState === WS.OPEN) {
    try { _localWs.send(msg) } catch { _localQueue.push(msg) }
  } else {
    if (_localQueue.length < 5000) _localQueue.push(msg)
    _connectLocal()
  }
}

// ─── Connessione a un peer ────────────────────────────────────────────────────
function _connectPeer (url) {
  const peer = _peers.get(url)
  if (!peer || peer.ws) return

  let ws
  try { ws = new WS(url, { handshakeTimeout: 8000 }) }
  catch { return _schedulePeerRetry(url) }

  peer.ws    = ws
  peer.state = 'connecting'
  peer.sub   = 'mesh-' + Math.random().toString(36).slice(2, 10)

  ws.on('open', () => {
    peer.state   = 'connected'
    peer.backoff = 1000
    const since = Math.max(0, (_state.cursors[url] || 0) - OVERLAP_S)
    // REQ resta aperta dopo EOSE → riceviamo anche gli eventi live
    ws.send(JSON.stringify(['REQ', peer.sub, { since, limit: 500 }]))
    console.log(`[MESH] Connesso a ${url} (sync da ${since})`)
  })

  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg[0] === 'EVENT' && msg[1] === peer.sub && msg[2]) {
      const ev = msg[2]
      if (!ev.id || !ev.sig || !ev.pubkey) return
      _forwardToLocal(ev)   // il relay locale verifica firma e deduplica
      peer.imported++
      peer.lastEventAt = Date.now()
      if (ev.created_at > (_state.cursors[url] || 0)) {
        _state.cursors[url] = ev.created_at
        _saveState()
      }
    }
  })

  ws.on('error', () => {})
  ws.on('close', () => {
    peer.ws    = null
    peer.state = 'disconnected'
    _schedulePeerRetry(url)
  })
}

function _schedulePeerRetry (url) {
  const peer = _peers.get(url)
  if (!peer || peer.timer) return
  peer.timer = setTimeout(() => {
    peer.timer = null
    if (_peers.has(url)) _connectPeer(url)
  }, peer.backoff)
  peer.backoff = Math.min(peer.backoff * 2, MAX_BACKOFF)
}

// ─── Gestione lista peer ──────────────────────────────────────────────────────
function addPeer (url) {
  if (!url || _isSelf(url)) return false
  if (new URL(url).hostname.endsWith('.onion')) return false   // Tor mesh: fase 2
  if (_peers.has(url)) return false
  _peers.set(url, { ws: null, state: 'new', imported: 0, lastEventAt: null, backoff: 1000, timer: null, sub: null })
  if (_started) _connectPeer(url)
  console.log(`[MESH] Peer aggiunto: ${url}`)
  return true
}

function removePeer (url) {
  const peer = _peers.get(url)
  if (!peer) return
  if (peer.timer) clearTimeout(peer.timer)
  try { peer.ws?.close() } catch {}
  _peers.delete(url)
}

// Scopre i peer registrati nel head node e li aggiunge alla mesh
function _refreshFromHead () {
  if (!HEAD_URL) return
  const reqUrl = HEAD_URL.replace(/\/$/, '') + '/api/v1/head/nodes'
  http.get(reqUrl, { timeout: 10000 }, res => {
    let body = ''
    res.on('data', c => body += c)
    res.on('end', () => {
      try {
        const nodes = JSON.parse(body)
        if (!Array.isArray(nodes)) return
        for (const n of nodes) {
          if (!n.node_url) continue
          try {
            const host = new URL(n.node_url).hostname
            addPeer(`ws://${host}:${n.ws_port || 4848}`)
          } catch {}
        }
      } catch (e) { console.warn('[MESH] Risposta head non valida:', e.message) }
    })
  }).on('error', e => console.warn('[MESH] Head non raggiungibile:', e.message))
    .on('timeout', function () { this.destroy() })
}

// ─── API pubblica ─────────────────────────────────────────────────────────────
function startMesh () {
  if (_started) return
  _started = true
  _connectLocal()
  for (const url of STATIC_PEERS) addPeer(url)
  for (const url of _peers.keys()) _connectPeer(url)
  if (HEAD_URL) {
    _refreshFromHead()
    _refreshTimer = setInterval(_refreshFromHead, REFRESH_MS)
    if (_refreshTimer.unref) _refreshTimer.unref()
  }
  console.log(`[MESH] Relay mesh attiva — peer statici: ${STATIC_PEERS.length}, head: ${HEAD_URL || 'nessuno'}`)
}

function stopMesh () {
  _started = false
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null }
  for (const url of [..._peers.keys()]) removePeer(url)
  try { _localWs?.close() } catch {}
  _localWs = null
}

function getMeshStatus () {
  return {
    started: _started,
    localRelay: LOCAL_RELAY,
    headUrl: HEAD_URL,
    peers: [..._peers.entries()].map(([url, p]) => ({
      url, state: p.state, imported: p.imported, lastEventAt: p.lastEventAt,
    })),
  }
}

module.exports = { startMesh, stopMesh, addPeer, removePeer, getMeshStatus }
