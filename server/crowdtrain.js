/**
 * M4TR1X - Crowdsourced AI Training
 *
 * Il modello impara dagli utenti — come Wikipedia, ma per distinguere
 * video reali da video AI-generated.
 *
 * Flusso:
 *  1. L'utente guarda un video e preme REALE o AI
 *  2. Il voto viene firmato con la sua chiave Nostr e pubblicato sui relay
 *  3. Quando un video raggiunge 10+ voti con ≥70% accordo → etichetta confermata
 *  4. Le etichette confermate alimentano lo script Python di training
 *  5. Il modello re-addestrato viene pubblicato su Nostr → l'app si aggiorna
 *  6. Quando la sua accuratezza supera il 90% → il sistema è autonomo
 *
 * Evento Nostr per i voti (kind 30078 — replaceable):
 *   d:          "m4tr1x-label-{video_hash}"
 *   hash:       SHA-256 del video
 *   label:      "REAL" | "AI_GENERATED"
 *   confidence: "1.0" (in futuro: slider utente)
 *   t:          "m4tr1x", "video-label"
 *
 * Evento Nostr per aggiornamenti modello (kind 30078):
 *   d:          "m4tr1x-model-latest"
 *   url:        URL di download del .onnx (IPFS / Blossom / direct)
 *   version:    "x.y.z"
 *   accuracy:   "0.92"
 *   samples:    numero di video usati per il training
 *   hash_model: SHA-256 del file .onnx (verifica integrità)
 *   t:          "m4tr1x", "model-update"
 */

const Database = require('better-sqlite3')
const path     = require('path')
const crypto   = require('crypto')
const { publishEvent, fetchFeed, getConnectedRelays, connectToRelays, getCurrentPubkey } = require('./nostr')

// ─── Database ─────────────────────────────────────────────────────────────────

let db

function getDbPath() {
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'crowdtrain.db')
  } catch {
    return path.join(process.cwd(), 'crowdtrain.db')
  }
}

function initCrowdtrainDb() {
  db = new Database(getDbPath())

  db.exec(`
    -- Voti degli utenti sui video
    CREATE TABLE IF NOT EXISTS votes (
      id           TEXT PRIMARY KEY,        -- {video_hash}:{voter_pubkey}
      video_hash   TEXT NOT NULL,           -- SHA-256 del video
      voter_pubkey TEXT NOT NULL,           -- pubkey Nostr del votante
      label        TEXT NOT NULL,           -- 'REAL' | 'AI_GENERATED'
      confidence   REAL DEFAULT 1.0,        -- 0.0 → 1.0
      reputation   REAL DEFAULT 1.0,        -- peso del voto al momento del salvataggio
      nostr_event_id TEXT,                  -- ID evento Nostr (per deduplicazione)
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_votes_hash   ON votes(video_hash);
    CREATE INDEX IF NOT EXISTS idx_votes_voter  ON votes(voter_pubkey);

    -- Reputazione degli utenti (aggiornata dinamicamente)
    CREATE TABLE IF NOT EXISTS reputation (
      pubkey       TEXT PRIMARY KEY,
      score        REAL DEFAULT 1.0,        -- 0.1 → 5.0
      total_votes  INTEGER DEFAULT 0,
      correct_votes INTEGER DEFAULT 0,      -- voti concordanti col consenso finale
      updated_at   TEXT NOT NULL
    );

    -- Video con etichetta confermata (consenso raggiunto)
    CREATE TABLE IF NOT EXISTS confirmed_labels (
      video_hash   TEXT PRIMARY KEY,
      label        TEXT NOT NULL,           -- 'REAL' | 'AI_GENERATED'
      confidence   REAL NOT NULL,           -- % accordo ponderato
      total_votes  INTEGER NOT NULL,
      confirmed_at TEXT NOT NULL,
      used_in_training INTEGER DEFAULT 0    -- 1 se già usato per addestrare il modello
    );

    -- Versioni del modello distribuite via Nostr
    CREATE TABLE IF NOT EXISTS model_versions (
      version      TEXT PRIMARY KEY,
      url          TEXT NOT NULL,
      hash_model   TEXT NOT NULL,
      accuracy     REAL,
      samples      INTEGER,
      nostr_event_id TEXT,
      downloaded   INTEGER DEFAULT 0,
      created_at   TEXT NOT NULL
    );
  `)

  console.log('[CROWDTRAIN] Database inizializzato.')
}

