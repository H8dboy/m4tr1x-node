/**
 * M4TR1X - API Server (Node.js / Express)
 * Traduzione completa di api_server.py senza Python.
 *
 * Dipendenze: express, cors, multer, express-rate-limit, better-sqlite3, uuid, dotenv
 */

const express    = require('express')
const cors       = require('cors')
const multer     = require('multer')
const rateLimit  = require('express-rate-limit')
const path       = require('path')
const fs         = require('fs')
const crypto     = require('crypto')
const { v4: uuidv4 } = require('uuid')
require('dotenv').config()

const { analyzeVideo }           = require('./ai_detector')
const { cleanMetadata, isExifToolAvailable } = require('./core')
const db = require('./db')
const { initDb, saveResult, loadResult, listResults } = db
const {
  generateIdentity, unlockIdentity, lockIdentity,
  identityExists, getPublicInfo, deriveSigningKey,
} = require('./h8identity')
const {
  generateKeys, loadSavedKeys, loadKeys, getCurrentPubkey,
  unlockNostrKeys, lockNostrKeys, getUnlockedNostrPrivkey,
  connectToRelays, getConnectedRelays,
  publishNote, publishVideoAttestation,
  fetchFeed, sendEncryptedDM, fetchDMs, publishProfile,
  DEFAULT_RELAYS,
} = require('./nostr')
const mastodon  = require('./mastodon')
const peertube  = require('./peertube')
const funkwhale = require('./funkwhale')
const {
  initCrowdtrainDb,
  submitVote, computeConsensus, publishVoteToNostr, syncVotesFromNostr,
  getVideoStats, getGlobalStats, getLeaderboard,
  getConfirmedLabels, registerModelVersion, getLatestModelVersion,
} = require('./crowdtrain')
const { checkAndUpdateModel } = require('./model_updater')
const {
  initBadgeDb, requestBadge, getApprovedBadge, getAllRequests,
  approveRequest, rejectRequest, getUserRequest,
} = require('./badges')

const { declareNode, resignNode, discoverNodes, startNodeDiscovery, startContentDiscovery, announceContent, locateContent, getLocalUrl, getOnionAddress, getNodeConfig, pickNode, getPrivateNodeUrl, VALID_CAPS } = require('./node_manager')
const { startStream, stopStream, sendSignal, listStreams, registerRemoteStream, removeRemoteStream } = require('./livestream')
const videoHost  = require('./video_host')
const photo      = require('./photo')
const story      = require('./story')
const p2p        = require('./p2p')
const federation = require('./federation')

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Embedded Nostr Relay Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
// Avviato in processo figlio per evitare che EADDRINUSE faccia crashare il server
const _net = require('net')
const _sock = _net.createConnection(4848, '127.0.0.1')
_sock.once('connect', () => { _sock.destroy(); console.log('[RELAY] Already running on :4848') })
_sock.once('error', () => {
  try {
    require('./relay')
    console.log('[M4TR1X] Embedded Nostr relay starting on ws://localhost:4848')
  } catch (e) {
    console.error('[RELAY] Failed to start relay:', e.message)
  }
})
// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Config Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
const MAX_FILE_MB      = parseInt(process.env.MAX_FILE_SIZE_MB || '100')
const API_KEY          = process.env.M4TR1X_API_KEY || ''
const ALLOWED_ORIGINS  = (process.env.ALLOWED_ORIGINS || 'http://localhost:8080').split(',')
const ALLOWED_EXT      = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv'])

const DATA_DIR      = process.env.M4TR1X_DATA_DIR || process.cwd()
const UPLOAD_DIR    = path.join(DATA_DIR, 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const ADMIN_KEY_FILE = path.join(DATA_DIR, '.admin_key')
const ADMIN_KEY = (() => {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY
  if (fs.existsSync(ADMIN_KEY_FILE)) return fs.readFileSync(ADMIN_KEY_FILE, 'utf8').trim()
  const generated = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(ADMIN_KEY_FILE, generated, { mode: 0o600 })
  console.warn('[SECURITY] ADMIN_KEY generata e salvata in .admin_key â€” conservala.')
  console.warn(`[SECURITY]     ${generated}`)
  return generated
})()
const BADGE_DOCS_DIR = path.join(DATA_DIR, 'badge_docs')
if (!fs.existsSync(BADGE_DOCS_DIR)) fs.mkdirSync(BADGE_DOCS_DIR, { recursive: true })

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ App Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
const app = express()

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("X-XSS-Protection", "1; mode=block")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
  next()
})

// CORS Ã¢Â€Â” accetta localhost (Electron) + origini configurate
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)
    if (origin.startsWith('http://192.168.') || origin.startsWith('http://10.') ||
        origin.startsWith('http://172.') || origin.includes('.onion') ||
        origin.includes('localhost') || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true)
    }
    cb(null, false)
  },

  credentials: false,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['X-Nostr-Pubkey', 'X-API-Key', 'X-Admin-Key', 'Content-Type'],
}))

// Rate limit globale su tutte le route pubbliche (100 req/min per IP)
const globalLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppe richieste. Riprova tra un minuto.' },
})

// Stripe webhook needs raw body â€” register BEFORE express.json()
app.post('/api/v1/shop/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const shopMod = require('./h8shop')
    const result  = await shopMod.handleStripeWebhook(req.body, req.headers['stripe-signature'])
    res.json(result)
  } catch (err) {
    console.error('[STRIPE WEBHOOK]', err.message)
    res.status(400).json({ error: err.message })
  }
})

app.use(express.json())
app.use(globalLimit)

// Track every request + active user for head node heartbeat
app.use((req, res, next) => {
  if (process.env.HEAD_NODE_URL) {
    const hb = require('./heartbeat')
    hb.trackRequest()
    const addr = req.headers['x-nostr-pubkey'] || req.headers['x-h8-address'] || req.query?.address
    if (addr) hb.trackUser(addr)
    // Track errors via response status
    const orig = res.json.bind(res)
    res.json = function(body) {
      if (res.statusCode >= 500) hb.trackError()
      return orig(body)
    }
  }
  next()
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Multer (upload file) Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
})

// Photo upload (JPEG/PNG/WebP/GIF â€” max 20MB)
const ALLOWED_IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"])
const photoUpload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase()
    cb(null, ALLOWED_IMG_EXT.has(ext) || file.mimetype.startsWith("image/"))
  },
})

// Badge document upload (PDF, JPG, PNG Ã¢Â€Â” max 10MB)
const badgeUpload = multer({
  dest: BADGE_DOCS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png']
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, allowed.includes(ext))
  },
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Rate limiting Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
const analyzeLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppe richieste. Riprova tra un minuto.' },
})

// Rate limit per operazioni di pagamento (10 al minuto)
const paymentLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppe transazioni. Riprova tra un minuto.' },
})

// Rate limit upload (20 upload/ora per IP)
const uploadLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Limite upload raggiunto. Riprova tra un'ora." },
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ API Key middleware Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
function verifyApiKey(req, res, next) {
  const ip = req.socket.remoteAddress || ''
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  if (API_KEY && !isLocal && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' })
  }
  next()
}

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Routes Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    version: '2.3.0',
    runtime: 'electron+node',
    exiftool_available: isExifToolAvailable(),
  })
})

// â”€â”€â”€ Blossom local storage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BLOBS_DIR = path.join(DATA_DIR, 'blobs')
if (!fs.existsSync(BLOBS_DIR)) fs.mkdirSync(BLOBS_DIR, { recursive: true })

const blossomUpload = multer({ dest: BLOBS_DIR, limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } })

app.post('/blossom/upload', blossomUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' })
  const buf = fs.readFileSync(req.file.path)
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  const dest = path.join(BLOBS_DIR, sha256)
  fs.renameSync(req.file.path, dest)
  const base = (process.env.PRIVATE_NODE_URL || 'http://localhost:8080').replace(/\/$/, '')
  const url  = `${base}/blossom/${sha256}`
  const mime = req.file.mimetype || ''

  // Announce to head node and track upload for any media file
  if (mime.startsWith('video/') || mime.startsWith('image/') || mime.startsWith('audio/')) {
    const uploader = req.headers['x-nostr-pubkey'] || req.headers['x-h8-address'] || ''
    const type = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'photo'
    if (process.env.HEAD_NODE_URL) {
      const hb = require('./heartbeat')
      hb.trackUpload()
      announceContent({ id: sha256, type, title: req.file.originalname || sha256.slice(0,12), uploader }).catch(() => {})
    }
  }

  res.json({ url, sha256, size: req.file.size, type: mime })
})

