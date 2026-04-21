/**
 * M4TR1X - Model Updater
 *
 * Controlla automaticamente se esiste una nuova versione del modello ONNX
 * pubblicata dalla community su Nostr, la scarica, ne verifica l'integrità
 * con SHA-256, e la sostituisce a quella attuale.
 *
 * Il training è gestito da script Python separati (cartella train/).
 * Questo modulo si occupa solo della distribuzione e dell'aggiornamento.
 *
 * Flusso:
 *  1. All'avvio del server, cerca eventi Nostr con tag "m4tr1x-model-update"
 *  2. Se trova una versione più recente di quella attuale, la scarica
 *  3. Verifica SHA-256 del file scaricato
 *  4. Sostituisce models/m4tr1x_detector.onnx
 *  5. Ricarica il modello ONNX in memoria
 */

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const https  = require('https')
const http   = require('http')

const { getLatestModelVersion, registerModelVersion, markModelDownloaded } = require('./crowdtrain')
const { loadModel } = require('./ai_detector')

// ─── Percorso modello locale ──────────────────────────────────────────────────

function getModelPath() {
  const prodPath = path.join(process.resourcesPath || '', 'models', 'm4tr1x_detector.onnx')
  const devPath  = path.join(__dirname, '..', 'models', 'm4tr1x_detector.onnx')
  return { prodPath, devPath, active: fs.existsSync(prodPath) ? prodPath : devPath }
}

function getCurrentModelVersion() {
  const versionFile = path.join(__dirname, '..', 'models', 'version.json')
  if (fs.existsSync(versionFile)) {
    try { return JSON.parse(fs.readFileSync(versionFile, 'utf8')) }
    catch (_) {}
  }
  return { version: '0.0.0', installed_at: null }
}

function saveModelVersion(version, accuracy, samples) {
  const versionFile = path.join(__dirname, '..', 'models', 'version.json')
  fs.writeFileSync(versionFile, JSON.stringify({
    version,
    accuracy:     accuracy || null,
    samples:      samples  || null,
    installed_at: new Date().toISOString(),
  }, null, 2))
}

// ─── Scarica file da URL ───────────────────────────────────────────────────────

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto   = url.startsWith('https') ? https : http
    const tmpPath = destPath + '.tmp'
    const file    = fs.createWriteStream(tmpPath)

    const request = proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close()
        fs.unlinkSync(tmpPath)
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        file.close()
        fs.unlinkSync(tmpPath)
        return reject(new Error(`HTTP ${res.statusCode} da ${url}`))
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0')
      let downloadedBytes = 0

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length
        if (totalBytes > 0) {
          const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1)
          process.stdout.write(`\r[MODEL] Download: ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB)`)
        }
      })

      res.pipe(file)
      file.on('finish', () => {
        file.close(() => {
          process.stdout.write('\n')
          fs.renameSync(tmpPath, destPath)
          resolve(destPath)
        })
      })
    })

    request.on('error', (err) => {
      file.close()
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
      reject(err)
    })

    request.setTimeout(120000, () => {
      request.destroy()
      reject(new Error('Timeout download modello (120s)'))
    })
  })
}

// ─── Verifica integrità SHA-256 ────────────────────────────────────────────────

function verifyFileHash(filePath, expectedHash) {
  const buffer = fs.readFileSync(filePath)
  const actual = crypto.createHash('sha256').update(buffer).digest('hex')
  return { ok: actual === expectedHash, actual, expected: expectedHash }
}

// ─── Check e aggiornamento ─────────────────────────────────────────────────────

/**
 * Controlla se c'è una versione più recente del modello e, se sì, la scarica.
 * Chiamato automaticamente all'avvio e tramite API.
 */