// ─── Parametri consenso ───────────────────────────────────────────────────────
const MIN_VOTES        = parseInt(process.env.CROWDTRAIN_MIN_VOTES || '3')  // override via env for scaling
const MIN_AGREEMENT    = 0.70  // % accordo minimo (ponderato per reputazione)
const MAX_REPUTATION   = 5.0
const MIN_REPUTATION   = 0.1
const REPUTATION_BOOST = 0.1   // guadagno per voto corretto
const REPUTATION_LOSS  = 0.05  // perdita per voto sbagliato

// ─── Voti ─────────────────────────────────────────────────────────────────────

/**
 * Registra un voto di un utente su un video.
 * Sostituisce il voto precedente dello stesso utente sullo stesso video.
 *
 * @param {string} videoHash   - SHA-256 del video
 * @param {string} voterPubkey - pubkey Nostr del votante
 * @param {string} label       - 'REAL' | 'AI_GENERATED'
 * @param {number} confidence  - 0.0 → 1.0 (default 1.0)
 * @param {string} nostrEventId - ID evento Nostr (opzionale)
 * @returns {{ label, consensus }}
 */
function submitVote(videoHash, voterPubkey, label, confidence = 1.0, nostrEventId = null) {
  if (!['REAL', 'AI_GENERATED'].includes(label)) {
    throw new Error('Invalid label. Use REAL or AI_GENERATED.')
  }

  // Reputazione corrente del votante
  const repRow = db.prepare('SELECT score FROM reputation WHERE pubkey = ?').get(voterPubkey)
  const reputation = repRow ? repRow.score : 1.0

  // Upsert voto (uno per utente per video)
  const voteId = `${videoHash}:${voterPubkey}`
  db.prepare(`
    INSERT OR REPLACE INTO votes (id, video_hash, voter_pubkey, label, confidence, reputation, nostr_event_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(voteId, videoHash, voterPubkey, label, confidence, reputation, nostrEventId, new Date().toISOString())

  // Assicurati che l'utente abbia una riga reputazione
  db.prepare(`
    INSERT OR IGNORE INTO reputation (pubkey, score, total_votes, correct_votes, updated_at)
    VALUES (?, 1.0, 0, 0, ?)
  `).run(voterPubkey, new Date().toISOString())

  db.prepare(`
    UPDATE reputation SET total_votes = total_votes + 1, updated_at = ? WHERE pubkey = ?
  `).run(new Date().toISOString(), voterPubkey)

  console.log(`[CROWDTRAIN] Voto: ${voterPubkey.substring(0, 12)}... → ${label} (video: ${videoHash.substring(0, 12)}...)`)

  // Controlla se il consenso è stato raggiunto
  const consensus = computeConsensus(videoHash)
  return { label, consensus }
}

/**
 * Calcola il consenso ponderato per reputazione su un video.
 * Restituisce null se non ci sono abbastanza voti.
 */
function computeConsensus(videoHash) {
  const votes = db.prepare('SELECT label, confidence, reputation FROM votes WHERE video_hash = ?').all(videoHash)

  if (votes.length < MIN_VOTES) {
    return {
      reached:    false,
      total_votes: votes.length,
      needed:     MIN_VOTES - votes.length,
      real_pct:   null,
      ai_pct:     null,
    }
  }

  // Media ponderata per reputazione × confidenza
  let weightedReal = 0
  let weightedAi   = 0
  let totalWeight  = 0

  for (const v of votes) {
    const w = v.reputation * v.confidence
    totalWeight += w
    if (v.label === 'REAL')         weightedReal += w
    else if (v.label === 'AI_GENERATED') weightedAi += w
  }

  const realPct = totalWeight > 0 ? weightedReal / totalWeight : 0.5
  const aiPct   = totalWeight > 0 ? weightedAi   / totalWeight : 0.5

  const winningLabel = realPct >= aiPct ? 'REAL' : 'AI_GENERATED'
  const winningPct   = Math.max(realPct, aiPct)
  const reached      = winningPct >= MIN_AGREEMENT

  if (reached) {
    // Salva etichetta confermata (se non esiste già)
    const existing = db.prepare('SELECT video_hash FROM confirmed_labels WHERE video_hash = ?').get(videoHash)
    if (!existing) {
      db.prepare(`
        INSERT INTO confirmed_labels (video_hash, label, confidence, total_votes, confirmed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(videoHash, winningLabel, winningPct, votes.length, new Date().toISOString())

      console.log(`[CROWDTRAIN] ✅ Consenso raggiunto: ${videoHash.substring(0, 12)}... → ${winningLabel} (${(winningPct * 100).toFixed(1)}%)`)

      // Aggiorna reputazione dei votanti
      updateReputations(videoHash, winningLabel)
    }
  }

  return {
    reached,
    label:       reached ? winningLabel : null,
    agreement:   winningPct,
    real_pct:    realPct,
    ai_pct:      aiPct,
    total_votes: votes.length,
    needed:      reached ? 0 : MIN_VOTES - votes.length,
  }
}