app.get('/blossom/:sha256', (req, res) => {
  const p = path.join(BLOBS_DIR, path.basename(req.params.sha256))
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' })
  res.sendFile(p)
})

// Analisi video
app.post('/api/v1/analyze', analyzeLimit, verifyApiKey, upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file provided' })
  }

  const ext = path.extname(req.file.originalname || '').toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    fs.unlinkSync(req.file.path)
    return res.status(400).json({ error: `Unsupported format: ${ext}` })
  }

  const analysisId  = uuidv4().substring(0, 12)
  const nostrPubkey = req.headers['x-nostr-pubkey'] || null
  const tempPath    = req.file.path

  try {
    // Rimuovi metadati prima dell'analisi
    cleanMetadata(tempPath)

    // Analisi AI
    const report = await analyzeVideo(tempPath)

    // Attestazione Nostr (se pubkey fornita)
    let nostrAttestation = null
    if (nostrPubkey) {
      nostrAttestation = {
        pubkey:     nostrPubkey,
        event_kind: 30078,
        tags: [
          ['d',       `m4tr1x-verify-${analysisId}`],
          ['verdict', report.verdict || 'UNKNOWN'],
          ['hash',    report.video_hash_sha256 || ''],
        ],
        content: `M4TR1X Verification: ${report.verdict || 'UNKNOWN'}`,
      }
    }

    const result = {
      id: analysisId,
      status: report.status,
      ...report,
      nostr_attestation: nostrAttestation,
    }

    saveResult(analysisId, result)
    res.json(result)

  } catch (err) {
    console.error('[SERVER] Analysis error:', err)
    res.status(500).json({ error: err.message })
  } finally {
    // Elimina file temporaneo
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath)
    }
  }
})

// Recupera risultato per ID
app.get('/api/v1/analysis/:id', verifyApiKey, (req, res) => {
  const data = loadResult(req.params.id)
  if (!data) return res.status(404).json({ error: 'Analisi non trovata' })
  res.json(data)
})

