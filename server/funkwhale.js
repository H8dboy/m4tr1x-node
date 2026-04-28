/**
 * M4TR1X - Funkwhale Integration
 *
 * Funkwhale è Spotify senza Spotify.
 * Rete federata di librerie musicali — artisti indipendenti, musica
 * che Spotify rimuove, cultura che le piattaforme censurano.
 * Chiunque può ospitare la propria istanza con la propria musica.
 *
 * In M4TR1X, Funkwhale è il layer culturale:
 *  - Musica di artisti censurati
 *  - Podcast e radio libere
 *  - Soundtrack di movimenti sociali
 *
 * API: Subsonic-compatible + REST Funkwhale v1
 */

// ─── Istanze Funkwhale di default ─────────────────────────────────────────────
const DEFAULT_INSTANCES = [
  'tanukitunes.com',         // musica indipendente — confermata attiva
  'open.audio',              // istanza pubblica principale
  'funkwhale.social',        // sociale, aperta
  'audio.gatto.ninja',       // italiana
  'music.gaysweater.net',    // LGBTQ+ artists
]

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function apiGet(instance, endpoint, accessToken = null) {
  const headers = { 'Accept': 'application/json' }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

  const res = await fetch(`https://${instance}/api/v1${endpoint}`, { headers })
  if (!res.ok) throw new Error(`Funkwhale API error ${res.status} on ${instance}`)
  return res.json()
}

// ─── Brani e album ────────────────────────────────────────────────────────────

/**
 * Cerca brani musicali su una o più istanze.
 *
 * @param {string}   query     - Artista, titolo, album
 * @param {string[]} instances - Istanze da interrogare
 * @param {number}   limit     - Risultati per istanza
 */
async function searchTracks(query, instances = DEFAULT_INSTANCES.slice(0, 2), limit = 20) {
  const results = await Promise.allSettled(
    instances.map(inst =>
      apiGet(inst, `/tracks?q=${encodeURIComponent(query)}&page_size=${limit}`)
        .then(data => normalizeTracks(data.results || [], inst))
        .catch(() => [])
    )
  )

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
}

/**
 * Recupera i brani più recenti di un'istanza.
 *
 * @param {string} instance - Istanza Funkwhale
 * @param {number} limit    - Numero di brani
 */
async function getRecentTracks(instance, limit = 30) {
  const list = instance ? [instance] : DEFAULT_INSTANCES
  for (const inst of list) {
    try {
      const data = await apiGet(inst, `/tracks?page_size=${limit}&ordering=-creation_date`)
      return normalizeTracks(data.results || [], inst)
    } catch {}
  }
  return []
}

/**
 * Recupera gli album più recenti.
 *
 * @param {string} instance - Istanza
 * @param {number} limit    - Numero album
 */
async function getRecentAlbums(instance, limit = 20) {
  const list = instance ? [instance] : DEFAULT_INSTANCES
  for (const inst of list) {
    try {
      const data = await apiGet(inst, `/albums?page_size=${limit}&ordering=-creation_date`)
      return (data.results || []).map(a => normalizeAlbum(a, inst))
    } catch {}
  }
  return []
}

/**
 * Dettaglio di un artista con i suoi album.
 *
 * @param {string} instance  - Istanza
 * @param {number} artistId  - ID artista
 */
async function getArtist(instance, artistId) {
  const [artist, albums] = await Promise.all([
    apiGet(instance, `/artists/${artistId}`),
    apiGet(instance, `/albums?artist=${artistId}&page_size=50`),
  ])
  return {
    ...normalizeArtist(artist, instance),
    albums: (albums.results || []).map(a => normalizeAlbum(a, instance)),
  }
}

/**
 * Recupera i brani di un album.
 *
 * @param {string} instance - Istanza
 * @param {number} albumId  - ID album
 */
async function getAlbumTracks(instance, albumId) {
  const data = await apiGet(instance, `/tracks?album=${albumId}&page_size=100`)
  return normalizeTracks(data.results || [], instance)
}

