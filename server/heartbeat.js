'use strict'

const net  = require('net')
const http = require('http')

let _headUrl    = null
let _pubkey     = null
let _nodeName   = null
let _nodeData   = null
let _walletAddr = null
let _walletName = null
let _intervalId = null
let _startTime  = Date.now()

let _counters = { requests: 0, users_active: new Set(), uploads: 0, errors: 0 }

function trackRequest()     { _counters.requests++ }
function trackUser(address) { if (address) _counters.users_active.add(address) }
function trackUpload()      { _counters.uploads++ }
function trackError()       { _counters.errors++ }

// SOCKS5 TCP tunnel through Tor (127.0.0.1:9050) for .onion addresses
function _socks5Connect(hostname, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(9050, '127.0.0.1')
    sock.setTimeout(15000)
    sock.once('error', reject)
    sock.once('timeout', () => { sock.destroy(); reject(new Error('SOCKS5 timeout')) })

    // Step 1 — greeting: version=5, 1 method, no-auth
    sock.once('data', (greet) => {
      if (greet[0] !== 0x05 || greet[1] !== 0x00) {
        sock.destroy(); return reject(new Error('SOCKS5 auth rejected'))
      }
      // Step 2 — CONNECT request
      const host  = Buffer.from(hostname, 'ascii')
      const req   = Buffer.alloc(7 + host.length)
      req[0] = 0x05  // version
      req[1] = 0x01  // CONNECT
      req[2] = 0x00  // reserved
      req[3] = 0x03  // domain name
      req[4] = host.length
      host.copy(req, 5)
      req.writeUInt16BE(port, 5 + host.length)
      sock.write(req)

      sock.once('data', (reply) => {
        if (reply[1] !== 0x00) {
          sock.destroy(); return reject(new Error(`SOCKS5 connect failed: ${reply[1]}`))
        }
        resolve(sock)
      })
    })

    sock.write(Buffer.from([0x05, 0x01, 0x00]))
  })
}

// HTTP POST over plain TCP (works for both localhost and .onion via SOCKS5)
async function _post(url, body) {
  const parsed   = new URL(url)
  const hostname = parsed.hostname
  const port     = parseInt(parsed.port) || 80
  const isOnion  = hostname.endsWith('.onion')

  const data    = JSON.stringify(body)
  const request = [
    `POST ${parsed.pathname} HTTP/1.0`,
    `Host: ${hostname}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(data)}`,
    'Connection: close',
    '',
    data,
  ].join('\r\n')

  return new Promise(async (resolve) => {
    try {
      let sock
      if (isOnion) {
        sock = await _socks5Connect(hostname, port)
      } else {
        sock = net.createConnection(port, hostname)
        await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j) })
      }

      sock.setTimeout(15000)
      let response = ''
      sock.on('data', d => { response += d.toString() })
      sock.on('close', () => {
        const line = response.split('\r\n')[0] || ''
        const code = parseInt(line.split(' ')[1]) || 0
        resolve(code)
      })
      sock.on('error', () => resolve(0))
      sock.on('timeout', () => { sock.destroy(); resolve(0) })
      sock.write(request)
    } catch {
      resolve(0)
    }
  })
}

async function _registerNode() {
  if (!_headUrl || !_pubkey) return
  const base    = _headUrl.replace(/\/$/, '')
  const nodeUrl = _nodeData?.onion || null

  // Register the node itself
  const nodePayload = {
    pubkey:       _pubkey,
    name:         _nodeName || 'unknown',
    onion:        nodeUrl || '',
    node_url:     nodeUrl || '',
    capabilities: _nodeData?.capabilities || ['media', 'relay'],
    ws_port:      4848,
  }
  const nodeStatus = await _post(`${base}/api/v1/head/node`, nodePayload)
  console.log(`[HEARTBEAT] Node registration → HTTP ${nodeStatus}`)

  // Register the wallet address as a user
  if (_walletAddr) {
    const userPayload = {
      address:  _walletAddr,
      pubkey:   _pubkey,
      node_url: nodeUrl || '',
      name:     _walletName || 'default',
    }
    const walletStatus = await _post(`${base}/api/v1/head/user`, userPayload)
    console.log(`[HEARTBEAT] Wallet registration → HTTP ${walletStatus}`)
  }
}

async function _beat() {
  if (!_headUrl || !_pubkey) return

  const payload = {
    pubkey:       _pubkey,
    node_name:    _nodeName || 'unknown',
    requests_1h:  _counters.requests,
    users_active: _counters.users_active.size,
    uploads_1h:   _counters.uploads,
    errors_1h:    _counters.errors,
    uptime_s:     Math.floor((Date.now() - _startTime) / 1000),
  }

  _counters = { requests: 0, users_active: new Set(), uploads: 0, errors: 0 }

  const base   = _headUrl.replace(/\/$/, '')
  const status = await _post(`${base}/api/v1/head/heartbeat`, payload)
  if (status !== 200) {
    console.warn(`[HEARTBEAT] Head node unreachable (${status}) — will retry`)
  }
}

function startHeartbeat({ headUrl, pubkey, nodeName, nodeData = {}, walletAddress = null, walletName = null, intervalMs = 60000 }) {
  if (!headUrl || !pubkey) return
  _headUrl    = headUrl
  _pubkey     = pubkey
  _nodeName   = nodeName
  _nodeData   = nodeData
  _walletAddr = walletAddress
  _walletName = walletName

  if (_intervalId) clearInterval(_intervalId)
  _intervalId = setInterval(_beat, intervalMs)

  console.log(`[HEARTBEAT] Started → ${headUrl} every ${intervalMs / 1000}s`)

  // Register node + wallet 10s after startup, then send first heartbeat
  setTimeout(() => _registerNode().then(() => _beat()).catch(() => {}), 10000)
}

function stopHeartbeat() {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null }
}

// Call this whenever a user registers, updates profile, or unlocks wallet.
// Fire-and-forget — errors are silently swallowed.
function registerUser({ address, name, pubkey }) {
  if (!_headUrl || !address) return
  const base    = _headUrl.replace(/\/$/, '')
  const nodeUrl = _nodeData?.onion || ''
  const payload = { address, pubkey: pubkey || _pubkey || '', node_url: nodeUrl, name: name || '' }
  _post(`${base}/api/v1/head/user`, payload)
    .then(s => { if (s !== 200) console.warn(`[HEARTBEAT] User registration HTTP ${s}`) })
    .catch(() => {})
}

// Fire-and-forget POST to an arbitrary head node path — for use by other modules
function _postToHead(path, body) {
  if (!_headUrl) return Promise.resolve(0)
  return _post(_headUrl.replace(/\/$/, '') + path, body)
}

module.exports = { startHeartbeat, stopHeartbeat, trackRequest, trackUser, trackUpload, trackError, registerUser, _postToHead }