/**
 * Aggiorna la reputazione di tutti i votanti dopo che il consenso è raggiunto.
 * Chi ha votato correttamente guadagna, chi ha sbagliato perde un po'.
 */
function updateReputations(videoHash, winningLabel) {
  const votes = db.prepare('SELECT voter_pubkey, label FROM votes WHERE video_hash = ?').all(videoHash)

  for (const v of votes) {
    const correct = v.label === winningLabel
    const rep = db.prepare('SELECT score FROM reputation WHERE pubkey = ?').get(v.voter_pubkey)
    if (!rep) continue

    let newScore = correct
      ? Math.min(MAX_REPUTATION, rep.score + REPUTATION_BOOST)
      : Math.max(MIN_REPUTATION, rep.score - REPUTATION_LOSS)

    db.prepare(`
      UPDATE reputation
      SET score = ?, correct_votes = correct_votes + ?, updated_at = ?
      WHERE pubkey = ?
    `).run(newScore, correct ? 1 : 0, new Date().toISOString(), v.voter_pubkey)
  }
}

// ─── Statistiche ──────────────────────────────────────────────────────────────

function getVideoStats(videoHash) {
  const votes    = db.prepare('SELECT label, confidence, reputation FROM votes WHERE video_hash = ?').all(videoHash)
  const confirmed = db.prepare('SELECT * FROM confirmed_labels WHERE video_hash = ?').get(videoHash)
  const consensus = computeConsensus(videoHash)

  return {
    video_hash: videoHash,
    total_votes: votes.length,
    confirmed,
    consensus,
    votes_breakdown: {
      real: votes.filter(v => v.label === 'REAL').length,
      ai:   votes.filter(v => v.label === 'AI_GENERATED').length,
    }
  }
}

function getGlobalStats() {
  const totalVotes      = db.prepare('SELECT COUNT(*) as n FROM votes').get().n
  const totalVideos     = db.prepare('SELECT COUNT(DISTINCT video_hash) as n FROM votes').get().n
  const confirmedLabels = db.prepare('SELECT COUNT(*) as n FROM confirmed_labels').get().n
  const readyForTraining = db.prepare('SELECT COUNT(*) as n FROM confirmed_labels WHERE used_in_training = 0').get().n
  const totalUsers      = db.prepare('SELECT COUNT(*) as n FROM reputation').get().n
  const modelVersions   = db.prepare('SELECT * FROM model_versions ORDER BY created_at DESC LIMIT 1').get()

  return {
    total_votes:        totalVotes,
    total_videos_labeled: totalVideos,
    confirmed_labels:   confirmedLabels,
    ready_for_training: readyForTraining,
    total_contributors: totalUsers,
    latest_model:       modelVersions || null,
    training_threshold: MIN_VOTES,
    agreement_threshold: MIN_AGREEMENT,
  }
}

function getLeaderboard(limit = 20) {
  return db.prepare(`
    SELECT pubkey,
           score,
           total_votes,
           correct_votes,
           CASE WHEN total_votes > 0
                THEN ROUND(CAST(correct_votes AS REAL) / total_votes * 100, 1)
                ELSE 0 END AS accuracy_pct
    FROM reputation
    WHERE total_votes >= 3
    ORDER BY score DESC, correct_votes DESC
    LIMIT ?
  `).all(limit)
}

