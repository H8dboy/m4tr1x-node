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
const { v4: uuidv4 } = require('uuid')
require('dotenv').config()

const { analyzeVideo }           = require('./ai_detector')
const { cleanMetadata, isExifToolAvailable } = require('./core')
const { initDb, saveResult, loadResult, listResults } = require('./db')
const {
  createWallet, restoreWallet, openWallet, walletExists,
  syncWallet, getBalance, getPrimaryAddress,
} = require('./monero')
const {
  initShopDb, createListing, getListings, getListing,
  deactivateListing, initiateOrder, verifyOrderPayment,
  getOrder, getSellerOrders, getBuyerOrders,
} = require('./shop')
const {
  generateKeys, loadKeys, getCurrentPubkey,
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

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_FILE_MB      = parseInt(process.env.MAX_FILE_SIZE_MB || '100')
const API_KEY          = process.env.M4TR1X_API_KEY || ''
const ALLOWED_ORIGINS  = (process.env.ALLOWED_ORIGINS || 'http://localhost:8080').split(',')
const ALLOWED_EXT      = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv'])

const DATA_DIR      = process.env.M4TR1X_DATA_DIR || process.cwd()
const UPLOAD_DIR    = path.join(DATA_DIR, 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const ADMIN_KEY      = process.env.ADMIN_KEY || 'admin123'
const BADGE_DOCS_DIR = path.join(DATA_DIR, 'badge_docs')
if (!fs.existsSync(BADGE_DOCS_DIR)) fs.mkdirSync(BADGE_DOCS_DIR, { recursive: true })

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express()

// CORS — accetta localhost (Electron) + origini configurate
app.use(cors({
  origin: [...ALLOWED_ORIGINS, 'http://localhost:8080', 'http://127.0.0.1:8080'],
  credentials: false,
  methods: ['GET', 'POST'],
  allowedHeaders: ['X-Nostr-Pubkey', 'X-API-Key', 'X-Admin-Key', 'Content-Type'],
}))

app.use(express.json())

// ─── Multer (upload file) ─────────────────────────────────────────────────────
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
})

// Badge document upload (PDF, JPG, PNG — max 10MB)
const badgeUpload = multer({
  dest: BADGE_DOCS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png']
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, allowed.includes(ext))
  },
})

// ─── Rate limiting ────────────────────────────────────────────────────────────
const analyzeLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppe richieste. Riprova tra un minuto.' },
})

// ─── API Key middleware ───────────────────────────────────────────────────────
function verifyApiKey(req, res, next) {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' })
  }
  next()
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    version: '2.0.0',
    runtime: 'electron+node',
    exiftool_available: isExifToolAvailable(),
  })
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

// ─── Routes: Wallet XMR ───────────────────────────────────────────────────────

