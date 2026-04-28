/**
 * M4TR1X - Mastodon / ActivityPub Integration
 *
 * Mastodon è la rete sociale federata più grande del mondo.
 * Ogni istanza è indipendente — nessuno può spegnere tutto.
 * Perfetto per discussioni, forum, controinformazione.
 *
 * M4TR1X usa Mastodon come layer di discussione pubblica:
 * legge timeline federate, cerca hashtag, pubblica post.
 *
 * API: REST standard Mastodon v1/v2 — funziona su tutte le istanze.
 */

// ─── Istanze Mastodon di default ─────────────────────────────────────────────
// L'utente può aggiungere la propria istanza preferita
const DEFAULT_INSTANCES = [
  'fosstodon.org',          // tech/open source — public timeline aperta
  'infosec.exchange',       // sicurezza informatica
  'mastodon.online',        // generale, affidabile
  'kolektiva.social',       // attivismo, movimenti sociali
  'social.coop',            // cooperativa
  'mastodon.social',        // grande istanza — public timeline richiede auth
]

// ─── HTTP helper (usa fetch nativo di Node 18+) ──────────────────────────────
async function apiGet(instance, endpoint, accessToken = null) {
  const headers = { 'Accept': 'application/json' }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

  const res = await fetch(`https://${instance}/api/v1${endpoint}`, { headers })
  if (!res.ok) throw new Error(`Mastodon API error ${res.status}: ${endpoint}`)
  return res.json()
}

async function apiPost(instance, endpoint, body, accessToken) {
  const res = await fetch(`https://${instance}/api/v1${endpoint}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Mastodon API error ${res.status}: ${endpoint}`)
  return res.json()
}

// ─── Timeline pubblica ────────────────────────────────────────────────────────

/**
 * Legge la timeline pubblica federata di un'istanza.
 * Nessun account necessario — è pubblica per tutti.
 *
 * @param {string} instance - Es. "mastodon.social"
 * @param {number} limit    - Numero di post (max 40)
 */
async function getPublicTimeline(instance, limit = 40) {
  const list = instance ? [instance] : DEFAULT_INSTANCES
  for (const inst of list) {
    try {
      const posts = await apiGet(inst, `/timelines/public?limit=${limit}&local=false`)
      return normalizePosts(posts, inst)
    } catch {}
  }
  return []
}

/**
 * Cerca post per hashtag su una o più istanze.
 * Utile per cercare contenuti da zone di crisi: #Gaza, #Iran, #Minneapolis
 *
 * @param {string}   hashtag   - Es. "gaza" (senza #)
 * @param {string[]} instances - Istanze da interrogare
 * @param {number}   limit     - Post per istanza
 */
async function searchHashtag(hashtag, instances = DEFAULT_INSTANCES.slice(0, 3), limit = 20) {
  const results = await Promise.allSettled(
    instances.map(inst =>
      apiGet(inst, `/timelines/tag/${encodeURIComponent(hashtag)}?limit=${limit}`)
        .then(posts => normalizePosts(posts, inst))
        .catch(() => [])
    )
  )

  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  // Deduplicazione per URL
  const seen = new Set()
  return all.filter(p => {
    if (seen.has(p.url)) return false
    seen.add(p.url)
    return true
  })
}

/**
 * Cerca account e post per query testuale.
 *
 * @param {string} query    - Testo da cercare
 * @param {string} instance - Istanza su cui cercare
 */
async function search(query, instance = DEFAULT_INSTANCES[0]) {
  const data = await apiGet(instance, `/search?q=${encodeURIComponent(query)}&resolve=true&limit=20`)
  return {
    accounts: (data.accounts || []).map(a => normalizeAccount(a, instance)),
    statuses: normalizePosts(data.statuses || [], instance),
  }
}

// ─── Azioni autenticate ───────────────────────────────────────────────────────

/**
 * Pubblica un post su Mastodon (richiede access token).
 *
 * @param {string} instance     - Istanza Mastodon dell'utente
 * @param {string} accessToken  - Token OAuth dell'utente
 * @param {string} content      - Testo del post (supporta HTML/menzioni)
 * @param {Object} options      - { visibility, sensitive, spoilerText, inReplyToId }
 */
async function publishPost(instance, accessToken, content, options = {}) {
  return apiPost(instance, '/statuses', {
    status:        content,
    visibility:    options.visibility    || 'public',
    sensitive:     options.sensitive     || false,
    spoiler_text:  options.spoilerText   || '',
    in_reply_to_id: options.inReplyToId || null,
  }, accessToken)
}

/**
 * Restituisce la home timeline dell'utente autenticato.
 *
 * @param {string} instance    - Istanza Mastodon
 * @param {string} accessToken - Token OAuth
 * @param {number} limit       - Numero di post
 */
async function getHomeTimeline(instance, accessToken, limit = 40) {
  const posts = await apiGet(instance, `/timelines/home?limit=${limit}`, accessToken)
  return normalizePosts(posts, instance)
}

/**
 * Genera l'URL di autorizzazione OAuth per il login con Mastodon.
 * Redirect-free — usa il flusso "out-of-band" per app desktop.
 *
 * @param {string} instance  - Istanza dell'utente (es. "mastodon.social")
 * @param {string} clientId  - Client ID dell'app M4TR1X sull'istanza
 */
function getAuthUrl(instance, clientId) {
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  'urn:ietf:wg:oauth:2.0:oob',
    response_type: 'code',
    scope:         'read write',
  })
  return `https://${instance}/oauth/authorize?${params}`
}

/**
 * Registra l'app M4TR1X su un'istanza Mastodon (necessario una volta sola).
 * Restituisce client_id e client_secret da salvare.
 *
 * @param {string} instance - Es. "mastodon.social"
 */
async function registerApp(instance) {
  const res = await fetch(`https://${instance}/api/v1/apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name:   'M4TR1X',
      redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
      scopes:        'read write',
      website:       'https://github.com/H8dboy/m4tr1x',
    }),
  })
  return res.json()
}

// ─── Normalizzazione dati ─────────────────────────────────────────────────────
// Formato unificato per il frontend — indipendente dall'istanza

function normalizePosts(posts, instance) {
  return (posts || []).map(p => ({
    id:          p.id,
    instance,
    url:         p.url,
    content:     p.content,                          // HTML
    created_at:  p.created_at,
    account:     normalizeAccount(p.account, instance),
    favourites:  p.favourites_count,
    reblogs:     p.reblogs_count,
    replies:     p.replies_count,
    media:       (p.media_attachments || []).map(m => ({
      type: m.type,   // image, video, gifv, audio
      url:  m.url,
      preview: m.preview_url,
    })),
    tags:        (p.tags || []).map(t => t.name),
    sensitive:   p.sensitive,
    spoiler:     p.spoiler_text,
  }))
}

function normalizeAccount(a, instance) {
  return {
    id:          a.id,
    instance,
    username:    a.acct,
    displayName: a.display_name,
    avatar:      a.avatar,
    url:         a.url,
    followers:   a.followers_count,
    following:   a.following_count,
    note:        a.note,
  }
}

module.exports = {
  DEFAULT_INSTANCES,
  getPublicTimeline,
  searchHashtag,
  search,
  publishPost,
  getHomeTimeline,
  getAuthUrl,
  registerApp,
}