/**
 * Costruisce l'URL di streaming di un brano.
 * Il brano viene streamato direttamente dall'istanza.
 *
 * @param {string} instance  - Istanza
 * @param {number} trackId   - ID brano
 * @param {string} accessToken - (opzionale) per contenuti privati
 */
function getStreamUrl(instance, trackId, accessToken = null) {
  const base = `https://${instance}/api/v1/listen/${trackId}/`
  return accessToken ? `${base}?jwt=${accessToken}` : base
}

/**
 * Recupera i podcast/radio disponibili.
 *
 * @param {string} instance - Istanza
 */
async function getChannels(instance, limit = 20) {
  if (!instance) instance = DEFAULT_INSTANCES[0]
  const data = await apiGet(instance, `/channels?page_size=${limit}&ordering=-creation_date`)
  return (data.results || []).map(ch => ({
    uuid:        ch.uuid,
    instance,
    name:        ch.artist?.name,
    description: ch.artist?.description,
    cover:       ch.artist?.cover?.urls?.original
                   ? `https://${instance}${ch.artist.cover.urls.original}` : null,
    url:         `https://${instance}/channels/${ch.actor.preferred_username}`,
    episodes:    ch.attributed_to?.uploads_count || 0,
    tags:        ch.artist?.tags || [],
  }))
}

/**
 * Cerca istanze Funkwhale attive dall'indice pubblico.
 */
async function discoverInstances(count = 10) {
  try {
    const res  = await fetch(`https://network.funkwhale.audio/api/v1/pods/?limit=${count}&status=up`)
    const data = await res.json()
    return (data.results || []).map(i => ({
      host:        i.domain,
      name:        i.name,
      description: i.short_description,
      users:       i.users_count,
      tracks:      i.audio_duration,
      open:        i.open_registrations,
    }))
  } catch {
    return DEFAULT_INSTANCES.map(h => ({ host: h }))
  }
}

// ─── Normalizzazione ──────────────────────────────────────────────────────────

function normalizeTracks(tracks, instance) {
  return (tracks || []).map(t => ({
    id:          t.id,
    instance,
    title:       t.title,
    duration:    t.duration,            // secondi
    position:    t.position,
    stream_url:  getStreamUrl(instance, t.id),
    cover:       t.album?.cover?.urls?.original
                   ? `https://${instance}${t.album.cover.urls.original}` : null,
    artist:      t.artist ? normalizeArtist(t.artist, instance) : null,
    album:       t.album  ? normalizeAlbum(t.album, instance)   : null,
    tags:        t.tags || [],
    license:     t.license?.code,       // es. "cc-by", "cc-0"
    created_at:  t.creation_date,
    listen_url:  `https://${instance}/library/tracks/${t.id}`,
  }))
}

function normalizeAlbum(a, instance) {
  return {
    id:          a.id,
    instance,
    title:       a.title,
    year:        a.release_date?.substring(0, 4),
    cover:       a.cover?.urls?.original
                   ? `https://${instance}${a.cover.urls.original}` : null,
    artist:      a.artist ? normalizeArtist(a.artist, instance) : null,
    tracks_count: a.tracks_count,
    tags:        a.tags || [],
    url:         `https://${instance}/library/albums/${a.id}`,
  }
}

function normalizeArtist(a, instance) {
  return {
    id:          a.id,
    instance,
    name:        a.name,
    description: a.description,
    cover:       a.cover?.urls?.original
                   ? `https://${instance}${a.cover.urls.original}` : null,
    tags:        a.tags || [],
    url:         `https://${instance}/library/artists/${a.id}`,
  }
}

module.exports = {
  DEFAULT_INSTANCES,
  searchTracks,
  getRecentTracks,
  getRecentAlbums,
  getArtist,
  getAlbumTracks,
  getStreamUrl,
  getChannels,
  discoverInstances,
}