// Lista ultimi risultati
app.get('/api/v1/analyses', verifyApiKey, (req, res) => {
  const limit = parseInt(req.query.limit || '50')
  res.json(listResults(limit))
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Routes: H8 Wallet Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€

// Stato wallet H8 (esiste? saldo? address?)
app.get('/api/v1/h8/wallet/status', verifyApiKey, (req, res) => {
  try {
    const exists = identityExists()
    if (!exists) return res.json({ exists: false })
    const info = getPublicInfo()
    res.json({ exists: true, address: info?.address, balance: null, locked: !require('./h8identity').getUnlockedIdentity() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Crea nuova identitÃƒÂ  H8
app.post('/api/v1/h8/wallet/create', verifyApiKey, async (req, res) => {
  try {
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'Password richiesta' })
    if (identityExists()) return res.status(409).json({ error: 'IdentitÃƒÂ  H8 giÃƒÂ  esistente' })
    const result = await generateIdentity(password)
    if (process.env.HEAD_NODE_URL) {
      const hb = require('./heartbeat')
      hb.registerUser({ address: result.address, name: req.body.name || '', pubkey: getCurrentPubkey() })
    }
    res.status(201).json({ address: result.address, message: 'H8 identity creata. Salva la tua password.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Sblocca wallet (password Ã¢Â†Â’ secret key in memoria per la sessione)
app.post('/api/v1/h8/wallet/unlock', verifyApiKey, async (req, res) => {
  try {
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'Password richiesta' })
    const result = await unlockIdentity(password)
    if (process.env.HEAD_NODE_URL) {
      const hb = require('./heartbeat')
      hb.registerUser({ address: result.address, name: result.name || '', pubkey: getCurrentPubkey() })
    }
    res.json({ status: 'unlocked', address: result.address, balance: null })
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

// Blocca wallet
app.post('/api/v1/h8/wallet/lock', verifyApiKey, (req, res) => {
  lockIdentity()
  res.json({ status: 'locked' })
})

// Ritorna address H8 e chiave pubblica di firma (secp256k1 derivata) della sessione attiva.
app.get('/api/v1/h8/session-info', (req, res) => {
  const id = require('./h8identity').getUnlockedIdentity()
  if (!id) return res.status(401).json({ error: 'wallet bloccato' })
  const sk = deriveSigningKey()
  res.json({ address: id.address, pubkey: sk.pubKeyHex })
})

// Firma un evento Nostr con la chiave derivata dall'identitÃ  H8.
// Il client invia l'evento senza id/sig; il server aggiunge entrambi.
app.post('/api/v1/h8/sign-event', (req, res) => {
  try {
    const id = require('./h8identity').getUnlockedIdentity()
    if (!id) return res.status(401).json({ error: 'wallet bloccato' })
    const sk = deriveSigningKey()
    const { schnorr } = require('@noble/curves/secp256k1')
    const ev = req.body
    ev.pubkey = sk.pubKeyHex
    const serial = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])
    ev.id = crypto.createHash('sha256').update(serial).digest('hex')
    ev.sig = Buffer.from(schnorr.sign(Buffer.from(ev.id, 'hex'), sk.privKey)).toString('hex')
    res.json(ev)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// â”€â”€â”€ H8 Token Economy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const h8token    = require('./h8token')
const ledgerSync = require('./ledger_sync')
h8token.initLedger()
ledgerSync.startBlockSync()

app.get('/api/v1/h8/balance', verifyApiKey, (req, res) => {
  const addr = req.query.address || require('./h8identity').getUnlockedIdentity()?.address
  if (!addr) return res.status(400).json({ error: 'address richiesto o wallet bloccato' })
  res.json({ address: addr, balance: h8token.getBalance(addr) })
})

app.get('/api/v1/h8/history', verifyApiKey, (req, res) => {
  const addr = req.query.address || require('./h8identity').getUnlockedIdentity()?.address
  if (!addr) return res.status(400).json({ error: 'address richiesto o wallet bloccato' })
  res.json(h8token.getHistory(addr, parseInt(req.query.limit || '50')))
})

app.post('/api/v1/h8/transfer', paymentLimit, verifyApiKey, async (req, res) => {
  try {
    const { toAddress, amount, note } = req.body
    if (!toAddress || !amount) return res.status(400).json({ error: 'toAddress e amount richiesti' })
    res.json(await h8token.transfer(toAddress, parseInt(amount), note || ''))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/v1/h8/tip', paymentLimit, verifyApiKey, async (req, res) => {
  try {
    const { creatorAddress, amount, contentId } = req.body
    if (!creatorAddress || !amount) return res.status(400).json({ error: 'creatorAddress e amount richiesti' })
    const result = await h8token.tip(creatorAddress, parseInt(amount), contentId || '')
    // Notify head node for tip statistics (fire-and-forget)
    if (process.env.HEAD_NODE_URL) {
      require('./heartbeat')._postToHead('/api/v1/head/tip', {
        from: result.from || '', to: creatorAddress,
        amount: parseInt(amount), content_id: contentId || '',
      }).catch(() => {})
    }
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// NFT photo purchase â€” frontend calls this when buying a photo
app.post('/api/v1/h8tips/send', paymentLimit, async (req, res) => {
  try {
    const { from_h8address, to_pubkey, amount, memo, event_id } = req.body
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' })
    if (!to_pubkey) return res.status(400).json({ error: 'to_pubkey required' })
    const result = await h8token.tip(to_pubkey, parseInt(amount), memo || event_id || '')
    if (process.env.HEAD_NODE_URL) {
      require('./heartbeat')._postToHead('/api/v1/head/tip', {
        from: from_h8address || '', to: to_pubkey,
        amount: parseInt(amount), content_id: event_id || '',
      }).catch(() => {})
    }
    res.json({ ok: true, txid: result.id || result.txid, amount, to: to_pubkey })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/v1/h8/boost', paymentLimit, verifyApiKey, async (req, res) => {
  try {
    const { contentId, amount } = req.body
    if (!contentId || !amount) return res.status(400).json({ error: 'contentId e amount richiesti' })
    res.json(await h8token.boost(contentId, parseInt(amount)))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// IMPORTANTE: batch DEVE stare prima di /:contentId
app.get('/api/v1/h8/boost/batch', verifyApiKey, (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean)
  res.json(h8token.getBoostScoresBatch(ids))
})

app.get('/api/v1/h8/boost/:contentId', verifyApiKey, (req, res) => {
  res.json({ contentId: req.params.contentId, score: h8token.getBoostScore(req.params.contentId) })
})

app.get('/api/v1/h8/chain/verify', async (req, res) => {
  try { res.json(await h8token.verifyChain()) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// Public ledger â€” anyone can read and verify the full transaction history
app.get('/api/v1/h8/ledger', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '100'), 500)
  const offset = parseInt(req.query.offset || '0')
  res.json(h8token.getPublicLedger(limit, offset))
})

// Public supply stats â€” total minted, allocation, max supply
app.get('/api/v1/h8/stats', (req, res) => {
  res.json(h8token.getLedgerStats())
})

// Admin-only mint (requires H8_ADMIN_MINT_KEY env â€” disabled unless explicitly set)
app.post('/api/v1/admin/h8/mint', localhostOnly, verifyAdminKey, async (req, res) => {
  try {
    const { toAddress, amount } = req.body
    if (!toAddress || !amount) return res.status(400).json({ error: 'toAddress and amount required' })
    res.json(await h8token.mintTokens(toAddress, parseInt(amount), process.env.H8_ADMIN_MINT_KEY || ADMIN_KEY))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// â”€â”€â”€ Explorer API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/v1/explorer/stats', (req, res) => {
  try {
    const relayDbPath = process.env.USERDATA_PATH
      ? path.join(process.env.USERDATA_PATH, 'relay.db')
      : path.join(__dirname, '..', 'relay.db')
    const relayDb = new (require('better-sqlite3'))(relayDbPath, { readonly: true })

    const totalEvents   = relayDb.prepare('SELECT COUNT(*) as c FROM events').get().c
    const totalProfiles = relayDb.prepare('SELECT COUNT(DISTINCT pubkey) as c FROM events WHERE kind=0').get().c
    const totalPosts    = relayDb.prepare('SELECT COUNT(*) as c FROM events WHERE kind=1').get().c
    const totalFiles    = relayDb.prepare('SELECT COUNT(*) as c FROM events WHERE kind=1063').get().c
    const totalPhotosN  = relayDb.prepare('SELECT COUNT(*) as c FROM events WHERE kind=20').get().c
    const recentEvents  = relayDb.prepare('SELECT id, pubkey, kind, created_at FROM events ORDER BY created_at DESC LIMIT 10').all()
    relayDb.close()

    const tokenStats = h8token.getLedgerStats()

    const photoStats = (() => {
      try {
        const pdb = new (require('better-sqlite3'))(
          path.join(process.env.M4TR1X_DATA_DIR || require('os').homedir() + '/.m4tr1x', 'm4tr1x.db'),
          { readonly: true }
        )
        const total     = pdb.prepare('SELECT COUNT(*) as c FROM photos').get().c
        const nft_listed = pdb.prepare('SELECT COUNT(*) as c FROM photos WHERE nft_price > 0').get().c
        pdb.close()
        return { total, nft_listed }
      } catch { return { total: 0, nft_listed: 0 } }
    })()

    const videoStats = (() => {
      try { return { total: db.getVideos({ limit: 9999 }).length } }
      catch { return { total: 0 } }
    })()

    res.json({
      node: {
        version: require('../package.json').version,
        uptime_seconds: Math.floor(process.uptime()),
        onion: process.env.PRIVATE_NODE_URL || null,
      },
      relay: {
        total_events: totalEvents,
        profiles: totalProfiles,
        posts: totalPosts,
        files: totalFiles,
        photos: totalPhotosN,
        recent: recentEvents.map(e => ({
          id: e.id.slice(0, 16) + 'â€¦',
          pubkey: e.pubkey.slice(0, 16) + 'â€¦',
          kind: e.kind,
          ts: e.created_at,
        })),
      },
      content: {
        photos: photoStats.total,
        nft_listed: photoStats.nft_listed,
        videos: videoStats.total,
      },
      token: tokenStats,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/explorer', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'explorer.html'))
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Routes: Nostr Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€

app.post('/api/v1/nostr/keys', (req, res) => {
  res.json(generateKeys())
})

app.post('/api/v1/nostr/load-keys', (req, res) => {
  const { privkey, password } = req.body
  if (!privkey || !password) return res.status(400).json({ error: 'privkey e password richieste' })
  try {
    const result = loadKeys(privkey, password)
    res.json({ pubkey: result.pubkey })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/v1/nostr/unlock', verifyApiKey, (req, res) => {
  const { password } = req.body
  if (!password) return res.status(400).json({ error: 'Password richiesta' })
  try {
    const result = unlockNostrKeys(password)
    res.json({ status: 'unlocked', pubkey: result.pubkey })
  } catch (err) { res.status(401).json({ error: err.message }) }
})

app.post('/api/v1/nostr/lock', verifyApiKey, (req, res) => {
  lockNostrKeys()
  res.json({ status: 'locked' })
})

app.get('/api/v1/nostr/relays', async (req, res) => {
  const connected = await connectToRelays()
  res.json({ connected, all: DEFAULT_RELAYS })
})

app.get('/api/v1/nostr/feed', async (req, res) => {
  try {
    const { tags, limit } = req.query
    const events = await fetchFeed({
      tags:  tags ? tags.split(',') : undefined,
      limit: parseInt(limit || '50'),
    })
    res.json(events)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/v1/nostr/post', async (req, res) => {
  try {
    const { content, tags } = req.body
    const privkey = getUnlockedNostrPrivkey()
    if (!privkey) return res.status(401).json({ error: 'Nostr keys not unlocked. Call /api/v1/nostr/unlock first.' })
    const event = await publishNote(content, privkey, tags || [])
    res.json(event)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/v1/nostr/profile', async (req, res) => {
  try {
    const privkey = getUnlockedNostrPrivkey()
    if (!privkey) return res.status(401).json({ error: 'Nostr keys not unlocked. Call /api/v1/nostr/unlock first.' })
    const pubkey = getCurrentPubkey()
    const event = await publishProfile(req.body, privkey)
    if (process.env.HEAD_NODE_URL && req.body.name) {
      const hb = require('./heartbeat')
      const id = require('./h8identity').getUnlockedIdentity()
      hb.registerUser({ address: id ? id.address : pubkey, name: req.body.name, pubkey })
    }
    res.json(event)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/v1/nostr/dm', async (req, res) => {
  try {
    const { recipientPubkey, message } = req.body
    const privkey = getUnlockedNostrPrivkey()
    if (!privkey) return res.status(401).json({ error: 'Nostr keys not unlocked. Call /api/v1/nostr/unlock first.' })
    const event = await sendEncryptedDM(recipientPubkey, message, privkey)
    res.json(event)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/v1/nostr/dm/:pubkey', async (req, res) => {
  try {
    const privkey = getUnlockedNostrPrivkey()
    if (!privkey) return res.status(401).json({ error: 'Nostr keys not unlocked. Call /api/v1/nostr/unlock first.' })
    const messages = await fetchDMs(getCurrentPubkey(), req.params.pubkey, privkey)
    res.json(messages)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Routes: Mastodon Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€

app.get('/api/v1/mastodon/timeline', async (req, res) => {
  try {
    const { instance, limit } = req.query
    const posts = await mastodon.getPublicTimeline(instance, parseInt(limit || '40'))
    res.json(posts)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/v1/mastodon/hashtag/:tag', async (req, res) => {
  try {
    const { instances, limit } = req.query
    const inst = instances ? instances.split(',') : undefined
    const posts = await mastodon.searchHashtag(req.params.tag, inst, parseInt(limit || '20'))
    res.json(posts)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Unified search across posts, videos, tracks ───────────────────────────────
app.get('/api/v1/search', verifyApiKey, async (req, res) => {
  try {
    const q = (req.query.q || '').trim()
    if (!q) return res.json({ posts: [], videos: [], tracks: [] })
    const [postResults, videos, tracks] = await Promise.all([
      mastodon.search(q),
      Promise.resolve(db.searchVideos(q, 20)),
      Promise.resolve(db.searchTracks(q, 20)),
    ])
    res.json({ posts: postResults.statuses || [], videos, tracks })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/v1/mastodon/search', async (req, res) => {
  try {
    const { q, instance } = req.query
    const results = await mastodon.search(q, instance)
    res.json(results)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/v1/mastodon/post', async (req, res) => {
  try {
    const { instance, accessToken, content, options } = req.body
    const post = await mastodon.publishPost(instance, accessToken, content, options)
    res.json(post)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Routes: PeerTube Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€

app.get('/api/v1/peertube/videos', async (req, res) => {
  try {
    const { instance, limit, sort } = req.query
    const videos = await peertube.getVideos(instance, parseInt(limit || '30'), sort)
    res.json(videos)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/v1/peertube/search', async (req, res) => {
  try {
    const { q, instances, limit } = req.query
    const inst = instances ? instances.split(',') : undefined
    const videos = await peertube.searchVideos(q, inst, parseInt(limit || '20'))
    res.json(videos)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/v1/peertube/video/:instance/:uuid', async (req, res) => {
  try {
    const video = await peertube.getVideo(req.params.instance, req.params.uuid)
    res.json(video)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Upload video direttamente su PeerTube (usa credenziali salvate per l'h8address)
app.post('/api/v1/peertube/upload', uploadLimit, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'video richiesto' })
  try {
    const { h8address, name, description, tags, category } = req.body
    const tagList = tags ? tags.split(/[\s,]+/).filter(Boolean) : []
    const result = await peertube.uploadVideo(null, null, req.file.path, {
      h8address,
      name:         name || req.file.originalname || 'M4TR1X Video',
      description:  description || '',
      tags:         tagList,
      category:     category || 'reels',
      originalname: req.file.originalname || '',
    })
    announceContent({ id: result.uuid, type: 'video', title: name || 'M4TR1X Video', category: category || 'reels', uploader: h8address }).catch(() => {})
    res.status(201).json({ ok: true, ...result })
  } catch (err) {
    console.error('[VIDEO] Upload error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/v1/peertube/instances', async (req, res) => {
  try {
    const instances = await peertube.discoverInstances()
    res.json(instances)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Routes: Funkwhale (Musica) Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€

app.get('/api/v1/music/tracks', async (req, res) => {
  try {
    const { instance, limit } = req.query
    const tracks = await funkwhale.getRecentTracks(instance, parseInt(limit || '30'))
    res.json(tracks)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/v1/music/search', async (req, res) => {
  try {
    const { q, instances, limit } = req.query
    const inst = instances ? instances.split(',') : undefined
    const tracks = await funkwhale.searchTracks(q, inst, parseInt(limit || '20'))
    res.json(tracks)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/v1/music/albums', async (req, res) => {
  try {
    const { instance, limit } = req.query
    const albums = await funkwhale.getRecentAlbums(instance, parseInt(limit || '20'))
    res.json(albums)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/v1/music/channels', async (req, res) => {
  try {
    const { instance, limit } = req.query
    const channels = await funkwhale.getChannels(instance, parseInt(limit || '20'))
    res.json(channels)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/v1/music/instances', async (req, res) => {
  try {
    const instances = await funkwhale.discoverInstances()
    res.json(instances)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Routes: Crowdsourced Training Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€

// Vota un video (REALE o AI)
app.post('/api/v1/train/vote', async (req, res) => {
  try {
    const { videoHash, label, confidence } = req.body
    if (!videoHash || !label) {
      return res.status(400).json({ error: 'videoHash e label richiesti' })
    }
    const voterPubkey = req.headers['x-nostr-pubkey']
    if (!voterPubkey) {
      return res.status(401).json({ error: 'Header X-Nostr-Pubkey richiesto per votare' })
    }

    const result = await submitVote(videoHash, voterPubkey, label, confidence || 1.0)

    // Publish to Nostr in background (non-blocking)
    publishVoteToNostr(videoHash, label, confidence || 1.0).catch(err =>
      console.warn('[CROWDTRAIN] Nostr publish failed:', err.message)
    )

    res.json({
      success:   true,
      label,
      consensus: result.consensus,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Statistiche su un video specifico (quanti voti, consenso attuale)
app.get('/api/v1/train/stats/:videoHash', (req, res) => {
  try {
    res.json(getVideoStats(req.params.videoHash))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Statistiche globali del sistema di training
app.get('/api/v1/train/stats', (req, res) => {
  try {
    res.json(getGlobalStats())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Classifica contribuenti (per reputazione)
app.get('/api/v1/train/leaderboard', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '20')
    res.json(getLeaderboard(limit))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Lista etichette confermate (per chi gestisce il training Python)
app.get('/api/v1/train/labels', verifyApiKey, (req, res) => {
  try {
    const onlyNew = req.query.only_new === 'true'
    const limit   = parseInt(req.query.limit || '1000')
    res.json(getConfirmedLabels(limit, onlyNew))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Sync votes from Nostr relays (imports votes from other users)
app.post('/api/v1/train/sync', async (req, res) => {
  try {
    const imported = await syncVotesFromNostr()
    res.json({ imported, message: `${imported} nuovi voti importati dai relay Nostr` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Registra nuova versione del modello (chiamata dallo script Python dopo il training)
app.post('/api/v1/train/model', verifyApiKey, (req, res) => {
  try {
    const { version, url, hash_model, accuracy, samples } = req.body
    if (!version || !url || !hash_model) {
      return res.status(400).json({ error: 'version, url e hash_model richiesti' })
    }
    registerModelVersion({ version, url, hashModel: hash_model, accuracy, samples })
    res.json({ registered: true, version })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Check if an updated model is available
app.get('/api/v1/train/model/latest', async (req, res) => {
  try {
    const latest = getLatestModelVersion()
    res.json(latest || { version: null, message: 'No model published yet' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Forza controllo e download aggiornamento modello
app.post('/api/v1/train/model/update', verifyApiKey, async (req, res) => {
  try {
    const result = await checkAndUpdateModel()
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Routes: Professional Badge System Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€

// Middleware: solo localhost per endpoint admin
function localhostOnly(req, res, next) {
  const ip = req.socket.remoteAddress || ''
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next()
  return res.status(403).json({ error: 'Admin access restricted to localhost' })
}

// Middleware: verifica x-admin-key header (timing-safe per prevenire timing attack)
function verifyAdminKey(req, res, next) {
  const key = req.headers['x-admin-key']
  if (!key) return res.status(401).json({ error: 'Invalid or missing admin key' })
  try {
    const a = Buffer.from(key.padEnd(ADMIN_KEY.length))
    const b = Buffer.from(ADMIN_KEY.padEnd(key.length))
    const valid = key.length === ADMIN_KEY.length &&
      crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))
    if (!valid) return res.status(401).json({ error: 'Invalid or missing admin key' })
  } catch {
    return res.status(401).json({ error: 'Invalid or missing admin key' })
  }
  next()
}

// POST /api/v1/badge/request Ã¢Â€Â” utente invia richiesta con documento
app.post('/api/v1/badge/request', badgeUpload.single('document'), async (req, res) => {
  try {
    const { pubkey, category } = req.body
    if (!pubkey || !category) {
      if (req.file) fs.unlinkSync(req.file.path)
      return res.status(400).json({ error: 'pubkey e category sono richiesti' })
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Documento obbligatorio (PDF, JPG o PNG)' })
    }
    // Controlla se esiste giÃƒÂ  una richiesta pending o approvata
    const existing = getUserRequest(pubkey)
    if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
      fs.unlinkSync(req.file.path)
      return res.status(409).json({
        error: 'Hai giÃƒÂ  una richiesta in corso o un badge approvato',
        status: existing.status,
      })
    }
    // Sanitizza: prendi solo la basename e poi solo l'estensione Ã¢Â€Â” nessun path traversal
    const safeName = path.basename(req.file.originalname || '')
    const ext      = path.extname(safeName).toLowerCase()
    const allowedExts = new Set(['.pdf', '.jpg', '.jpeg', '.png'])
    if (!allowedExts.has(ext)) {
      fs.unlinkSync(req.file.path)
      return res.status(400).json({ error: 'Estensione non consentita' })
    }
    const filename = req.file.filename + ext
    // Rinomina il file con estensione corretta
    fs.renameSync(req.file.path, path.join(BADGE_DOCS_DIR, filename))
    const id = requestBadge(pubkey, category, filename)
    res.status(201).json({ success: true, id, status: 'pending' })
  } catch (err) {
    console.error('[BADGES] Errore richiesta:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/v1/badge/my/:pubkey Ã¢Â€Â” stato richiesta dell'utente stesso (must be before /:pubkey)
app.get('/api/v1/badge/my/:pubkey', (req, res) => {
  try {
    const request = getUserRequest(req.params.pubkey)
    if (!request) return res.json({ request: null })
    res.json({ request })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/v1/badge/:pubkey Ã¢Â€Â” badge approvato pubblico di un utente
app.get('/api/v1/badge/:pubkey', (req, res) => {
  try {
    const badge = getApprovedBadge(req.params.pubkey)
    if (!badge) return res.json({ badge: null })
    res.json({ badge })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/v1/admin/badges Ã¢Â€Â” lista tutte le richieste (admin only)
app.get('/api/v1/admin/badges', localhostOnly, verifyAdminKey, (req, res) => {
  try {
    const { status } = req.query
    const requests = getAllRequests(status || null)
    res.json(requests)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/v1/admin/badge/:id/approve Ã¢Â€Â” approva richiesta (admin only)
app.post('/api/v1/admin/badge/:id/approve', localhostOnly, verifyAdminKey, (req, res) => {
  try {
    const { category } = req.body
    if (!category) return res.status(400).json({ error: 'category richiesta' })
    approveRequest(req.params.id, category)
    res.json({ success: true, status: 'approved' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/v1/admin/badge/:id/reject Ã¢Â€Â” rifiuta richiesta (admin only)
app.post('/api/v1/admin/badge/:id/reject', localhostOnly, verifyAdminKey, (req, res) => {
  try {
    const { notes } = req.body
    rejectRequest(req.params.id, notes || '')
    res.json({ success: true, status: 'rejected' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Routes: Universal Post Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
const universal = require('./universal_post')
universal.initUniversalDb()

// Lista protocolli connessi al profilo H8
app.get('/api/v1/profile/protocols', (req, res) => {
  const { h8address } = req.query
  if (!h8address) return res.status(400).json({ error: 'h8address richiesto' })
  res.json(universal.getConnectedProtocols(h8address))
})

// Collega un account esterno (Mastodon, PeerTube, Funkwhale)
app.post('/api/v1/profile/protocols/connect', (req, res) => {
  const { h8address, protocol, instance, accessToken, username } = req.body
  if (!h8address || !protocol) return res.status(400).json({ error: 'h8address e protocol richiesti' })
  const VALID = new Set(['mastodon', 'peertube', 'funkwhale'])
  if (!VALID.has(protocol)) return res.status(400).json({ error: 'protocol non valido' })
  if (!instance) return res.status(400).json({ error: 'instance richiesta' })
  universal.connectProtocol(h8address, protocol, instance, accessToken, username || null)
  res.json({ ok: true })
})

// Scollega un account esterno
app.delete('/api/v1/profile/protocols/:protocol', (req, res) => {
  const { h8address } = req.query
  if (!h8address) return res.status(400).json({ error: 'h8address richiesto' })
  universal.disconnectProtocol(h8address, req.params.protocol)
  res.json({ ok: true })
})

// Sync profilo M4TR1X Ã¢Â†Â’ tutti i protocolli connessi
app.post('/api/v1/profile/sync', async (req, res) => {
  const { h8address, name, bio, picture } = req.body
  if (!h8address) return res.status(400).json({ error: 'h8address richiesto' })
  try {
    const results = await universal.syncAllProfiles(h8address, { name, bio, picture })
    res.json({ ok: true, results })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Sync profilo su un singolo protocollo
app.post('/api/v1/profile/sync/:protocol', async (req, res) => {
  const { h8address, name, bio, picture } = req.body
  if (!h8address) return res.status(400).json({ error: 'h8address richiesto' })
  try {
    const result = await universal.syncProfileToProtocol(h8address, { name, bio, picture }, req.params.protocol)
    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Post universale Ã¢Â€Â” pubblica su tutti i protocolli connessi
app.post('/api/v1/profile/post', async (req, res) => {
  const { h8address, text, title, tags } = req.body
  if (!h8address) return res.status(400).json({ error: 'h8address richiesto' })
  if (!text || !text.trim()) return res.status(400).json({ error: 'text richiesto' })
  try {
    const results = await universal.universalPost(h8address, {
      text:  text.trim(),
      title: title?.trim() || null,
      tags:  Array.isArray(tags) ? tags : [],
    })
    res.json({ ok: true, results })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Serve nostr-tools bundle da node_modules (evita dipendenza CDN esterna) Ã¢Â”Â€Ã¢Â”Â€
// Cerca il bundle in ordine: build CommonJS Ã¢Â†Â’ bundle UMD Ã¢Â†Â’ fallback 404
// â”€â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/v1/config', (req, res) => {
  const port     = process.env.PORT || 8080
  // Always the LAN/localhost URL â€” not the public domain
  const { networkInterfaces } = require('os')
  const _lan = Object.values(networkInterfaces()).flat().find(n => n.family === 'IPv4' && !n.internal)
  const localUrl = _lan ? `http://${_lan.address}:${port}` : `http://localhost:${port}`
  const privUrl  = getPrivateNodeUrl() || localUrl

  // Resolve onion: prefer Tor hostname file, fall back to PRIVATE_NODE_URL hostname
  let onion = getOnionAddress()
  if (!onion && process.env.PRIVATE_NODE_URL) {
    try {
      const u = new URL(process.env.PRIVATE_NODE_URL)
      if (u.hostname.endsWith('.onion')) onion = u.hostname
    } catch {}
  }

  const publicUrl = process.env.PUBLIC_NODE_URL || null

  const relays = ['ws://localhost:4848']
  if (onion) relays.push(`ws://${onion}:4848`)
  if (publicUrl) {
    const wsPublic = publicUrl.replace(/^https?:\/\//, 'wss://') + '/relay'
    if (!relays.includes(wsPublic)) relays.push(wsPublic)
  }

  res.json({
    privateNodeUrl: privUrl,
    publicNodeUrl:  publicUrl,
    headNodeUrl:    process.env.HEAD_NODE_URL || null,
    nodeOnion:      onion   || null,
    nodeUrl:        localUrl,
    nodeName:       process.env.NODE_NAME || 'alpha',
    relays,
    blossom:        (publicUrl || localUrl) + '/blossom',
  })
})

// â”€â”€â”€ Node Manager API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/v1/node/config', (req, res) => {
  res.json({ config: getNodeConfig() })
})

app.post('/api/v1/node/declare', async (req, res) => {
  try {
    const { capabilities, wsPort } = req.body
    const cfg = await declareNode(capabilities, wsPort)
    res.json({ ok: true, config: cfg })
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})

app.post('/api/v1/node/resign', (req, res) => {
  resignNode()
  res.json({ ok: true })
})

app.get('/api/v1/node/peers', (req, res) => {
  const { capability } = req.query
  res.json({ nodes: discoverNodes(capability) })
})

// â”€â”€â”€ Live Streaming API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/v1/live/streams', (req, res) => {
  const { category } = req.query
  res.json({ streams: listStreams(category) })
})

app.post('/api/v1/live/start', async (req, res) => {
  try {
    const { title, category } = req.body
    const keys = loadSavedKeys()
    if (!keys) return res.status(401).json({ ok: false, error: 'Not logged in' })
    const stream = await startStream({ title, category, pubkey: keys.pubkey })
    res.json({ ok: true, stream })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/v1/live/stop', async (req, res) => {
  try {
    const { streamId } = req.body
    await stopStream(streamId)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/libs/nostr.bundle.js', (req, res) => {
  const candidates = [
    path.join(__dirname, 'node_modules', 'nostr-tools', 'lib', 'nostr.bundle.js'),
    path.join(__dirname, 'node_modules', 'nostr-tools', 'lib', 'nostr.bundle.cjs'),
    path.join(__dirname, 'node_modules', 'nostr-tools', 'dist', 'nostr.bundle.js'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return res.sendFile(p, { headers: { 'Content-Type': 'application/javascript' } })
    }
  }
  res.status(404).send('// nostr-tools bundle not found. Run: npm install')
})

// â”€â”€â”€ Frontend compat aliases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/v1/timelines/tag/:tag', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '20')
    const posts = await mastodon.searchHashtag(req.params.tag, undefined, limit)
    res.json(posts)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/v1/videos', async (req, res) => {
  try {
    const { instance, limit, sort } = req.query
    const videos = await peertube.getVideos(instance, parseInt(limit || '30'), sort)
    res.json(videos)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/v1/tracks', async (req, res) => {
  try {
    const { instance, limit } = req.query
    const tracks = await funkwhale.getRecentTracks(instance, parseInt(limit || '30'))
    res.json(tracks)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// â”€â”€â”€ Content location â€” find which node has a given content ID â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get('/api/v1/node/onion', (req, res) => {
  const onion = getOnionAddress()
  res.json({ onion: onion || null, url: onion ? `http://${onion}` : null })
})

app.get('/api/v1/content/locate/:id', (req, res) => {
  const local = db.getVideoById(req.params.id) || db.getTrackById(req.params.id)
  if (local) return res.json({ found: true, nodeUrl: getLocalUrl(), local: true })
  const remote = locateContent(req.params.id)
  if (remote) return res.json({ found: true, nodeUrl: remote.nodeUrl, nodeName: remote.nodeName, local: false })
  res.json({ found: false })
})

// Redirect to the correct node if content is not local
app.get('/api/v1/content/stream/:id', async (req, res) => {
  const id = req.params.id
  if (db.getVideoById(id)) return res.redirect(`/api/v1/video/stream/${id}`)
  if (db.getTrackById(id)) return res.redirect(`/api/v1/music/stream/${id}`)
  const remote = locateContent(id)
  if (remote) return res.redirect(`${remote.nodeUrl}/api/v1/content/stream/${id}`)
  res.status(404).json({ error: 'Content not found on any node' })
})

// â”€â”€â”€ Local media streaming â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')

app.get('/api/v1/video/stream/:id', (req, res) => {
  const v = db.getVideoById(req.params.id)
  if (!v) return res.status(404).json({ error: 'not found' })
  db.incrementViews(req.params.id)
  const file = path.join(UPLOADS_DIR, v.filename)
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'file not found' })
  const stat = fs.statSync(file)
  const range = req.headers.range
  if (range) {
    const [start, end] = range.replace(/bytes=/, '').split('-').map(Number)
    const chunkEnd = end || Math.min(start + 1048576, stat.size - 1)
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${chunkEnd}/${stat.size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunkEnd - start + 1,
      'Content-Type':   'video/mp4',
    })
    fs.createReadStream(file, { start, end: chunkEnd }).pipe(res)
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' })
    fs.createReadStream(file).pipe(res)
  }
})

app.get('/api/v1/video/watch/:id', async (req, res) => {
  try { res.json(await peertube.getVideo(null, req.params.id)) }
  catch (e) { res.status(404).json({ error: e.message }) }
})

app.get('/api/v1/video/embed/:id', (req, res) => {
  res.redirect(`/api/v1/video/stream/${req.params.id}`)
})

app.get('/api/v1/music/stream/:id', (req, res) => {
  const t = db.getTrackById(req.params.id)
  if (!t) return res.status(404).json({ error: 'not found' })
  const file = path.join(UPLOADS_DIR, t.filename)
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'file not found' })
  const stat = fs.statSync(file)
  res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'audio/mpeg' })
  fs.createReadStream(file).pipe(res)
})

app.get('/api/v1/media/:filename', (req, res) => {
  const file = path.join(UPLOADS_DIR, path.basename(req.params.filename))
  if (!fs.existsSync(file)) return res.status(404).end()
  res.sendFile(file)
})

app.post('/api/v1/music/upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio richiesto' })
  try {
    const { h8address, title, artist, album } = req.body
    const result = await funkwhale.uploadTrack(req.file.path, {
      h8address, title, artist, album,
      originalname: req.file.originalname,
    })
    announceContent({ id: result.id, type: 'audio', title: title || 'M4TR1X Track', category: 'music', uploader: h8address }).catch(() => {})
    res.status(201).json({ ok: true, ...result })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// â”€â”€â”€ Routes: Photo Posts (NIP-68 kind:20) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Upload + strip EXIF + store Blossom + publish Nostr kind:20
app.post('/api/v1/photo/publish', photoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'immagine richiesta' })
  const srcPath = req.file.path
  try {
    const { caption, alt, tags, uploader, music_id, nft_price } = req.body
    const tagList = tags ? tags.split(/[\s,]+/).filter(Boolean) : []
    if (process.env.HEAD_NODE_URL) require('./heartbeat').trackUpload()
    const result = await photo.publishPhoto(srcPath, {
      caption:   caption   || '',
      alt:       alt       || '',
      tags:      tagList,
      uploader:  uploader  || req.body.h8address || '',
      music_id:  music_id  || '',
      nft_price: parseInt(nft_price || '0'),
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[PHOTO] Error:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath)
  }
})

// Feed foto
app.get('/api/v1/photo/list', (req, res) => {
  const limit  = parseInt(req.query.limit  || '50')
  const offset = parseInt(req.query.offset || '0')
  res.json(photo.listPhotos(limit, offset))
})

// Singola foto
app.get('/api/v1/photo/:id', (req, res) => {
  const p = photo.getPhoto(req.params.id)
  if (!p) return res.status(404).json({ error: 'not found' })
  res.json(p)
})

// â”€â”€â”€ Routes: Stories (NIP-68 kind:20 + NIP-40 expiry 24h) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Upload + publish story (expires in 24h)
app.post('/api/v1/story/publish', photoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'immagine richiesta' })
  const srcPath = req.file.path
  try {
    const { caption, alt, tags, uploader, music_id } = req.body
    const tagList = tags ? tags.split(/[\s,]+/).filter(Boolean) : []
    const result = await story.publishStory(srcPath, {
      caption:  caption  || '',
      alt:      alt      || '',
      tags:     tagList,
      uploader: uploader || '',
      music_id: music_id || '',
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[STORY] Error:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath)
  }
})

// Active stories (not expired)
app.get('/api/v1/story/list', (req, res) => {
  const limit = parseInt(req.query.limit || '50')
  res.json(story.listStories(limit))
})

// Single story
app.get('/api/v1/story/:id', (req, res) => {
  const s = story.getStory(req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  res.json(s)
})

// â”€â”€â”€ Routes: P2P â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET /api/v1/p2p/config â€” tracker URL + loader config for clients
app.get('/api/v1/p2p/config', (req, res) => {
  const base = process.env.PRIVATE_NODE_URL || `http://${req.headers.host || 'localhost:' + (process.env.PORT || 8080)}`
  res.json(p2p.getP2PConfig(base))
})

// GET /api/v1/p2p/stats â€” active swarms + peer count
app.get('/api/v1/p2p/stats', (req, res) => {
  res.json(p2p.getStats())
})

// â”€â”€â”€ Routes: H8 Token ledger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// h8coin.js removed â€” all token operations now go through h8token.js (ML-DSA65, SHA3-256 chain)

const wallet = require('./h8wallet')

// GET  /api/v1/coin/supply    â€” tokenomics overview (backed by h8token)
app.get('/api/v1/coin/supply', (req, res) => {
  res.json(h8token.getLedgerStats())
})

// GET  /api/v1/coin/balance/:address
app.get('/api/v1/coin/balance/:address', (req, res) => {
  const bal = h8token.getBalance(req.params.address)
  res.json({ address: req.params.address, balance: bal, symbol: 'H8' })
})

// GET  /api/v1/coin/history/:address
app.get('/api/v1/coin/history/:address', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 200)
  res.json(h8token.getHistory(req.params.address, limit))
})

// GET  /api/v1/coin/ledger    â€” full public ledger (paginated)
app.get('/api/v1/coin/ledger', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '100'), 500)
  const offset = parseInt(req.query.offset || '0')
  res.json(h8token.getPublicLedger(limit, offset))
})

// POST /api/v1/coin/send   â€” transfer H8 using the unlocked node identity
app.post('/api/v1/coin/send', async (req, res) => {
  try {
    const { to_address, amount_h8c, memo } = req.body
    if (!to_address || !amount_h8c) return res.status(400).json({ error: 'to_address and amount_h8c required' })
    const block = await h8token.transfer(to_address, Math.floor(parseFloat(amount_h8c)), memo || '')
    res.json({ ok: true, ...block })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// GET  /api/v1/coin/verify   â€” verify chain integrity (hash + ML-DSA65 signatures)
app.get('/api/v1/coin/verify', async (req, res) => {
  try {
    res.json(await h8token.verifyChain())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// â”€â”€â”€ Routes: H8 Wallet (v3 â€” ML-DSA65 identity) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// POST /api/v1/wallet/generate
// body: { password }
// Creates a new ML-DSA65 node identity. No mnemonic â€” back up the identity file.
app.post('/api/v1/wallet/generate', async (req, res) => {
  try {
    const { password, name = '' } = req.body
    if (!password) return res.status(400).json({ error: 'password required' })
    const w = await wallet.generateWallet(password)
    if (process.env.HEAD_NODE_URL) {
      const hb = require('./heartbeat')
      hb.registerUser({ address: w.address, name, pubkey: w.pubkey })
    }
    res.json({ address: w.address, pubkey: w.pubkey, path: w.path, name, warning: w.warning })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/v1/wallet/unlock
// body: { password }
app.post('/api/v1/wallet/unlock', async (req, res) => {
  try {
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'password required' })
    await wallet.unlockWallet(password)
    res.json({ ok: true, address: wallet.getAddress() })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// POST /api/v1/wallet/lock
app.post('/api/v1/wallet/lock', (req, res) => {
  wallet.lockWallet()
  res.json({ ok: true })
})

// GET  /api/v1/wallet/list
app.get('/api/v1/wallet/list', (req, res) => {
  res.json(wallet.listWallets())
})

// GET  /api/v1/wallet/balance/:address
app.get('/api/v1/wallet/balance/:address', (req, res) => {
  res.json(wallet.walletBalance(req.params.address))
})

// GET  /api/v1/wallet/history/:address
app.get('/api/v1/wallet/history/:address', (req, res) => {
  const limit = parseInt(req.query.limit || '50')
  res.json(wallet.walletHistory(req.params.address, limit))
})

// POST /api/v1/wallet/send
// body: { to_address, amount_h8c, memo?, password? }
// password needed only if the identity is currently locked.
app.post('/api/v1/wallet/send', async (req, res) => {
  try {
    const { to_address, amount_h8c, memo, password, address } = req.body
    if (!to_address || !amount_h8c) return res.status(400).json({ error: 'to_address and amount_h8c required' })
    const block = await wallet.walletSend({ address, password, toAddress: to_address, amountH8C: amount_h8c, memo: memo || '' })
    res.json({ ok: true, ...block })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// POST /api/v1/wallet/change-password
app.post('/api/v1/wallet/change-password', async (req, res) => {
  try {
    const { old_password, new_password } = req.body
    if (!old_password || !new_password) return res.status(400).json({ error: 'old_password and new_password required' })
    await wallet.changePassword(null, old_password, new_password)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// POST /api/v1/admin/wallet/reset-lockout/:address  (localhost-only)
app.post('/api/v1/admin/wallet/reset-lockout/:address', localhostOnly, verifyAdminKey, (req, res) => {
  res.json(wallet.resetLockout())
})

// â”€â”€â”€ Routes: H8 Shop (buy H8C) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const shop = require('./h8shop')

// GET  /api/v1/shop/info  â€” prices + enabled payment methods (public)
app.get('/api/v1/shop/info', (req, res) => {
  const cfg = shop.loadConfig()
  const methods = Object.entries(cfg.methods)
    .filter(([, m]) => m.enabled)
    .map(([key, m]) => ({ key, label: m.label, notes: m.notes }))
  res.json({
    price_eur:    cfg.price_eur,
    price_usd:    cfg.price_usd,
    min_order_h8: cfg.min_order_h8 || cfg.min_order_h8c,
    max_order_h8: cfg.max_order_h8 || cfg.max_order_h8c,
    methods,
    symbol: 'H8',
  })
})

// POST /api/v1/shop/buy  â€” create purchase order
// body: { method, amount_h8c, buyer_address }
// For method=stripe also returns client_secret + publishable_key
app.post('/api/v1/shop/buy', async (req, res) => {
  try {
    const { method, amount_h8c, buyer_address } = req.body
    if (!method || !amount_h8c || !buyer_address) return res.status(400).json({ error: 'method, amount_h8c, buyer_address required' })
    const order = await Promise.resolve(shop.createOrder({ buyerAddress: buyer_address, method, amountH8C: amount_h8c }))
    res.status(201).json(order)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// GET  /api/v1/shop/order/:id  â€” check order status
app.get('/api/v1/shop/order/:id', (req, res) => {
  const order = shop.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'order not found' })
  res.json(order)
})

// GET  /api/v1/shop/orders/:address  â€” all orders for a buyer address
app.get('/api/v1/shop/orders/:address', (req, res) => {
  const limit = parseInt(req.query.limit || '20')
  res.json(shop.listOrders({ buyerAddress: req.params.address, limit }))
})

// â”€â”€â”€ Admin: Shop management (localhost only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET  /api/v1/admin/shop/orders  â€” all orders with optional ?status= filter
app.get('/api/v1/admin/shop/orders', localhostOnly, verifyAdminKey, (req, res) => {
  const { status, limit = 100, offset = 0 } = req.query
  res.json(shop.listOrders({ status, limit: parseInt(limit), offset: parseInt(offset) }))
})

// GET  /api/v1/admin/shop/stats
app.get('/api/v1/admin/shop/stats', localhostOnly, verifyAdminKey, (req, res) => {
  res.json(shop.shopStats())
})

// POST /api/v1/admin/shop/fulfill/:id  â€” mark paid, issue coins
app.post('/api/v1/admin/shop/fulfill/:id', localhostOnly, verifyAdminKey, async (req, res) => {
  try {
    const result = await shop.fulfillOrder(req.params.id, req.body.notes || '')
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// POST /api/v1/admin/shop/cancel/:id
app.post('/api/v1/admin/shop/cancel/:id', localhostOnly, verifyAdminKey, (req, res) => {
  try {
    res.json(shop.cancelOrder(req.params.id, req.body.reason || ''))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// PUT  /api/v1/admin/shop/config  â€” update prices + payment method details
app.put('/api/v1/admin/shop/config', localhostOnly, verifyAdminKey, (req, res) => {
  try {
    const current = shop.loadConfig()
    const updated = { ...current, ...req.body }
    shop.saveConfig(updated)
    res.json({ ok: true, config: updated })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// â”€â”€â”€ Routes: Native Video Hosting (NIP-71) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Upload + transcode + publish (Nostr NIP-71 kind:34235)
app.post('/api/v1/video/publish', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'video richiesto' })
  const tempPath = req.file.path
  try {
    const { title, description, tags, uploader } = req.body
    if (!title) { fs.unlinkSync(tempPath); return res.status(400).json({ error: 'title richiesto' }) }
    const tagList = tags ? tags.split(/[\s,]+/).filter(Boolean) : []
    const result = await videoHost.publishVideo(tempPath, { title, description: description || '', tags: tagList, uploader: uploader || '' })
    if (process.env.HEAD_NODE_URL) require('./heartbeat').trackUpload()
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[VIDEO] Publish error:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
})

// List hosted videos
app.get('/api/v1/video/list', (req, res) => {
  const limit  = parseInt(req.query.limit  || '50')
  const offset = parseInt(req.query.offset || '0')
  res.json(videoHost.listVideos(limit, offset))
})

// Global federated feed â€” merges content from all registered nodes
app.get('/api/v1/feed/global', (req, res) => {
  const type  = req.query.type  || 'film'
  const limit = Math.min(parseInt(req.query.limit || '50'), 200)
  res.json(federation.getGlobalFeed(type, limit))
})

// Delete video (admin only)
app.delete('/api/v1/video/:id', localhostOnly, verifyAdminKey, (req, res) => {
  try {
    videoHost.deleteVideo(req.params.id)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Video player page
app.get('/v/:id', (req, res) => {
  const video = videoHost.getVideo(req.params.id)
  if (!video) return res.status(404).send('Video non trovato')
  videoHost.incrementViews(req.params.id)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(videoHost.buildPlayerPage(video))
})

// HLS manifest
app.get('/v/:id/index.m3u8', (req, res) => {
  const dir = videoHost.videoDir(req.params.id)
  const f   = path.join(dir, 'index.m3u8')
  if (!fs.existsSync(f)) return res.status(404).send('not found')
  res.setHeader('Content-Type', 'application/x-mpegURL')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-cache')
  res.sendFile(f)
})

// HLS segments + thumbnail
app.get('/v/:id/:file', (req, res) => {
  const { id, file } = req.params
  if (!file.match(/^(seg_\d+\.ts|thumb\.jpg)$/)) return res.status(400).send('invalid')
  const f = path.join(videoHost.videoDir(id), file)
  if (!fs.existsSync(f)) return res.status(404).send('not found')
  const mime = file.endsWith('.ts') ? 'video/mp2t' : 'image/jpeg'
  res.setHeader('Content-Type', mime)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.sendFile(f)
})

// â”€â”€â”€ Mobile PWA + App Distribution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const mobilePath = path.join(__dirname, 'mobile')
app.use('/m', express.static(mobilePath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.apk'))  res.setHeader('Content-Type', 'application/vnd.android.package-archive')
    if (filePath.endsWith('.ipa'))  res.setHeader('Content-Type', 'application/octet-stream')
    if (filePath.endsWith('.plist')) res.setHeader('Content-Type', 'text/xml')
  }
}))
app.get('/install', (req, res) => res.sendFile(path.join(mobilePath, 'install.html')))
// Update iOS manifest IPA url when IPA is uploaded (admin only)
app.post('/admin/update-ios-manifest', localhostOnly, verifyAdminKey, (req, res) => {
  const { ipa_url } = req.body
  if (!ipa_url) return res.status(400).json({ error: 'ipa_url required' })
  const plistPath = path.join(mobilePath, 'manifest.plist')
  let plist = fs.readFileSync(plistPath, 'utf8')
  plist = plist.replace(/IPA_URL_PLACEHOLDER|<string>https?:\/\/[^<]+\.ipa<\/string>/,
    `<string>${ipa_url}</string>`)
  fs.writeFileSync(plistPath, plist)
  console.log(`[IOS] manifest.plist aggiornato â†’ ${ipa_url}`)
  res.json({ ok: true, ipa_url })
})
app.get('/m', (req, res) => res.sendFile(path.join(mobilePath, 'index.html')))

// Serve il frontend (HTML statico)
// In production, Tauri passes the bundled frontend path via env var.
// In dev, fall back to the local ../frontend directory.
const frontendPath = process.env.M4TR1X_FRONTEND_PATH || path.join(__dirname, '..', 'frontend')
if (fs.existsSync(frontendPath)) {
  app.use('/app', express.static(frontendPath))

  // Route esplicita per la pagina sicurezza (6 lingue per utenti a rischio)
  app.get('/app/safety', (req, res) => {
    res.sendFile(path.join(frontendPath, 'safety.html'))
  })

  // Admin panel Ã¢Â€Â” solo localhost
  app.get('/admin', localhostOnly, (req, res) => {
    res.sendFile(path.join(frontendPath, 'admin.html'))
  })

  // Fallback SPA Ã¢Â€Â” rimanda a index.html per qualsiasi route non trovata
  app.get('/app/*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'))
  })
}

// Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€ Avvio / stop server Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€Ã¢Â”Â€
let server

function startServer(port = 8080) {
  initDb()
  initCrowdtrainDb()
  initBadgeDb()
  // Check for model updates at startup (background, non-blocking)
  setTimeout(() => checkAndUpdateModel().catch(() => {}), 5000)
  setTimeout(() => startNodeDiscovery(), 2000)
  setTimeout(() => startContentDiscovery(), 3000)
  if (process.env.HEAD_NODE_URL) {
    setTimeout(() => {
      const { getCurrentPubkey } = require('./nostr')
      federation.startFederation({
        headUrl:    process.env.HEAD_NODE_URL,
        selfUrl:    getLocalUrl(),
        selfOnion:  getOnionAddress() ? `http://${getOnionAddress()}` : null,
        selfPubkey: getCurrentPubkey(),
      })
    }, 5000)
  }
  if (process.env.HEAD_NODE === 'true') {
    setTimeout(() => require('./db_backup').startBackup(), 3000)
  }
  // Heartbeat al nodo testa (se configurato)
  if (process.env.HEAD_NODE_URL) {
    const hb = require('./heartbeat')
    const { getCurrentPubkey } = require('./nostr')
    setTimeout(() => {
      const pubkey = getCurrentPubkey()
      if (pubkey) {
        const onion   = getOnionAddress()
        const wallets = wallet.listWallets()
        const firstW  = wallets && wallets.length > 0 ? wallets[0] : null
        const h8info  = identityExists() ? getPublicInfo() : null

        // Look up real Nostr display name from local relay
        const _nostrName = (() => {
          try {
            const relayDbPath = process.env.USERDATA_PATH
              ? path.join(process.env.USERDATA_PATH, 'relay.db')
              : path.join(DATA_DIR, 'relay.db')
            const rdb  = new (require('better-sqlite3'))(relayDbPath, { readonly: true })
            const row  = rdb.prepare('SELECT content FROM events WHERE kind=0 AND pubkey=? ORDER BY created_at DESC LIMIT 1').get(pubkey)
            rdb.close()
            if (row) { const p = JSON.parse(row.content); return p.name || p.display_name || null }
          } catch {}
          return null
        })()

        hb.startHeartbeat({
          headUrl:       process.env.HEAD_NODE_URL,
          pubkey,
          nodeName:      process.env.NODE_NAME || 'alpha',
          nodeData: {
            onion:        onion ? `http://${onion}` : null,
            nodeUrl:      getLocalUrl(),
            capabilities: ['media', 'relay', 'nostr'],
            version:      require('../package.json').version,
          },
          walletAddress: firstW ? firstW.address : (h8info ? h8info.address : null),
          walletName:    _nostrName || (firstW ? (firstW.name || 'default') : (h8info ? h8info.name || null : null)),
        })

        // Register all users who have a Nostr profile in the local relay
        setTimeout(() => {
          try {
            const relayDbPath = process.env.USERDATA_PATH
              ? path.join(process.env.USERDATA_PATH, 'relay.db')
              : path.join(DATA_DIR, 'relay.db')
            const rdb = new (require('better-sqlite3'))(relayDbPath, { readonly: true })
            const profiles = rdb.prepare('SELECT pubkey, content FROM events WHERE kind=0').all()
            rdb.close()
            const id = require('./h8identity').getUnlockedIdentity()
            profiles.forEach(row => {
              try {
                const p = JSON.parse(row.content)
                const name = p.name || p.display_name
                if (!name) return
                hb.registerUser({ address: id?.address || row.pubkey, name, pubkey: row.pubkey })
              } catch {}
            })
          } catch {}
        }, 20000)  // after heartbeat registration
      }
    }, 8000)
  }
  return new Promise((resolve, reject) => {
    server = app.listen(port, '::', () => {
      const { networkInterfaces } = require('os')
      const nets = networkInterfaces()
      const lan = Object.values(nets).flat().find(n => n.family === 'IPv4' && !n.internal)
      console.log(`[SERVER] M4TR1X Alpha Node in ascolto su http://localhost:${port}`)
      if (lan) console.log(`[SERVER] Raggiungibile dalla rete: http://${lan.address}:${port}`)
      const onion = getOnionAddress()
      if (onion) console.log(`[SERVER] Indirizzo Tor: http://${onion}`)
      p2p.attachToServer(server)
      resolve(server)
    })
    server.on('error', reject)
  })
}

function stopServer() {
  if (server) {
    server.close(() => console.log('[SERVER] Server fermato.'))
  }
}

// â”€â”€â”€ Admin: graceful server-only reload (no Electron restart needed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/v1/admin/reload', (req, res) => {
  res.json({ ok: true, message: 'Reloading server...' })
  setTimeout(() => {
    const port = server?.address()?.port || 8080
    server.close(() => {
      // Purge cached modules so changes are picked up
      Object.keys(require.cache).forEach(k => {
        if (k.includes('/server/') && !k.includes('node_modules')) delete require.cache[k]
      })
      startServer(port).then(() => console.log('[SERVER] Reloaded.'))
    })
  }, 200)
})

module.exports = { startServer, stopServer, app }

// Auto-start when run directly (e.g. node index.js)
if (require.main === module) {
  const port = parseInt(process.env.PORT || '8080')
  startServer(port).catch(err => {
    console.error('[SERVER] Errore avvio:', err)
    process.exit(1)
  })
}

