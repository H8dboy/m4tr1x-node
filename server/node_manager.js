/**
 * M4TR1X — Node Manager
 * Public nodes: film | music | reels | topic  (community-run)
 * Shop + crypto run exclusively on the private M4TR1X node (PRIVATE_NODE_URL).
 * This prevents any third party from intercepting payments or token transfers.
 */

const path = require('path')
const fs   = require('fs')
const os   = require('os')
const { publishNote, getCurrentPubkey, loadSavedKeys, subscribeToFilter, getUnlockedNostrPrivkey } = require('./nostr')

const NODE_KIND    = 30078
const NODE_TAG     = 'm4tr1x-node'
const NODE_NAME    = process.env.NODE_NAME || 'alpha'
const VALID_CAPS   = new Set(['film', 'music', 'reels', 'topic', 'head'])
const IS_HEAD_NODE = process.env.HEAD_NODE === 'true'

// Private M4TR1X node URL — all shop/crypto calls route here
const PRIVATE_NODE_URL = process.env.PRIVATE_NODE_URL || null

// ─── Persist node config in userData ─────────────────────────────────────────
const DATA_DIR  = process.env.M4TR1X_DATA_DIR || process.cwd()
const NODE_FILE = path.join(DATA_DIR, 'node_config.json')

function loadNodeConfig() {
  try { return JSON.parse(fs.readFileSync(NODE_FILE, 'utf8')) } catch { return null }
}

function saveNodeConfig(cfg) {
  fs.writeFileSync(NODE_FILE, JSON.stringify(cfg, null, 2), 'utf8')
}

// In-memory node registry (pubkey → node info)
const nodeRegistry = new Map()

// ─── Declare this device as a node ───────────────────────────────────────────
async function declareNode(capabilities, wsPort = 4848) {
  const pubkey = getCurrentPubkey()
  if (!pubkey) throw new Error('No identity — create account first')

  const validCaps = capabilities.filter(c => VALID_CAPS.has(c))
  if (!validCaps.length) throw new Error('Invalid capabilities')

  const onion   = getOnionAddress()
  const nodeUrl = getLocalUrl()
  const cfg = { name: NODE_NAME, capabilities: validCaps, wsPort, nodeUrl, onion: onion || undefined, since: Math.floor(Date.now() / 1000) }
  saveNodeConfig(cfg)

  const privkey = getUnlockedNostrPrivkey()
  if (privkey) {
    publishNote(
      JSON.stringify({ type: NODE_TAG, name: NODE_NAME, capabilities: validCaps, port: wsPort, nodeUrl, onion }),
      privkey,
      [
        ['t', NODE_TAG],
        ['caps', validCaps.join(',')],
        ['port', String(wsPort)],
        ['node-url', nodeUrl],
        ...(onion ? [['onion', onion]] : []),
      ]
    ).catch(() => {})
  } else {
    console.warn('[NODE] Nostr keys locked — node announcement skipped (unlock to broadcast)')
  }

  nodeRegistry.set(pubkey, { pubkey, name: NODE_NAME, capabilities: validCaps, wsPort, nodeUrl, onion, ts: Date.now() })
  console.log(`[NODE] "${NODE_NAME}" declared: ${validCaps.join(', ')}${onion ? ` | .onion: ${onion}` : ''}`)
  return cfg
}

// ─── Stop being a node ────────────────────────────────────────────────────────
function resignNode() {
  try { fs.unlinkSync(NODE_FILE) } catch {}
  const pubkey = getCurrentPubkey()
  if (pubkey) nodeRegistry.delete(pubkey)
  console.log('[NODE] Node resigned')
}

// ─── Discover nodes for a capability ─────────────────────────────────────────
function discoverNodes(capability) {
  const now = Date.now()
  // Return nodes seen in last 10 minutes
  return [...nodeRegistry.values()].filter(n =>
    (now - n.ts < 10 * 60 * 1000) &&
    (!capability || n.capabilities.includes(capability))
  )
}

// ─── Subscribe to node announcements from the Nostr relay ────────────────────
function startNodeDiscovery() {
  const since = Math.floor(Date.now() / 1000) - 600  // last 10 min
  subscribeToFilter({ kinds: [1], '#t': [NODE_TAG], since }, ev => {
    try {
      const data = JSON.parse(ev.content)
      if (data.type !== NODE_TAG) return
      const caps = (data.capabilities || []).filter(c => VALID_CAPS.has(c))
      if (!caps.length) return
      nodeRegistry.set(ev.pubkey, {
        pubkey:       ev.pubkey,
        capabilities: caps,
        wsPort:       data.port || 4848,
        ts:           Date.now(),
      })
    } catch {}
  })
}

// ─── Get this device's node config ───────────────────────────────────────────
function getNodeConfig() {
  return loadNodeConfig()
}

