/**
 * M4TR1X - PeerTube Integration
 *
 * PeerTube è YouTube senza YouTube.
 * Migliaia di istanze indipendenti federate tra loro — ogni creator
 * è su un server diverso, nessuno può cancellare tutto.
 *
 * M4TR1X usa PeerTube per:
 *  - Streaming di video documentari, news indipendenti, cultura
 *  - Caricamento di video verificati da M4TR1X (con attestazione AI)
 *  - Ricerca di contenuti censurati altrove
 *
 * API: REST PeerTube v1 — standard su tutte le istanze
 */

// ─── Istanze PeerTube di default ─────────────────────────────────────────────
const DEFAULT_INSTANCES = [
  'peertube.tv',             // grande istanza pubblica
  'video.blahaj.zone',       // inclusiva, ben moderata
  'diode.zone',              // tech, open source
  'kolektiva.media',         // attivismo, documentari sociali  ← chiave per M4TR1X
  'peertube.social',         // generale
  'tilvids.com',             // educativo
  'videos.lukesmith.xyz',    // tech indipendente
]

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function apiGet(instance, endpoint, accessToken = null) {
  const headers = { 'Accept': 'application/json' }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

  const res = await fetch(`https://${instance}/api/v1${endpoint}`, { headers })
  if (!res.ok) throw new Error(`PeerTube API error ${res.status} on ${instance}`)
  return res.json()
}

// ─── Ricerca video ────────────────────────────────────────────────────────────

/**
 * Cerca video su una o più istanze PeerTube.
 *
 * @param {string}   query     - Testo da cercare
 * @param {string[]} instances - Istanze (default: tutte)
 * @param {number}   limit     - Video per istanza
 */
async function searchVideos(query, instances = DEFAULT_INSTANCES.slice(0, 3), limit = 20) {
  const results = await Promise.allSettled(
    instances.map(inst =>
      apiGet(inst, `/search/videos?search=${encodeURIComponent(query)}&count=${limit}&sort=-publishedAt`)
        .then(data => normalizeVideos(data.data || [], inst))
        .catch(() => [])
    )
  )

  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))

  const seen = new Set()
  return all.filter(v => { if (seen.has(v.uuid)) return false; seen.add(v.uuid); return true })
}

/**
 * Recupera i video più recenti di un'istanza (trending/recenti).
 *
 * @param {string} instance - Istanza PeerTube
 * @param {number} limit    - Numero di video
 * @param {string} sort     - '-publishedAt' | '-trending' | '-views'
 */
async function getVideos(instance = DEFAULT_INSTANCES[0], limit = 30, sort = '-publishedAt') {
  const data = await apiGet(instance, `/videos?count=${limit}&sort=${sort}&nsfw=false`)
  return normalizeVideos(data.data || [], instance)
}

/**
 * Recupera i video di un canale specifico.
 *
 * @param {string} instance    - Istanza
 * @param {string} channelName - Nome canale (es. "documentary@kolektiva.media")
 */
async function getChannelVideos(instance, channelName, limit = 20) {
  const data = await apiGet(instance, `/video-channels/${encodeURIComponent(channelName)}/videos?count=${limit}`)
  return normalizeVideos(data.data || [], instance)
}

/**
 * Dettaglio di un singolo video.
 *
 * @param {string} instance - Istanza
 * @param {string} uuid     - UUID del video
 */
async function getVideo(instance, uuid) {
  const v = await apiGet(instance, `/videos/${uuid}`)
  return normalizeVideo(v, instance)
}

/**
 * Restituisce l'URL embed di un video (per iframe nel frontend).
 *
 * @param {string} instance - Istanza
 * @param {string} uuid     - UUID del video
 * @param {Object} options  - { autoplay, loop, muted, warningTitle }
 */
function getEmbedUrl(instance, uuid, options = {}) {
  const params = new URLSearchParams({
    autoplay:     options.autoplay     ? '1' : '0',
    loop:         options.loop         ? '1' : '0',
    muted:        options.muted        ? '1' : '0',
    warningTitle: options.warningTitle ? '1' : '0',
    peertubeLink: '0',
  })
  return `https://${instance}/videos/embed/${uuid}?${params}`
}

/**
 * Recupera istanze PeerTube affidabili dall'indice pubblico joinpeertube.org.
 * Utile per scoprire nuove istanze attive.
 */
async function discoverInstances(count = 10) {
  try {
    const res = await fetch(
      `https://instances.joinpeertube.org/api/v1/instances?count=${count}&sort=-totalLocalVideos&healthy=true`
    )
    const data = await res.json()
    return (data.data || []).map(i => ({
      host:        i.host,
      name:        i.name,
      description: i.shortDescription,
      videos:      i.totalLocalVideos,
      users:       i.totalUsers,
    }))
  } catch {
    return DEFAULT_INSTANCES.map(h => ({ host: h }))
  }
}

