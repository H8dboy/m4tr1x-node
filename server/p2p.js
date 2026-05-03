/**
 * M4TR1X P2P — WebRTC mesh for HLS video distribution
 *
 * Architecture:
 *   - Videos are already served as HLS (.m3u8 + .ts segments).
 *   - p2p-media-loader (loaded from CDN on the client) intercepts hls.js
 *     segment requests and serves them from WebRTC peers when available.
 *   - This server runs a minimal WebSocket tracker (BEP-55 compatible) that
 *     peers use to find each other per stream.  No BitTorrent client needed.
 *   - Every browser (desktop, Android, iOS PWA) watching a video becomes a
 *     seeder for the segments it already downloaded.
 *   - Falls back transparently to HTTP if WebRTC is unavailable.
 *
 * The tracker is attached to the existing HTTP server on path /p2p-tracker.
 * No extra port.
 *
 * Public fallback trackers are also included so the swarm works even when
 * the node is behind NAT or the tracker WS path is unreachable.
 */

'use strict'

const WebSocket = require('ws')

// ─── Public fallback trackers (WebTorrent-compatible) ─────────────────────────
const PUBLIC_TRACKERS = [
  'wss://tracker.btorrent.xyz',
  'wss://tracker.openwebtorrent.com',
]

// ─── In-memory swarm state ─────────────────────────────────────────────────────
// info_hash (hex) → Map<peer_id, WebSocket>
const swarms = new Map()

function getSwarm(infoHash) {
  if (!swarms.has(infoHash)) swarms.set(infoHash, new Map())
  return swarms.get(infoHash)
}

function removePeer(ws) {
  if (!ws._p2p) return
  for (const ih of ws._p2p.infoHashes) {
    const swarm = swarms.get(ih)
    if (!swarm) continue
    swarm.delete(ws._p2p.peerId)
    if (swarm.size === 0) swarms.delete(ih)
  }
}

function send(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  } catch {}
}

// ─── Tracker message handler ──────────────────────────────────────────────────
function handleMessage(ws, raw) {
  let msg
  try { msg = JSON.parse(raw) } catch { return }

  if (msg.action !== 'announce') return

  const { info_hash, peer_id, offers, answer, to_peer_id, offer_id, numwant = 5 } = msg
  if (!info_hash || !peer_id) return

  // Register peer
  if (!ws._p2p) ws._p2p = { peerId: peer_id, infoHashes: new Set() }
  ws._p2p.peerId = peer_id

  const swarm = getSwarm(info_hash)
  swarm.set(peer_id, ws)
  ws._p2p.infoHashes.add(info_hash)

  // Forward answer to specific peer
  if (answer && to_peer_id) {
    const target = swarm.get(to_peer_id)
    if (target) send(target, { action: 'announce', answer, offer_id, peer_id, info_hash })
    return
  }

  // Distribute offers to other peers in the swarm
  if (offers && offers.length > 0) {
    const others = [...swarm.values()].filter(p => p !== ws && p.readyState === WebSocket.OPEN)
    const targets = others.slice(0, Math.min(numwant, offers.length))
    targets.forEach((peer, i) => {
      const { offer, offer_id: oid } = offers[i]
      send(peer, { action: 'announce', offer, offer_id: oid, peer_id, info_hash })
    })
  }

  // Acknowledge with swarm counts
  send(ws, {
    action:    'announce',
    info_hash,
    interval:  120,
    complete:  swarm.size,
    incomplete: 0,
  })
}

// ─── Attach tracker to existing HTTP server ───────────────────────────────────
let _wss = null

function attachToServer(httpServer) {
  if (_wss) return  // already attached

  _wss = new WebSocket.Server({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== '/p2p-tracker') return
    _wss.handleUpgrade(req, socket, head, ws => _wss.emit('connection', ws, req))
  })

  _wss.on('connection', ws => {
    ws._p2p = null
    ws.on('message', raw => handleMessage(ws, raw))
    ws.on('close',   ()  => removePeer(ws))
    ws.on('error',   ()  => removePeer(ws))
  })

  // Cleanup dead connections every 2 minutes
  setInterval(() => {
    for (const [ih, swarm] of swarms) {
      for (const [pid, peer] of swarm) {
        if (peer.readyState !== WebSocket.OPEN) swarm.delete(pid)
      }
      if (swarm.size === 0) swarms.delete(ih)
    }
  }, 120_000)

  console.log('[P2P] WebRTC tracker attached → ws://<host>/p2p-tracker')
}

// ─── Config for clients ───────────────────────────────────────────────────────
function getP2PConfig(publicBase) {
  const base = (publicBase || '').replace(/^http/, 'ws').replace(/\/$/, '')
  const selfTracker = base ? `${base}/p2p-tracker` : null
  return {
    enabled:  true,
    trackers: [...(selfTracker ? [selfTracker] : []), ...PUBLIC_TRACKERS],
    // p2p-media-loader loader config (passed to client via /api/v1/p2p/config)
    loader: {
      trackerAnnounce:     selfTracker ? [selfTracker, ...PUBLIC_TRACKERS] : PUBLIC_TRACKERS,
      simultaneousP2PDownloads:   3,
      httpDownloadProbability:    0.1,    // prefer P2P, fall back to HTTP
      p2pDownloadMaxPriority:     50,
      httpDownloadMaxPriority:    100,
      isLiveStream:               false,
      cachedSegmentExpiration:    300000, // cache segments 5min in memory
      cachedSegmentsCount:        20,
    },
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function getStats() {
  let totalPeers = 0
  const streams = []
  for (const [ih, swarm] of swarms) {
    const count = swarm.size
    totalPeers += count
    streams.push({ info_hash: ih, peers: count })
  }
  return { active_streams: swarms.size, total_peers: totalPeers, streams }
}

module.exports = { attachToServer, getP2PConfig, getStats, PUBLIC_TRACKERS }