async function checkAndUpdateModel() {
  console.log('[MODEL] Controllo aggiornamenti modello...')

  // Prima cerca su Nostr (se connesso)
  await syncModelVersionFromNostr().catch(() => {})

  const latest  = getLatestModelVersion()
  const current = getCurrentModelVersion()

  if (!latest || !latest.url) {
    console.log('[MODEL] No model published by the community yet.')
    return { updated: false, reason: 'no_published_model', current: current.version }
  }

  // Confronta versioni (formato semver semplice)
  if (latest.version <= current.version && latest.downloaded) {
    console.log(`[MODEL] Model already up to date: v${current.version}`)
    return { updated: false, reason: 'already_current', current: current.version }
  }

  console.log(`[MODEL] New version available: v${latest.version} (current: v${current.version})`)
  console.log(`[MODEL] Download da: ${latest.url}`)

  const { active: modelPath } = getModelPath()
  const modelsDir = path.dirname(modelPath)
  if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true })

  // Backup del modello corrente
  if (fs.existsSync(modelPath)) {
    const backupPath = modelPath.replace('.onnx', `_backup_${current.version}.onnx`)
    fs.copyFileSync(modelPath, backupPath)
    console.log(`[MODEL] Backup saved: ${backupPath}`)
  }

  try {
    await downloadFile(latest.url, modelPath)
    console.log('[MODEL] Download complete. Verifying integrity...')

    // Verifica SHA-256
    const { ok, actual } = verifyFileHash(modelPath, latest.hash_model)
    if (!ok) {
      console.error(`[MODEL] ❌ Hash mismatch! Expected: ${latest.hash_model}, got: ${actual}`)
      // Restore backup
      const backupPath = modelPath.replace('.onnx', `_backup_${current.version}.onnx`)
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, modelPath)
        console.log('[MODEL] Backup restored.')
      }
      return { updated: false, reason: 'hash_mismatch', current: current.version }
    }

    console.log('[MODEL] ✅ Integrity verified. Reloading model into memory...')
    saveModelVersion(latest.version, latest.accuracy, latest.samples)
    markModelDownloaded(latest.version)

    // Ricarica il modello ONNX in memoria
    await loadModel()

    console.log(`[MODEL] 🎉 Model updated to v${latest.version} (accuracy: ${latest.accuracy ? (latest.accuracy * 100).toFixed(1) + '%' : 'N/A'})`)

    return {
      updated:   true,
      version:   latest.version,
      accuracy:  latest.accuracy,
      samples:   latest.samples,
    }
  } catch (err) {
    console.error('[MODEL] Errore durante l\'aggiornamento:', err.message)
    return { updated: false, reason: 'download_error', error: err.message, current: current.version }
  }
}

// ─── Ricerca versioni su Nostr ────────────────────────────────────────────────

// Pubkey Nostr autorizzate a pubblicare aggiornamenti modello.
// Imposta TRUSTED_MODEL_PUBKEYS=pubkey1,pubkey2 nelle env vars.
// Se non impostato, gli aggiornamenti automatici via Nostr sono disabilitati.
const TRUSTED_MODEL_PUBKEYS = (() => {
  const raw = process.env.TRUSTED_MODEL_PUBKEYS || ''
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
})()

/**
 * Cerca eventi di tipo "m4tr1x-model-update" sui relay Nostr
 * e li registra nel DB locale — solo da publisher fidati.
 */
async function syncModelVersionFromNostr() {
  if (TRUSTED_MODEL_PUBKEYS.size === 0) {
    console.warn('[MODEL] TRUSTED_MODEL_PUBKEYS non impostata — aggiornamenti Nostr disabilitati.')
    console.warn('[MODEL] Imposta TRUSTED_MODEL_PUBKEYS=<pubkey1>,<pubkey2> per abilitarli.')
    return
  }

  try {
    const { getConnectedRelays, connectToRelays, fetchFeed } = require('./nostr')
    if (!getConnectedRelays().length) await connectToRelays()

    const events = await fetchFeed({ tags: ['m4tr1x', 'model-update'], limit: 10 })

    let accepted = 0
    for (const event of events) {
      // Verifica che il publisher sia in lista fidata
      if (!TRUSTED_MODEL_PUBKEYS.has(event.pubkey)) {
        console.warn(`[MODEL] Evento ignorato — pubkey non fidata: ${event.pubkey?.substring(0, 16)}...`)
        continue
      }

      const urlTag     = event.tags.find(t => t[0] === 'url')
      const versionTag = event.tags.find(t => t[0] === 'version')
      const hashTag    = event.tags.find(t => t[0] === 'hash_model')
      const accTag     = event.tags.find(t => t[0] === 'accuracy')
      const sampTag    = event.tags.find(t => t[0] === 'samples')

      if (!urlTag || !versionTag || !hashTag) continue

      registerModelVersion({
        version:      versionTag[1],
        url:          urlTag[1],
        hashModel:    hashTag[1],
        accuracy:     accTag  ? parseFloat(accTag[1])  : null,
        samples:      sampTag ? parseInt(sampTag[1])   : null,
        nostrEventId: event.id,
      })
      accepted++
    }

    console.log(`[MODEL] ${events.length} eventi trovati, ${accepted} accettati (publisher fidati).`)
  } catch (err) {
    console.warn('[MODEL] Impossibile sincronizzare da Nostr:', err.message)
  }
}

module.exports = { checkAndUpdateModel, getCurrentModelVersion, syncModelVersionFromNostr }
