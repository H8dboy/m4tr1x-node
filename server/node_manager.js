/**
 * M4TR1X — Node Manager
 * Each M4TR1X installation can declare itself a specialized node.
 * Node types: film | music | reels | topic | shop | crypto
 * Nodes publish their role on Nostr (kind 30078) and serve content
 * for their declared type. Shop/crypto payments route exclusively
 * through nodes that declared the 'crypto' capability.
 */

const path = require('path')
const fs   = require('fs')
const { publishNote, getCurrentPubkey, wsSub } = require('./nostr')

const NODE_KIND    = 30078  // NIP-78 app-specific data
const NODE_TAG     = 'm4tr1x-node'
const VALID_CAPS   = new Set(['film', 'music', 'reels', 'topic', 'shop', 'crypto'])

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

  const cfg = { capabilities: validCaps, wsPort, since: Math.floor(Date.now() / 1000) }
  saveNodeConfig(cfg)

  // Publish to Nostr so other peers discover this node
  await publishNote(
    JSON.stringify({ type: NODE_TAG, capabilities: validCaps, port: wsPort }),
    [
      ['t', NODE_TAG],
      ['caps', validCaps.join(',')],
      ['port', String(wsPort)],
    ]
  )

  nodeRegistry.set(pubkey, { pubkey, capabilities: validCaps, wsPort, ts: Date.now() })
  console.log(`[NODE] Declared as node: ${validCaps.join(', ')}`)
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
  wsSub('nodes', { kinds: [1], '#t': [NODE_TAG], since }, ev => {
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

module.exports = {
  declareNode,
  resignNode,
  discoverNodes,
  startNodeDiscovery,
  getNodeConfig,
  pickNode,
  VALID_CAPS: [...VALID_CAPS],
}
