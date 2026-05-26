/**
 * H8 Shop — fiat → H8 token purchase system
 *
 * Supported payment methods:
 *   - Stripe   → Visa / Mastercard / Apple Pay / Google Pay  (auto-fulfill via webhook)
 *   - PayPal   → manual fulfill by admin after confirmation
 *   - SEPA     → manual fulfill by admin after confirmation
 *
 * On fulfillment, tokens are transferred from NODES_ADDRESS (node reward pool)
 * to the buyer's H8 address via h8token.appendBlock (tx_type: shop_seller).
 */

'use strict'

const crypto   = require('crypto')
const path     = require('path')
const fs       = require('fs')
const Database = require('better-sqlite3')
const token    = require('./h8token')

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.M4TR1X_DATA_DIR || path.join(require('os').homedir(), '.m4tr1x')
const DB_PATH  = path.join(DATA_DIR, 'h8shop.db')
const CFG_PATH = path.join(DATA_DIR, 'h8shop_config.json')

let _db = null
function getDb() {
  if (!_db) _db = new Database(DB_PATH)
  return _db
}

// ─── DB ───────────────────────────────────────────────────────────────────────
function initShopDb() {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_orders (
      id            TEXT PRIMARY KEY,
      buyer_address TEXT NOT NULL,
      method        TEXT NOT NULL,
      amount_h8     INTEGER NOT NULL,
      price_eur     TEXT DEFAULT '0',
      price_usd     TEXT DEFAULT '0',
      payment_ref   TEXT DEFAULT '',
      status        TEXT DEFAULT 'pending',
      fulfilled_tx  TEXT DEFAULT '',
      created_at    INTEGER NOT NULL,
      fulfilled_at  INTEGER DEFAULT 0,
      notes         TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_orders_buyer  ON shop_orders(buyer_address);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON shop_orders(status);
  `)
  // Migration: add amount_h8 to databases created before this refactor
  const cols = db.pragma('table_info(shop_orders)')
  if (!cols.some(c => c.name === 'amount_h8')) {
    db.exec('ALTER TABLE shop_orders ADD COLUMN amount_h8 INTEGER DEFAULT 0')
    db.exec("UPDATE shop_orders SET amount_h8 = CAST(CAST(amount_h8c AS REAL) AS INTEGER) WHERE amount_h8 = 0")
    console.log('[H8SHOP] Migration: amount_h8 column added')
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  price_eur:     0.10,     // € per H8
  price_usd:     0.11,     // $ per H8
  min_order_h8:  10,
  max_order_h8:  100000,
  methods: {
    paypal: {
      enabled:       true,
      paypal_email:  '',
      label:         'PayPal',
      notes:         'Send payment with your Order ID as reference.',
    },
    sepa: {
      enabled: true,
      iban:    '',
      bic:     '',
      holder:  '',
      label:   'Bank transfer / SEPA',
      notes:   'Use your Order ID as payment reference.',
    },
    stripe: {
      enabled:          false,
      secret_key:       '',   // sk_live_... or sk_test_...
      publishable_key:  '',   // pk_live_... or pk_test_...
      webhook_secret:   '',   // whsec_... from Stripe Dashboard
      currency:         'eur',
      label:            'Card / Apple Pay / Google Pay',
      notes:            'Visa, Mastercard, Apple Pay, Google Pay. Instant settlement.',
    },
  },
}

function loadConfig() {
  try {
    if (fs.existsSync(CFG_PATH)) return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) }
  } catch {}
  return { ...DEFAULT_CONFIG }
}

function saveConfig(cfg) {
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2))
}

// ─── Price calculation ────────────────────────────────────────────────────────
function calcOrderPrice(amountH8) {
  const cfg = loadConfig()
  const amt = parseFloat(amountH8)
  return {
    eur: (amt * cfg.price_eur).toFixed(2),
    usd: (amt * cfg.price_usd).toFixed(2),
  }
}

// ─── Stripe — lazy-init ───────────────────────────────────────────────────────
function getStripe() {
  const cfg = loadConfig()
  const key = cfg.methods.stripe.secret_key
  if (!key) throw new Error('STRIPE_NOT_CONFIGURED')
  return require('stripe')(key)
}

// ─── Payment instructions per method ─────────────────────────────────────────
function buildPaymentInstructions(method, orderId, prices) {
  const cfg = loadConfig()
  const m   = cfg.methods[method]
  if (!m || !m.enabled) throw new Error(`PAYMENT_METHOD_UNAVAILABLE: ${method}`)

  const base = { method, order_id: orderId, prices, notes: m.notes, label: m.label }

  switch (method) {
    case 'paypal':
      if (!m.paypal_email) throw new Error('PAYPAL_NOT_CONFIGURED')
      return { ...base, paypal_email: m.paypal_email, amount_eur: prices.eur,
               reference: orderId, link: `https://paypal.me/${m.paypal_email.split('@')[0]}/${prices.eur}EUR` }
    case 'sepa':
      if (!m.iban) throw new Error('SEPA_NOT_CONFIGURED')
      return { ...base, iban: m.iban, bic: m.bic, holder: m.holder,
               amount_eur: prices.eur, reference: orderId }
    case 'stripe':
      return { ...base, publishable_key: m.publishable_key, currency: m.currency,
               amount_eur: prices.eur, amount_usd: prices.usd,
               info: 'Use the returned client_secret with Stripe.js to complete payment.' }
    default:
      throw new Error(`UNKNOWN_METHOD: ${method}`)
  }
}

