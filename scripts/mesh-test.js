/**
 * M4TR1X mesh test — verifica che due nodi sincronizzino gli eventi Nostr.
 *
 * Avvia due server completi (A e B) su porte diverse, con B in mesh verso
 * il relay di A. Pubblica una nota firmata sul relay di A e verifica che
 * compaia sul relay di B (e viceversa). Exit 0 se tutto passa.
 */
'use strict'

const { spawn } = require('child_process')
const fs   = require('fs')
const path = require('path')
const WS   = require('ws')
const { finalizeEvent, generateSecretKey } = require('nostr-tools/pure')

const ROOT = path.join(__dirname, '..')
const TMP_A = path.join(ROOT, '.mesh-tmp-a')
const TMP_B = path.join(ROOT, '.mesh-tmp-b')
const RELAY_A = 14848
const RELAY_B = 14858

for (const d of [TMP_A, TMP_B]) {
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(d, { recursive: true })
}

function startNode (name, { port, relayPort, dataDir, peers }) {
  const env = {
    ...process.env,
    PORT: String(port),
    RELAY_PORT: String(relayPort),
    M4TR1X_DATA_DIR: dataDir,
    USERDATA_PATH: dataDir,          // relay.db dentro la dir del nodo
    RELAY_PEERS: peers || '',
    HEAD_NODE_URL: '',
    APP_SECRET: 'a'.repeat(64),
  }
  const proc = spawn('node', ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout.on('data', d => process.stdout.write(`[${name}] ` + d))
  proc.stderr.on('data', d => process.stderr.write(`[${name}!] ` + d))
  return proc
}

function publish (relayUrl, event) {
  return new Promise((resolve, reject) => {
    const ws = new WS(relayUrl)
    const t = setTimeout(() => { ws.close(); reject(new Error('publish timeout ' + relayUrl)) }, 8000)
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])))
    ws.on('message', raw => {
      const m = JSON.parse(raw)
      if (m[0] === 'OK' && m[1] === event.id) {
        clearTimeout(t); ws.close()
        m[2] ? resolve() : reject(new Error('relay rejected: ' + m[3]))
      }
    })
    ws.on('error', e => { clearTimeout(t); reject(e) })
  })
}

// Polla il relay finché l'evento non compare (la mesh è asincrona)
function waitForEvent (relayUrl, id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const ws = new WS(relayUrl)
      let found = false
      ws.on('open', () => ws.send(JSON.stringify(['REQ', 'check', { ids: [id] }])))
      ws.on('message', raw => {
        const m = JSON.parse(raw)
        if (m[0] === 'EVENT' && m[2]?.id === id) { found = true; ws.close(); resolve() }
        if (m[0] === 'EOSE') ws.close()
      })
      ws.on('close', () => {
        if (found) return
        if (Date.now() > deadline) return reject(new Error(`evento ${id.slice(0, 8)}… non arrivato su ${relayUrl}`))
        setTimeout(tryOnce, 1000)
      })
      ws.on('error', () => ws.close())
    }
    tryOnce()
  })
}

function note (text) {
  return finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', 'mesh-test']],
    content: text,
  }, generateSecretKey())
}

async function run () {
  console.log('— Avvio nodo A (relay :' + RELAY_A + ') e nodo B (relay :' + RELAY_B + ', peer → A)')
  const a = startNode('A', { port: 18081, relayPort: RELAY_A, dataDir: TMP_A })
  const b = startNode('B', { port: 18082, relayPort: RELAY_B, dataDir: TMP_B, peers: `ws://127.0.0.1:${RELAY_A}` })

  const cleanup = code => {
    a.kill(); b.kill()
    setTimeout(() => {
      for (const d of [TMP_A, TMP_B]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
      process.exit(code)
    }, 500)
  }

  try {
    // Attendi che entrambi i relay siano su (mesh parte dopo 4s)
    await new Promise(r => setTimeout(r, 7000))

    console.log('— Pubblico nota su A, deve propagarsi su B (A→B via REQ della mesh di B)')
    const evA = note('ciao dalla rete M4TR1X — nodo A')
    await publish(`ws://127.0.0.1:${RELAY_A}`, evA)
    await waitForEvent(`ws://127.0.0.1:${RELAY_B}`, evA.id)
    console.log('✓ A→B: evento propagato')

    console.log('— Aggiungo A→B come peer via API e pubblico su B')
    const resp = await fetch('http://127.0.0.1:18081/api/v1/mesh/peer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `ws://127.0.0.1:${RELAY_B}` }),
    })
    if (!resp.ok) throw new Error('mesh/peer API fallita: ' + resp.status)
    const evB = note('risposta dal nodo B')
    await publish(`ws://127.0.0.1:${RELAY_B}`, evB)
    await waitForEvent(`ws://127.0.0.1:${RELAY_A}`, evB.id)
    console.log('✓ B→A: evento propagato')

    const status = await (await fetch('http://127.0.0.1:18082/api/v1/mesh/status')).json()
    if (!status.started || !status.peers.length) throw new Error('mesh status incoerente')
    console.log('✓ mesh status:', JSON.stringify(status.peers))

    console.log('\n✓ MESH TEST PASSED — la rete propaga gli eventi tra i nodi')
    cleanup(0)
  } catch (e) {
    console.error('\n✗ MESH TEST FAILED:', e.message)
    cleanup(1)
  }
}

run()
