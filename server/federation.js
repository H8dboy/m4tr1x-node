'use strict'

const net = require('net')

// nodeUrl → { videos, tracks, photos, ts }
const _cache = new Map()
let _selfUrl   = null
let _headUrl   = null
let _syncTimer = null

// ─── SOCKS5 TCP tunnel for .onion ────────────────────────────────────────────
function _socks5Connect(hostname, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(9050, '127.0.0.1')
    sock.setTimeout(25000)
    sock.once('error', reject)
    sock.once('timeout', () => { sock.destroy(); reject(new Error('SOCKS5 timeout')) })

    sock.once('data', greet => {
      if (greet[0] !== 0x05 || greet[1] !== 0x00) {
        sock.destroy(); return reject(new Error('SOCKS5 auth rejected'))
      }
      const host = Buffer.from(hostname, 'ascii')
      const req  = Buffer.alloc(7 + host.length)
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03
      req[4] = host.length
      host.copy(req, 5)
      req.writeUInt16BE(port, 5 + host.length)
      sock.write(req)

      sock.once('data', reply => {
        if (reply[1] !== 0x00) {
          sock.destroy(); return reject(new Error(`SOCKS5 connect failed: ${reply[1]}`))
        }
        resolve(sock)
      })
    })
    sock.write(Buffer.from([0x05, 0x01, 0x00]))
  })
}

// ─── HTTP GET over raw TCP (plain or .onion) ─────────────────────────────────
async function _get(url) {
  const parsed   = new URL(url)
  const hostname = parsed.hostname
  const port     = parseInt(parsed.port) || 80
  const isOnion  = hostname.endsWith('.onion')

  const request = [
    `GET ${parsed.pathname}${parsed.search} HTTP/1.0`,
    `Host: ${hostname}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n')

  return new Promise(async resolve => {
    try {
      let sock
      if (isOnion) {
        sock = await _socks5Connect(hostname, port)
      } else {
        sock = net.createConnection(port, hostname)
        await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j) })
      }
      sock.setTimeout(25000)
      let raw = ''
      sock.on('data', d => { raw += d.toString() })
      sock.on('close', () => {
        const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
      sock.on('error', () => resolve(null))
      sock.on('timeout', () => { sock.destroy(); resolve(null) })
      sock.write(request)
    } catch { resolve(null) }
  })
}

// ─── Sync one remote node ─────────────────────────────────────────────────────
async function syncNode(nodeUrl, onionUrl) {
  const base = (onionUrl || nodeUrl || '').replace(/\/$/, '')
  if (!base) return

  const [videos, tracks, photos] = await Promise.all([
    _get(`${base}/api/v1/video/list?limit=50`),
    _get(`${base}/api/v1/music/tracks?limit=50`),
    _get(`${base}/api/v1/photo/list?limit=50`),
  ])

  const tag = v => ({ ...v, _node: nodeUrl, _base: base })
  _cache.set(nodeUrl, {
    nodeUrl,
    videos:  Array.isArray(videos) ? videos.map(tag)  : [],
    tracks:  Array.isArray(tracks) ? tracks.map(tag)  : [],
    photos:  Array.isArray(photos) ? photos.map(tag)  : [],
    ts: Date.now(),
  })

  const e = _cache.get(nodeUrl)
  console.log(`[FEDERATION] ${nodeUrl}: ${e.videos.length}v ${e.tracks.length}t ${e.photos.length}p`)
}

// ─── Sync all nodes from head registry ───────────────────────────────────────
async function syncAllNodes() {
  if (!_headUrl) return
  const data = await _get(`${_headUrl.replace(/\/$/, '')}/api/v1/head/nodes`)
  if (!Array.isArray(data)) return

  const self = (_selfUrl || '').replace(/\/$/, '')
  await Promise.allSettled(
    data
      .filter(n => n.node_url && n.node_url.replace(/\/$/, '') !== self)
      .map(n => {
        const onion = n.onion ? n.onion.replace(/^https?:\/\//, '') : null
        return syncNode(n.node_url, onion ? `http://${onion}` : null)
          .catch(e => console.warn(`[FEDERATION] ${n.node_url}: ${e.message}`))
      })
  )
}

// ─── Start federation sync loop ───────────────────────────────────────────────
function startFederation({ headUrl, selfUrl, intervalMs = 5 * 60 * 1000 } = {}) {
  _headUrl = headUrl || process.env.HEAD_NODE_URL
  _selfUrl = selfUrl
  if (!_headUrl) return
  if (_syncTimer) clearInterval(_syncTimer)
  setTimeout(() => syncAllNodes().catch(() => {}), 30000)
  _syncTimer = setInterval(() => syncAllNodes().catch(() => {}), intervalMs)
  console.log(`[FEDERATION] Started — every ${intervalMs / 60000}min`)
}

// ─── Merged global feed ───────────────────────────────────────────────────────
function getGlobalFeed(type = 'film', limit = 50) {
  const items = []
  const staleMs = 35 * 60 * 1000
  for (const e of _cache.values()) {
    if (Date.now() - e.ts > staleMs) continue
    if (type === 'film'  || type === 'video') items.push(...e.videos)
    if (type === 'music' || type === 'track') items.push(...e.tracks)
    if (type === 'photo')                     items.push(...e.photos)
  }
  return items
    .sort((a, b) => (new Date(b.created_at || 0)) - (new Date(a.created_at || 0)))
    .slice(0, limit)
}

// ─── Get creator's registered node URL from head cache ────────────────────────
function getCreatorNode(address) {
  // scan cached node data — cheapest approach since we already sync nodes
  if (!address) return null
  for (const e of _cache.values()) {
    const all = [...e.videos, ...e.tracks, ...e.photos]
    if (all.some(i => i.uploader_address === address)) return e.nodeUrl
  }
  return null
}

module.exports = { startFederation, syncAllNodes, syncNode, getGlobalFeed, getCreatorNode }