// ─── Create Stripe PaymentIntent ──────────────────────────────────────────────
async function createStripeIntent(orderId, amountH8, currency) {
  const cfg    = loadConfig()
  const prices = calcOrderPrice(amountH8)
  const stripe = getStripe()
  const cur    = (currency || cfg.methods.stripe.currency || 'eur').toLowerCase()
  const amount = cur === 'usd' ? Math.round(parseFloat(prices.usd) * 100)
                               : Math.round(parseFloat(prices.eur) * 100)

  const intent = await stripe.paymentIntents.create({
    amount,
    currency: cur,
    metadata: { order_id: orderId, h8_amount: String(amountH8) },
    description: `H8 Token — ${amountH8} H8 (Order ${orderId})`,
    payment_method_types: ['card'],
  })

  getDb().prepare('UPDATE shop_orders SET payment_ref=? WHERE id=?').run(intent.id, orderId)
  return { client_secret: intent.client_secret, intent_id: intent.id, amount, currency: cur }
}

// ─── Handle Stripe webhook ────────────────────────────────────────────────────
async function handleStripeWebhook(rawBody, sigHeader) {
  const cfg = loadConfig()
  const m   = cfg.methods.stripe
  if (!m.webhook_secret) throw new Error('WEBHOOK_SECRET_NOT_CONFIGURED')

  const stripe = getStripe()
  let event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sigHeader, m.webhook_secret)
  } catch (err) {
    throw new Error(`WEBHOOK_SIGNATURE_INVALID: ${err.message}`)
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent  = event.data.object
    const orderId = intent.metadata.order_id
    if (!orderId) return { received: true, action: 'skipped' }

    const order = getDb().prepare('SELECT * FROM shop_orders WHERE id=?').get(orderId)
    if (!order)                      return { received: true, action: 'order_not_found' }
    if (order.status === 'fulfilled') return { received: true, action: 'already_fulfilled' }

    const result = await fulfillOrder(orderId, `Stripe auto-fulfill (intent: ${intent.id})`)
    console.log(`[H8SHOP] ✓ Stripe auto-fulfilled ${orderId} — block: ${result.fulfilled_tx}`)
    return { received: true, action: 'fulfilled', order_id: orderId }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const orderId = event.data.object.metadata.order_id
    if (orderId) {
      getDb().prepare("UPDATE shop_orders SET status='failed', notes=? WHERE id=? AND status='pending'")
        .run(`Stripe payment failed: ${event.data.object.last_payment_error?.message || 'unknown'}`, orderId)
    }
    return { received: true, action: 'marked_failed' }
  }

  return { received: true, action: 'ignored' }
}