// ─── Normalizzazione ──────────────────────────────────────────────────────────

function normalizeVideos(videos, instance) {
  return (videos || []).map(v => normalizeVideo(v, instance))
}

function normalizeVideo(v, instance) {
  return {
    uuid:          v.uuid,
    instance,
    name:          v.name,
    description:   v.description,
    published_at:  v.publishedAt,
    duration:      v.duration,             // secondi
    views:         v.views,
    likes:         v.likes,
    dislikes:      v.dislikes,
    thumbnail:     v.previewPath ? `https://${instance}${v.previewPath}` : null,
    embed_url:     getEmbedUrl(instance, v.uuid),
    watch_url:     `https://${instance}/videos/watch/${v.uuid}`,
    channel: v.channel ? {
      name:        v.channel.displayName,
      url:         v.channel.url,
      avatar:      v.channel.avatars?.[0]?.path
                     ? `https://${instance}${v.channel.avatars[0].path}`
                     : null,
    } : null,
    tags:          v.tags || [],
    language:      v.language?.label,
    category:      v.category?.label,
    nsfw:          v.nsfw,
  }
}

// ─── Upload autenticato ───────────────────────────────────────────────────────

/**
 * Ottieni l'ID del canale principale dell'utente autenticato.
 */
async function getMyChannelId(instance, token) {
  const res = await fetch(`https://${instance}/api/v1/users/me`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  })
  if (!res.ok) throw new Error(`PeerTube /users/me error ${res.status}`)
  const data = await res.json()
  const channel = data.videoChannels?.[0]
  if (!channel) throw new Error('Nessun canale PeerTube trovato')
  return channel.id
}

/**
 * Carica un video su PeerTube (direct upload, max ~4GB).
 *
 * @param {string} instance    - Istanza PeerTube (es. "kolektiva.media")
 * @param {string} token       - Bearer token OAuth
 * @param {string} videoPath   - Path locale del file video
 * @param {object} meta
 *   @param {string}   meta.name        - Titolo del video (obbligatorio)
 *   @param {string}   [meta.description]
 *   @param {string[]} [meta.tags]       - Array di tag (max 5 per PeerTube)
 *   @param {number}   [meta.privacy]    - 1=public 2=unlisted 3=private (default 1)
 *   @param {string}   [meta.language]   - es. "it", "en"
 * @returns {{ uuid, watch_url, embed_url }}
 */
async function uploadVideo(instance, token, videoPath, meta = {}) {
  const { Blob } = require('buffer')
  const fs       = require('fs')
  const path     = require('path')

  const channelId = await getMyChannelId(instance, token)

  const fileBuffer = fs.readFileSync(videoPath)
  // Use original filename (with extension) for mime detection; multer temp files have no extension
  const origName   = meta.originalname || path.basename(videoPath)
  const mimeType   = origName.match(/\.mov$/i)  ? 'video/quicktime'
                   : origName.match(/\.webm$/i) ? 'video/webm'
                   : 'video/mp4'
  const ext        = mimeType === 'video/quicktime' ? '.mov'
                   : mimeType === 'video/webm'      ? '.webm'
                   : '.mp4'
  // Ensure filename sent to PeerTube has an extension (required by PeerTube validator)
  const baseName   = path.basename(videoPath)
  const fileName   = baseName.includes('.') ? baseName : baseName + ext

  const blob = new Blob([fileBuffer], { type: mimeType })

  const form = new FormData()
  form.append('videofile', blob, fileName)
  form.append('channelId', String(channelId))
  form.append('name', meta.name || fileName)
  if (meta.description) form.append('description', meta.description)
  form.append('privacy', String(meta.privacy || 1))
  form.append('waitTranscoding', 'true')
  if (meta.language) form.append('language', meta.language)
  // PeerTube accetta max 5 tag
  const tags = (meta.tags || []).slice(0, 5)
  tags.forEach(t => form.append('tags[]', t))

  const res = await fetch(`https://${instance}/api/v1/videos/upload`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body:    form,
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => res.status)
    throw new Error(`PeerTube upload error ${res.status}: ${errText}`)
  }

  const data = await res.json()
  const uuid = data.video?.uuid
  return {
    uuid,
    watch_url: `https://${instance}/videos/watch/${uuid}`,
    embed_url: getEmbedUrl(instance, uuid),
  }
}

module.exports = {
  DEFAULT_INSTANCES,
  searchVideos,
  getVideos,
  getChannelVideos,
  getVideo,
  getEmbedUrl,
  discoverInstances,
  uploadVideo,
}