// ─── Route helper: pick best node for a capability ───────────────────────────
function pickNode(capability) {
  const nodes = discoverNodes(capability)
  if (!nodes.length) return null
  // Prefer most recently seen
  return nodes.sort((a, b) => b.ts - a.ts)[0]
}

// ─── Get this node's LAN URL ─────────────────────────────────────────────────
function getLocalUrl(port = 8080) {
  if (process.env.PUBLIC_NODE_URL) return process.env.PUBLIC_NODE_URL
  const nets = os.networkInterfaces()
  const lan  = Object.values(nets).flat().find(n => n.family === 'IPv4' && !n.internal)
  return lan ? `http://${lan.address}:${port}` : `http://localhost:${port}`
}

// ─── Get .onion address if Tor is running ────────────────────────────────────
function getOnionAddress() {
  const candidates = [
    process.env.TOR_HOSTNAME_FILE,
    path.join(process.env.M4TR1X_DATA_DIR || path.join(require('os').homedir(), '.config', 'm4tr1x'), 'onion_hostname'),
    '/var/lib/tor/m4tr1x/hostname',
  ].filter(Boolean)
  for (const f of candidates) {
    try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v } catch {}
  }
  return null
}

// ─── Announce content to the network ─────────────────────────────────────────
// Called after every upload so other nodes know this content is here.
const CONTENT_KIND = 30403

async function announceContent({ id, type, title, category, uploader }) {
  const privkey = getUnlockedNostrPrivkey()
  if (!privkey) return
  const nodeUrl = getLocalUrl()
  const onion   = getOnionAddress()

  // Nostr broadcast
  publishNote(
    JSON.stringify({ id, type, title, category, uploader, node: nodeUrl, nodeName: NODE_NAME }),
    privkey,
    [
      ['t', 'm4tr1x-content'],
      ['content-id', id],
      ['content-type', type],
      ['node-url', nodeUrl],
    ]
  ).catch(() => {})

  // Head node registry
  if (process.env.HEAD_NODE_URL) {
    require('./heartbeat')._postToHead('/api/v1/head/content', {
      content_id:      id,
      content_type:    type || category || 'video',
      title:           title || '',
      creator_address: uploader || '',
      node_url:        nodeUrl || '',
      onion:           onion ? `http://${onion}` : (process.env.PRIVATE_NODE_URL || ''),
    }).catch(() => {})
  }

  console.log(`[NODE] Content announced: ${type}/${id} on ${nodeUrl}`)
}

// ─── Locate content across nodes ─────────────────────────────────────────────
// Returns { nodeUrl, id } for the first node that has this content ID.
const contentRegistry = new Map()  // id → { nodeUrl, ts }

function locateContent(id) {
  const entry = contentRegistry.get(id)
  if (!entry) return null
  if (Date.now() - entry.ts > 30 * 60 * 1000) { contentRegistry.delete(id); return null }
  return entry
}

function startContentDiscovery() {
  const since = Math.floor(Date.now() / 1000) - 1800  // last 30 min
  try {
    subscribeToFilter({ kinds: [1], '#t': ['m4tr1x-content'], since }, ev => {
      try {
        const data = JSON.parse(ev.content)
        if (!data.id || !data.node) return
        contentRegistry.set(data.id, { nodeUrl: data.node, nodeName: data.nodeName, ts: Date.now() })
      } catch {}
    })
  } catch {}
}

// Returns the private node URL for shop/crypto calls
function getPrivateNodeUrl() {
  return PRIVATE_NODE_URL
}

// ─── Query another m4tr1x node's API ─────────────────────────────────────────
async function queryNode(nodeUrl, apiPath, timeoutMs = 5000) {
  const https  = require('https')
  const http   = require('http')
  const url    = new URL(apiPath, nodeUrl)
  const proto  = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = proto.get(url.toString(), { headers: { 'x-m4tr1x-node': '1' } }, res => {
      let raw = ''
      res.on('data', d => { raw += d })
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) }
        catch { reject(new Error('Invalid JSON from node')) }
      })
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Node timeout')) })
    req.on('error', reject)
  })
}

// ─── Fetch content from all m4tr1x nodes with a given capability ──────────────
async function fetchFromNodes(capability, apiPath) {
  const nodes   = discoverNodes(capability)
  const local   = getLocalUrl()
  const results = await Promise.allSettled(
    nodes
      .filter(n => n.nodeUrl && n.nodeUrl !== local)
      .map(n => queryNode(n.nodeUrl, apiPath).then(data => ({ node: n, data })))
  )
  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
}

module.exports = {
  declareNode,
  resignNode,
  discoverNodes,
  startNodeDiscovery,
  startContentDiscovery,
  announceContent,
  locateContent,
  getLocalUrl,
  getOnionAddress,
  getNodeConfig,
  pickNode,
  getPrivateNodeUrl,
  queryNode,
  fetchFromNodes,
  VALID_CAPS: [...VALID_CAPS],
}