// Stato wallet (esiste? saldo?)
app.get('/api/v1/wallet/status', verifyApiKey, async (req, res) => {
  try {
    const exists = walletExists()
    if (!exists) return res.json({ exists: false })
    const balance = await getBalance()
    const address = await getPrimaryAddress()
    res.json({ exists: true, address, balance })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Crea nuovo wallet
app.post('/api/v1/wallet/create', verifyApiKey, async (req, res) => {
  try {
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'Password richiesta' })
    const result = await createWallet(password)
    // IMPORTANTE: il seed viene mostrato solo qui, una volta sola
    res.json({
      address: result.address,
      seed:    result.seed,
      warning: 'SALVA IL SEED ORA. Non verrà mostrato di nuovo.',
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Ripristina wallet da seed
app.post('/api/v1/wallet/restore', verifyApiKey, async (req, res) => {
  try {
    const { seed, password, restoreHeight } = req.body
    if (!seed || !password) return res.status(400).json({ error: 'seed e password richiesti' })
    const result = await restoreWallet(seed, password, restoreHeight || 0)
    res.json({ address: result.address })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Apri wallet esistente (sblocco con password)
app.post('/api/v1/wallet/open', verifyApiKey, async (req, res) => {
  try {
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'Password required' })
    const ok = await openWallet(password)
    if (!ok) return res.status(404).json({ error: 'Wallet not found' })
    res.json({ status: 'opened' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Sync wallet (aggiorna saldo)
app.post('/api/v1/wallet/sync', verifyApiKey, async (req, res) => {
  try {
    await syncWallet()
    const balance = await getBalance()
    res.json({ status: 'synced', balance })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Routes: Shop ─────────────────────────────────────────────────────────────

// Lista prodotti
app.get('/api/v1/shop/listings', async (req, res) => {
  try {
    const { category, limit } = req.query
    res.json(getListings({ category, limit: parseInt(limit || '50') }))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Dettaglio prodotto
app.get('/api/v1/shop/listings/:id', async (req, res) => {
  const item = getListing(req.params.id)
  if (!item) return res.status(404).json({ error: 'Product not found' })
  res.json(item)
})

// Crea prodotto
app.post('/api/v1/shop/listings', verifyApiKey, async (req, res) => {
  try {
    const { sellerPubkey, title, description, priceXMR, category, imageEmoji } = req.body
    if (!sellerPubkey || !title || !priceXMR)
      return res.status(400).json({ error: 'sellerPubkey, title e priceXMR richiesti' })
    const id = createListing({ sellerPubkey, title, description, priceXMR, category, imageEmoji })
    res.status(201).json({ id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Disattiva prodotto
app.delete('/api/v1/shop/listings/:id', verifyApiKey, async (req, res) => {
  const { sellerPubkey } = req.body
  deactivateListing(req.params.id, sellerPubkey)
  res.json({ status: 'deactivated' })
})

// Start purchase (generates XMR address for payment)
app.post('/api/v1/shop/orders', async (req, res) => {
  try {
    const { listingId, buyerPubkey } = req.body
    if (!listingId) return res.status(400).json({ error: 'listingId richiesto' })
    const order = await initiateOrder(listingId, buyerPubkey)
    res.status(201).json(order)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Verifica pagamento ordine
app.get('/api/v1/shop/orders/:id/verify', async (req, res) => {
  try {
    const result = await verifyOrderPayment(req.params.id)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Dettaglio ordine
app.get('/api/v1/shop/orders/:id', async (req, res) => {
  const order = getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'Order not found' })
  res.json(order)
})

// ─── Routes: Nostr ────────────────────────────────────────────────────────────

app.post('/api/v1/nostr/keys', (req, res) => {
  res.json(generateKeys())
})

app.post('/api/v1/nostr/load-keys', (req, res) => {
  const { privkey } = req.body
  if (!privkey) return res.status(400).json({ error: 'privkey richiesta' })
  loadKeys(privkey)
  res.json({ pubkey: getCurrentPubkey() })
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
    const event = await publishNote(content, tags || [])
    res.json(event)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/v1/nostr/profile', async (req, res) => {
  try {
    const event = await publishProfile(req.body)
    res.json(event)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/v1/nostr/dm', async (req, res) => {
  try {
    const { recipientPubkey, message } = req.body
    const event = await sendEncryptedDM(recipientPubkey, message)
    res.json(event)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/v1/nostr/dm/:pubkey', async (req, res) => {
  try {
    const messages = await fetchDMs(req.params.pubkey)
    res.json(messages)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── Routes: Mastodon ─────────────────────────────────────────────────────────

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

// ─── Routes: PeerTube ─────────────────────────────────────────────────────────

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

app.get('/api/v1/peertube/instances', async (req, res) => {
  try {
    const instances = await peertube.discoverInstances()
    res.json(instances)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── Routes: Funkwhale (Musica) ───────────────────────────────────────────────

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

// ─── Routes: Crowdsourced Training ───────────────────────────────────────────

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
    publishVoteToNostr(videoHash, label, confidence || 1.0).catch(() => {})

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

// ─── Routes: Professional Badge System ───────────────────────────────────────

// Middleware: solo localhost per endpoint admin
function localhostOnly(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || ''
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next()
  return res.status(403).json({ error: 'Admin access restricted to localhost' })
}

// Middleware: verifica x-admin-key header
function verifyAdminKey(req, res, next) {
  const key = req.headers['x-admin-key']
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Invalid or missing admin key' })
  }
  next()
}

// POST /api/v1/badge/request — utente invia richiesta con documento
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
    // Controlla se esiste già una richiesta pending o approvata
    const existing = getUserRequest(pubkey)
    if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
      fs.unlinkSync(req.file.path)
      return res.status(409).json({
        error: 'Hai già una richiesta in corso o un badge approvato',
        status: existing.status,
      })
    }
    const filename = req.file.filename + path.extname(req.file.originalname).toLowerCase()
    // Rinomina il file con estensione corretta
    fs.renameSync(req.file.path, path.join(BADGE_DOCS_DIR, filename))
    const id = requestBadge(pubkey, category, filename)
    res.status(201).json({ success: true, id, status: 'pending' })
  } catch (err) {
    console.error('[BADGES] Errore richiesta:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/v1/badge/my/:pubkey — stato richiesta dell'utente stesso (must be before /:pubkey)
app.get('/api/v1/badge/my/:pubkey', (req, res) => {
  try {
    const request = getUserRequest(req.params.pubkey)
    if (!request) return res.json({ request: null })
    res.json({ request })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/v1/badge/:pubkey — badge approvato pubblico di un utente
app.get('/api/v1/badge/:pubkey', (req, res) => {
  try {
    const badge = getApprovedBadge(req.params.pubkey)
    if (!badge) return res.json({ badge: null })
    res.json({ badge })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/v1/admin/badges — lista tutte le richieste (admin only)
app.get('/api/v1/admin/badges', localhostOnly, verifyAdminKey, (req, res) => {
  try {
    const { status } = req.query
    const requests = getAllRequests(status || null)
    res.json(requests)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/v1/admin/badge/:id/approve — approva richiesta (admin only)
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

// POST /api/v1/admin/badge/:id/reject — rifiuta richiesta (admin only)
app.post('/api/v1/admin/badge/:id/reject', localhostOnly, verifyAdminKey, (req, res) => {
  try {
    const { notes } = req.body
    rejectRequest(req.params.id, notes || '')
    res.json({ success: true, status: 'rejected' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Serve nostr-tools bundle da node_modules (evita dipendenza CDN esterna) ──
// Cerca il bundle in ordine: build CommonJS → bundle UMD → fallback 404
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

  // Admin panel — solo localhost
  app.get('/admin', localhostOnly, (req, res) => {
    res.sendFile(path.join(frontendPath, 'admin.html'))
  })

  // Fallback SPA — rimanda a index.html per qualsiasi route non trovata
  app.get('/app/*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'))
  })
}

// ─── Avvio / stop server ──────────────────────────────────────────────────────
let server

function startServer(port = 8080) {
  initDb()
  initShopDb()
  initCrowdtrainDb()
  initBadgeDb()
  // Check for model updates at startup (background, non-blocking)
  setTimeout(() => checkAndUpdateModel().catch(() => {}), 5000)
  return new Promise((resolve, reject) => {
    server = app.listen(port, '127.0.0.1', () => {
      console.log(`[SERVER] M4TR1X API in ascolto su http://localhost:${port}`)
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

module.exports = { startServer, stopServer, app }

// Auto-start when run directly (e.g. node index.js)
if (require.main === module) {
  startServer().catch(err => {
    console.error('[SERVER] Errore avvio:', err)
    process.exit(1)
  })
}
