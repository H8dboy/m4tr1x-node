/**
 * M4TR1X — Node Manager
 * Public nodes: film | music | reels | topic  (community-run)
 * Shop + crypto run exclusively on the private M4TR1X node (PRIVATE_NODE_URL).
 * This prevents any third party from intercepting payments or token transfers.
 */

const path = require('path')
const fs   = require('fs')
const { publishNote, getCurrentPubkey, loadSavedKeys, subscribeToFilter } = require('./nostr')

const NODE_KIND    = 30078
const NODE_TAG     = 'm4tr1x-node'
const NODE_NAME    = process.env.NODE_NAME || 'alpha'
const VALID_CAPS   = new Set(['film', 'music', 'reels', 'topic'])

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

  const cfg = { name: NODE_NAME, capabilities: validCaps, wsPort, since: Math.floor(Date.now() / 1000) }
  saveNodeConfig(cfg)

  // Publish only to the embedded local relay, not external Nostr networks
  const keys = loadSavedKeys()
  if (keys) {
    publishNote(
      JSON.stringify({ type: NODE_TAG, name: NODE_NAME, capabilities: validCaps, port: wsPort }),
      keys.privkey,
      [
        ['t', NODE_TAG],
        ['caps', validCaps.join(',')],
        ['port', String(wsPort)],
      ]
    ).catch(() => {}) // fire-and-forget — local relay only, no external deps
  }

  nodeRegistry.set(pubkey, { pubkey, name: NODE_NAME, capabilities: validCaps, wsPort, ts: Date.now() })
  console.log(`[NODE] "${NODE_NAME}" declared: ${validCaps.join(', ')}`)
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

// Returns the private node URL for shop/crypto calls
function getPrivateNodeUrl() {
  return PRIVATE_NODE_URL
}

module.exports = {
  declareNode,
  resignNode,
  discoverNodes,
  startNodeDiscovery,
  getNodeConfig,
  pickNode,
  getPrivateNodeUrl,
  VALID_CAPS: [...VALID_CAPS],
}