function getConfirmedLabels(limit = 1000, onlyNew = false) {
  const query = onlyNew
    ? 'SELECT * FROM confirmed_labels WHERE used_in_training = 0 ORDER BY confirmed_at DESC LIMIT ?'
    : 'SELECT * FROM confirmed_labels ORDER BY confirmed_at DESC LIMIT ?'
  return db.prepare(query).all(limit)
}

function markLabelsUsedInTraining(videoHashes) {
  const stmt = db.prepare('UPDATE confirmed_labels SET used_in_training = 1 WHERE video_hash = ?')
  for (const hash of videoHashes) stmt.run(hash)
  console.log(`[CROWDTRAIN] ${videoHashes.length} etichette marcate come usate nel training.`)
}

// ─── Pubblicazione voto su Nostr ──────────────────────────────────────────────

/**
 * Pubblica il voto dell'utente come evento Nostr firmato.
 * Questo rende il voto pubblico, verificabile e decentralizzato.
 */
async function publishVoteToNostr(videoHash, label, confidence = 1.0) {
  try {
    const event = await publishEvent({
      kind: 30078,
      content: '',
      tags: [
        ['d',          `m4tr1x-label-${videoHash}`],
        ['hash',       videoHash],
        ['label',      label],
        ['confidence', String(confidence)],
        ['t',          'm4tr1x'],
        ['t',          'video-label'],
        ['t',          label.toLowerCase()],
      ],
    })
    console.log(`[CROWDTRAIN] Vote published to Nostr: ${event.id.substring(0, 12)}...`)
    return event
  } catch (err) {
    console.warn('[CROWDTRAIN] Failed to publish vote to Nostr (keys not loaded?):', err.message)
    return null
  }
}

/**
 * Raccoglie voti dai relay Nostr e li importa nel DB locale.
 * Utile per sincronizzare i voti di altri utenti della rete.
 */
async function syncVotesFromNostr() {
  try {
    if (!getConnectedRelays().length) await connectToRelays()

    const events = await fetchFeed({
      tags:  ['m4tr1x', 'video-label'],
      limit: 500,
    })

    let imported = 0
    for (const event of events) {
      const hashTag     = event.tags.find(t => t[0] === 'hash')
      const labelTag    = event.tags.find(t => t[0] === 'label')
      const confTag     = event.tags.find(t => t[0] === 'confidence')

      if (!hashTag || !labelTag) continue
      if (!['REAL', 'AI_GENERATED'].includes(labelTag[1])) continue

      // Ignora se già importato (usa ID evento come deduplicazione)
      const exists = db.prepare('SELECT id FROM votes WHERE nostr_event_id = ?').get(event.id)
      if (exists) continue

      submitVote(
        hashTag[1],
        event.pubkey,
        labelTag[1],
        confTag ? parseFloat(confTag[1]) : 1.0,
        event.id,
      )
      imported++
    }

    console.log(`[CROWDTRAIN] Imported ${imported} votes from Nostr relays.`)
    return imported
  } catch (err) {
    console.error('[CROWDTRAIN] Nostr sync error:', err.message)
    return 0
  }
}

// ─── Aggiornamento modello ─────────────────────────────────────────────────────

/**
 * Salva nel DB una nuova versione del modello annunciata via Nostr.
 */
function registerModelVersion({ version, url, hashModel, accuracy, samples, nostrEventId }) {
  db.prepare(`
    INSERT OR IGNORE INTO model_versions (version, url, hash_model, accuracy, samples, nostr_event_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(version, url, hashModel, accuracy || null, samples || null, nostrEventId || null, new Date().toISOString())
}

function getLatestModelVersion() {
  return db.prepare('SELECT * FROM model_versions ORDER BY created_at DESC LIMIT 1').get() || null
}

function markModelDownloaded(version) {
  db.prepare('UPDATE model_versions SET downloaded = 1 WHERE version = ?').run(version)
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = {
  initCrowdtrainDb,
  // Voti
  submitVote,
  computeConsensus,
  publishVoteToNostr,
  syncVotesFromNostr,
  // Statistiche
  getVideoStats,
  getGlobalStats,
  getLeaderboard,
  // Training
  getConfirmedLabels,
  markLabelsUsedInTraining,
  // Modello
  registerModelVersion,
  getLatestModelVersion,
  markModelDownloaded,
}
