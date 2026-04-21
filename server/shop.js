/**
 * M4TR1X - Decentralized Shop (H8 Token)
 *
 * Marketplace decentralizzato dove:
 *  - I venditori pubblicano prodotti con prezzo in H8
 *  - Il pagamento è istantaneo (ledger locale, nessuna blockchain esterna)
 *  - Split automatico: 85% venditore · 10% piattaforma · 5% server
 *  - Nessun intermediario, nessuna attesa di conferma
 */

const Database = require('better-sqlite3')
const path     = require('path')
const { v4: uuidv4 } = require('uuid')
const { shopPay } = require('./h8token')

// ─── Database ─────────────────────────────────────────────────────────────────

let db

function getShopDbPath() {
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'shop.db')
  } catch {
    return path.join(process.cwd(), 'shop.db')
  }
}

function initShopDb() {
  db = new Database(getShopDbPath())

  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id            TEXT PRIMARY KEY,
      seller_pubkey TEXT NOT NULL,        -- H8 address del venditore
      title         TEXT NOT NULL,
      description   TEXT,
      price_h8      INTEGER NOT NULL,     -- prezzo in centesimi H8
      category      TEXT DEFAULT 'other',
      image_emoji   TEXT DEFAULT '📦',
      created_at    TEXT NOT NULL,
      active        INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS orders (
      id             TEXT PRIMARY KEY,
      listing_id     TEXT NOT NULL,
      buyer_h8id     TEXT,               -- H8 address dell'acquirente
      seller_h8id    TEXT NOT NULL,
      amount_h8      INTEGER NOT NULL,   -- in centesimi H8
      tx_hash        TEXT,               -- hash del blocco nel ledger H8
      status         TEXT DEFAULT 'pending',  -- pending | confirmed | cancelled
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      FOREIGN KEY(listing_id) REFERENCES listings(id)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_listing  ON orders(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_pubkey);
  `)

  console.log('[SHOP] Database inizializzato (H8 token).')
}

// ─── Listings ─────────────────────────────────────────────────────────────────

function createListing({ sellerPubkey, title, description, priceH8, category = 'other', imageEmoji = '📦' }) {
  const id = uuidv4().substring(0, 12)
  db.prepare(`
    INSERT INTO listings (id, seller_pubkey, title, description, price_h8, category, image_emoji, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, sellerPubkey, title, description || '', priceH8, category, imageEmoji, new Date().toISOString())
  console.log(`[SHOP] Nuovo prodotto: "${title}" a ${priceH8} H8`)
  return id
}

function getListings({ category, limit = 50 } = {}) {
  let q = 'SELECT * FROM listings WHERE active = 1'
  const params = []
  if (category) { q += ' AND category = ?'; params.push(category) }
  q += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)
  return db.prepare(q).all(...params)
}

function getListing(id) {
  return db.prepare('SELECT * FROM listings WHERE id = ?').get(id) || null
}

function deactivateListing(id, sellerPubkey) {
  db.prepare('UPDATE listings SET active = 0 WHERE id = ? AND seller_pubkey = ?').run(id, sellerPubkey)
}

// ─── Orders ───────────────────────────────────────────────────────────────────

/**
 * Avvia un acquisto e processa il pagamento H8 istantaneamente.
 * Il buyer deve avere il wallet H8 sbloccato.
 */
async function buyListing(listingId, buyerH8Id) {
  const listing = getListing(listingId)
  if (!listing) throw new Error('Prodotto non trovato')
  if (!listing.active) throw new Error('Prodotto non più disponibile')

  const orderId = uuidv4().substring(0, 12)
  const now     = new Date().toISOString()

  // Pagamento H8 istantaneo
  const result = await shopPay(listing.seller_pubkey, listing.price_h8, listingId)

  db.prepare(`
    INSERT INTO orders (id, listing_id, buyer_h8id, seller_h8id, amount_h8, tx_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
  `).run(orderId, listingId, buyerH8Id, listing.seller_pubkey, listing.price_h8,
    `shop_${orderId}`, now, now)

  console.log(`[SHOP] Ordine ${orderId} CONFERMATO — ${listing.price_h8} H8 → ${listing.seller_pubkey.substring(0, 12)}...`)
  return {
    orderId,
    status:       'confirmed',
    amountH8:     listing.price_h8,
    sellerAmount: result.sellerAmt,
    listingTitle: listing.title,
  }
}

function getOrder(orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) || null
}

function getSellerOrders(sellerH8Id, limit = 50) {
  return db.prepare('SELECT * FROM orders WHERE seller_h8id = ? ORDER BY created_at DESC LIMIT ?').all(sellerH8Id, limit)
}

function getBuyerOrders(buyerH8Id, limit = 50) {
  return db.prepare('SELECT * FROM orders WHERE buyer_h8id = ? ORDER BY created_at DESC LIMIT ?').all(buyerH8Id, limit)
}

module.exports = {
  initShopDb,
  createListing,
  getListings,
  getListing,
  deactivateListing,
  buyListing,
  getOrder,
  getSellerOrders,
  getBuyerOrders,
}
