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
const { initDb, saveResult, loadResult, listResults } = require('./db')
const {
  generateIdentity, unlockIdentity, lockIdentity,
  identityExists, getPublicInfo,
} = require('./h8identity')
const {
  generateKeys, loadSavedKeys, loadKeys, getCurrentPubkey,
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

const { declareNode, resignNode, discoverNodes, startNodeDiscovery, getNodeConfig, pickNode, getPrivateNodeUrl, VALID_CAPS } = require('./node_manager')
const { startStream, stopStream, sendSignal, listStreams, registerRemoteStream, removeRemoteStream } = require('./livestream')

// âââ Embedded Nostr Relay âââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
// âââ Config âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const MAX_FILE_MB      = parseInt(process.env.MAX_FILE_SIZE_MB || '100')
const API_KEY          = process.env.M4TR1X_API_KEY || ''
const ALLOWED_ORIGINS  = (process.env.ALLOWED_ORIGINS || 'http://localhost:8080').split(',')
const ALLOWED_EXT      = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv'])

const DATA_DIR      = process.env.M4TR1X_DATA_DIR || process.cwd()
const UPLOAD_DIR    = path.join(DATA_DIR, 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const ADMIN_KEY = (() => {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY
  const generated = crypto.randomBytes(32).toString('hex')
  console.warn('[SECURITY] â ï¸  ADMIN_KEY non impostata! Chiave temporanea (solo questa sessione):')
  console.warn(`[SECURITY]     ${generated}`)
  console.warn('[SECURITY]     Imposta ADMIN_KEY=<valore> nelle variabili d\'ambiente per una chiave fissa.')
  return generated
})()
const BADGE_DOCS_DIR = path.join(DATA_DIR, 'badge_docs')
if (!fs.existsSync(BADGE_DOCS_DIR)) fs.mkdirSync(BADGE_DOCS_DIR, { recursive: true })

// âââ App ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const app = express()

// CORS â accetta localhost (Electron) + origini configurate
app.use(cors({
  origin: [...ALLOWED_ORIGINS, 'http://localhost:8080', 'http://127.0.0.1:8080'],
  credentials: false,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['X-Nostr-Pubkey', 'X-API-Key', 'X-Admin-Key', 'Content-Type'],
}))

app.use(express.json())

// âââ Multer (upload file) âââââââââââââââââââââââââââââââââââââââââââââââââââââ
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
})

// Badge document upload (PDF, JPG, PNG â max 10MB)
const badgeUpload = multer({
  dest: BADGE_DOCS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png']
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, allowed.includes(ext))
  },
})

// âââ Rate limiting ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// âââ API Key middleware âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function verifyApiKey(req, res, next) {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' })
  }
  next()
}