// ─── Create order ─────────────────────────────────────────────────────────────
function createOrder({ buyerAddress, method, amountH8C }) {
  initShopDb()
  const cfg   = loadConfig()
  const amt   = Math.floor(parseFloat(amountH8C))

  if (isNaN(amt) || amt < cfg.min_order_h8) throw new Error(`MIN_ORDER: ${cfg.min_order_h8} H8`)
  if (amt > cfg.max_order_h8)               throw new Error(`MAX_ORDER: ${cfg.max_order_h8} H8`)

  const prices  = calcOrderPrice(amt)
  const orderId = 'H8-' + crypto.randomBytes(6).toString('hex').toUpperCase()
  const now     = Math.floor(Date.now() / 1000)

  const instructions = buildPaymentInstructions(method, orderId, prices)

  getDb().prepare(`
    INSERT INTO shop_orders (id, buyer_address, method, amount_h8, price_eur, price_usd, payment_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderId, buyerAddress, method, amt, prices.eur, prices.usd, orderId, now)

  console.log(`[H8SHOP] Order ${orderId} — ${amt} H8 via ${method} — buyer: ${buyerAddress}`)

  const base = { order_id: orderId, amount_h8: amt, buyer_address: buyerAddress, created_at: now, status: 'pending', payment: instructions }

  if (method === 'stripe') {
    const cur = cfg.methods.stripe.currency || 'eur'
    return createStripeIntent(orderId, amt, cur).then(intent => ({
      ...base,
      client_secret:   intent.client_secret,
      publishable_key: cfg.methods.stripe.publishable_key,
      stripe_amount:   intent.amount,
      stripe_currency: intent.currency,
    }))
  }

  return base
}

// ─── Fulfill order — transfer tokens from NODES pool to buyer ─────────────────
async function fulfillOrder(orderId, notes = '') {
  initShopDb()
  const order = getDb().prepare('SELECT * FROM shop_orders WHERE id=?').get(orderId)
  if (!order)                       throw new Error('ORDER_NOT_FOUND')
  if (order.status === 'fulfilled') throw new Error('ALREADY_FULFILLED')
  if (order.status === 'cancelled') throw new Error('ORDER_CANCELLED')

  const block = await token.appendBlock({
    from:       token.NODES_ADDRESS,
    to:         order.buyer_address,
    amount:     order.amount_h8,
    tx_type:    'shop_seller',
    content_id: orderId,
    note:       JSON.stringify({ purchase_id: orderId, payment_method: order.method }),
  })

  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(`
    UPDATE shop_orders SET status='fulfilled', fulfilled_tx=?, fulfilled_at=?, notes=? WHERE id=?
  `).run(String(block.hash), now, notes, orderId)

  console.log(`[H8SHOP] ✓ Fulfilled ${orderId} — ${order.amount_h8} H8 → ${order.buyer_address} (block: ${block.block_index})`)
  return { order_id: orderId, fulfilled_tx: block.hash, amount_h8: order.amount_h8, buyer_address: order.buyer_address }
}

// ─── Cancel order ─────────────────────────────────────────────────────────────
function cancelOrder(orderId, reason = '') {
  initShopDb()
  const order = getDb().prepare('SELECT * FROM shop_orders WHERE id=?').get(orderId)
  if (!order)                       throw new Error('ORDER_NOT_FOUND')
  if (order.status === 'fulfilled') throw new Error('CANNOT_CANCEL_FULFILLED')
  getDb().prepare("UPDATE shop_orders SET status='cancelled', notes=? WHERE id=?").run(reason, orderId)
  return { ok: true, order_id: orderId }
}

// ─── Queries ──────────────────────────────────────────────────────────────────
function getOrder(orderId) {
  initShopDb()
  return getDb().prepare('SELECT * FROM shop_orders WHERE id=?').get(orderId) || null
}

function listOrders({ status, buyerAddress, limit = 50, offset = 0 } = {}) {
  initShopDb()
  let q = 'SELECT * FROM shop_orders WHERE 1=1'
  const params = []
  if (status)       { q += ' AND status=?';        params.push(status) }
  if (buyerAddress) { q += ' AND buyer_address=?'; params.push(buyerAddress) }
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)
  return getDb().prepare(q).all(...params)
}

function shopStats() {
  initShopDb()
  return getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='fulfilled' THEN 1 ELSE 0 END) as fulfilled,
      SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status='fulfilled' THEN amount_h8  ELSE 0 END) as total_h8_sold,
      SUM(CASE WHEN status='fulfilled' THEN CAST(price_eur AS REAL) ELSE 0 END) as total_eur
    FROM shop_orders
  `).get()
}

module.exports = {
  initShopDb,
  loadConfig,
  saveConfig,
  createOrder,
  fulfillOrder,
  cancelOrder,
  getOrder,
  listOrders,
  shopStats,
  calcOrderPrice,
  handleStripeWebhook,
}