// âââ Routes âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// âââ Routes: H8 Wallet ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// Crea nuova identitÃ  H8
app.post('/api/v1/h8/wallet/create', verifyApiKey, async (req, res) => {
  try {
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'Password richiesta' })
    if (identityExists()) return res.status(409).json({ error: 'IdentitÃ  H8 giÃ  esistente' })
    const result = await generateIdentity(password)
    res.status(201).json({ address: result.address, message: 'H8 identity creata. Salva la tua password.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Sblocca wallet (password â secret key in memoria per la sessione)
app.post('/api/v1/h8/wallet/unlock', verifyApiKey, async (req, res) => {
  try {
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'Password richiesta' })
    const result = await unlockIdentity(password)
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

// Saldo + storico
// Trasferimento diretto
// Tip a creator (split 50/20/30)
// Boost visibilitÃ  contenuto
// Boost score di un contenuto
// Batch boost scores â { id1: score1, id2: score2, ... }  â DEVE stare prima di /:contentId
// Verifica integritÃ  catena
// âââ Routes: Shop âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Lista prodotti
// Dettaglio prodotto
// Crea prodotto (prezzo in H8)
// Disattiva prodotto
// Acquisto con H8 token (pagamento istantaneo)
// Dettaglio ordine
// âââ Routes: Nostr ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
    const keys = loadSavedKeys()
    if (!keys) return res.status(401).json({ error: 'Nostr keys not configured' })
    const event = await publishNote(content, keys.privkey, tags || [])
    res.json(event)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/v1/nostr/profile', async (req, res) => {
  try {
    const profKeys = loadSavedKeys()
    if (!profKeys) return res.status(401).json({ error: 'Nostr keys not configured' })
    const event = await publishProfile(req.body, profKeys.privkey)
    res.json(event)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/v1/nostr/dm', async (req, res) => {
  try {
    const { recipientPubkey, message } = req.body
    const dmKeys = loadSavedKeys()
    if (!dmKeys) return res.status(401).json({ error: 'Nostr keys not configured' })
    const event = await sendEncryptedDM(recipientPubkey, message, dmKeys.privkey)
    res.json(event)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/v1/nostr/dm/:pubkey', async (req, res) => {
  try {
    const fetchKeys = loadSavedKeys()
    if (!fetchKeys) return res.status(401).json({ error: 'Nostr keys not configured' })
    const messages = await fetchDMs(fetchKeys.pubkey, req.params.pubkey, fetchKeys.privkey)
    res.json(messages)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// âââ Routes: Mastodon âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// âââ Routes: PeerTube âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
app.post('/api/v1/peertube/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'video richiesto' })
  const tempPath = req.file.path
  try {
    const { h8address, name, description, tags, privacy, language } = req.body
    if (!h8address) { fs.unlinkSync(tempPath); return res.status(400).json({ error: 'h8address richiesto' }) }

    const creds = universal.getProtocolCreds(h8address, 'peertube')
    if (!creds?.token) { fs.unlinkSync(tempPath); return res.status(403).json({ error: 'PeerTube non connesso per questo profilo' }) }

    const tagList = tags ? tags.split(/[\s,]+/).filter(Boolean) : []
    const result = await peertube.uploadVideo(creds.instance, creds.token, tempPath, {
      name:         name || req.file.originalname || 'M4TR1X Video',
      description:  description || '',
      tags:         tagList,
      privacy:      parseInt(privacy || '1'),
      language:     language || null,
      originalname: req.file.originalname || '',
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[PEERTUBE] Upload error:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
})

app.get('/api/v1/peertube/instances', async (req, res) => {
  try {
    const instances = await peertube.discoverInstances()
    res.json(instances)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// âââ Routes: Funkwhale (Musica) âââââââââââââââââââââââââââââââââââââââââââââââ

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

// âââ Routes: Crowdsourced Training âââââââââââââââââââââââââââââââââââââââââââ

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

// âââ Routes: Professional Badge System âââââââââââââââââââââââââââââââââââââââ

// Middleware: solo localhost per endpoint admin
function localhostOnly(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || ''
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

// POST /api/v1/badge/request â utente invia richiesta con documento
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
    // Controlla se esiste giÃ  una richiesta pending o approvata
    const existing = getUserRequest(pubkey)
    if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
      fs.unlinkSync(req.file.path)
      return res.status(409).json({
        error: 'Hai giÃ  una richiesta in corso o un badge approvato',
        status: existing.status,
      })
    }
    // Sanitizza: prendi solo la basename e poi solo l'estensione â nessun path traversal
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

// GET /api/v1/badge/my/:pubkey â stato richiesta dell'utente stesso (must be before /:pubkey)
app.get('/api/v1/badge/my/:pubkey', (req, res) => {
  try {
    const request = getUserRequest(req.params.pubkey)
    if (!request) return res.json({ request: null })
    res.json({ request })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/v1/badge/:pubkey â badge approvato pubblico di un utente
app.get('/api/v1/badge/:pubkey', (req, res) => {
  try {
    const badge = getApprovedBadge(req.params.pubkey)
    if (!badge) return res.json({ badge: null })
    res.json({ badge })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/v1/admin/badges â lista tutte le richieste (admin only)
app.get('/api/v1/admin/badges', localhostOnly, verifyAdminKey, (req, res) => {
  try {
    const { status } = req.query
    const requests = getAllRequests(status || null)
    res.json(requests)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/v1/admin/badge/:id/approve â approva richiesta (admin only)
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

// POST /api/v1/admin/badge/:id/reject â rifiuta richiesta (admin only)
app.post('/api/v1/admin/badge/:id/reject', localhostOnly, verifyAdminKey, (req, res) => {
  try {
    const { notes } = req.body
    rejectRequest(req.params.id, notes || '')
    res.json({ success: true, status: 'rejected' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// âââ Routes: Universal Post âââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// Sync profilo M4TR1X â tutti i protocolli connessi
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

// Post universale â pubblica su tutti i protocolli connessi
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

// âââ Serve nostr-tools bundle da node_modules (evita dipendenza CDN esterna) ââ
// Cerca il bundle in ordine: build CommonJS â bundle UMD â fallback 404
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

  // Admin panel â solo localhost
  app.get('/admin', localhostOnly, (req, res) => {
    res.sendFile(path.join(frontendPath, 'admin.html'))
  })

  // Fallback SPA â rimanda a index.html per qualsiasi route non trovata
  app.get('/app/*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'))
  })
}

// âââ Avvio / stop server ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
let server

function startServer(port = 8080) {
  initDb()
  initCrowdtrainDb()
  initBadgeDb()
  // Check for model updates at startup (background, non-blocking)
  setTimeout(() => checkAndUpdateModel().catch(() => {}), 5000)
  setTimeout(() => startNodeDiscovery(), 2000)
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
