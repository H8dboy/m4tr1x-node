/**
 * H8 Shop — H8C purchase system
 *
 * Manual methods (admin fulfills after payment):
 *   - BTC  on-chain  → static address, 1-confirm rule
 *   - Lightning      → BOLT11 via LNbits
 *   - PayPal         → email + reference
 *   - Bank / SEPA    → IBAN + reference
 *   - USDT           → TRC-20 / ERC-20 address
 *
 * Automatic methods (Stripe webhook auto-fulfills):
 *   - stripe → Visa, Mastercard, Apple Pay, Google Pay
 *
 * Stripe flow:
 *   1. POST /api/v1/shop/buy { method:"stripe", amount_h8c, buyer_address }
 *      → returns { order_id, client_secret, publishable_key }
 *   2. Frontend uses Stripe.js / Payment Element to collect card
 *   3. Stripe calls POST /api/v1/shop/stripe/webhook on success
 *   4. Webhook auto-fulfills order → H8C issued to buyer_address
 */

'use strict'

const crypto   = require('crypto')
const path     = require('path')
const fs       = require('fs')
const Database = require('better-sqlite3')
const coin     = require('./h8coin')

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR  = process.env.M4TR1X_DATA_DIR || path.join(require('os').homedir(), '.m4tr1x')
const DB_PATH   = path.join(DATA_DIR, 'h8coin.db')
const CFG_PATH  = path.join(DATA_DIR, 'h8shop_config.json')

let _db = null
function getDb() {
  if (!_db) _db = new Database(DB_PATH)
  return _db
}

// ─── DB ───────────────────────────────────────────────────────────────────────
function initShopDb() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS shop_orders (
      id           TEXT PRIMARY KEY,
      buyer_address TEXT NOT NULL,
      method       TEXT NOT NULL,
      amount_h8c   TEXT NOT NULL,
      amount_sat   TEXT NOT NULL,
      price_eur    TEXT DEFAULT '0',
      price_usd    TEXT DEFAULT '0',
      price_btc    TEXT DEFAULT '0',
      payment_ref  TEXT DEFAULT '',
      status       TEXT DEFAULT 'pending',
      fulfilled_tx TEXT DEFAULT '',
      created_at   INTEGER NOT NULL,
      fulfilled_at INTEGER DEFAULT 0,
      notes        TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_orders_buyer  ON shop_orders(buyer_address);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON shop_orders(status);
  `)
}

// ─── Config (price per H8C in different currencies) ──────────────────────────
const DEFAULT_CONFIG = {
  price_eur:     0.10,   // 0.10 € per H8C
  price_usd:     0.11,
  price_btc:     0.0000015,
  min_order_h8c: 10,
  max_order_h8c: 100000,
  methods: {
    btc: {
      enabled: true,
      address: '',        // set via /api/v1/admin/shop/config
      label:   'Bitcoin (on-chain)',
      notes:   'Send BTC to the address shown. Order confirmed after 1 confirmation.',
    },
    lightning: {
      enabled: false,
      lnbits_url:  '',   // e.g. https://lnbits.yourdomain.com
      lnbits_key:  '',
      label:   'Lightning Network',
      notes:   'Pay the BOLT11 invoice shown. Instant settlement.',
    },
    paypal: {
      enabled: true,
      paypal_email: '',
      label:   'PayPal',
      notes:   'Send payment with your Order ID as reference.',
    },
    sepa: {
      enabled: true,
      iban:    '',
      bic:     '',
      holder:  '',
      label:   'Bank transfer / SEPA',
      notes:   'Use your Order ID as payment reference.',
    },
    usdt: {
      enabled: false,
      address:  '',       // ERC-20 / TRC-20 address
      network:  'TRC-20',
      label:   'USDT',
      notes:   'Send USDT to the address shown.',
    },
    stripe: {
      enabled: false,
      secret_key:       '',   // sk_live_... or sk_test_...
      publishable_key:  '',   // pk_live_... or pk_test_...
      webhook_secret:   '',   // whsec_... from Stripe Dashboard → Webhooks
      currency:         'eur',
      label:   'Card / Apple Pay / Google Pay',
      notes:   'Visa, Mastercard, Apple Pay, Google Pay. Instant settlement.',
    },
  }
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
function calcOrderPrice(amountH8C) {
  const cfg = loadConfig()
  const amt = parseFloat(amountH8C)
  return {
    eur: (amt * cfg.price_eur).toFixed(2),
    usd: (amt * cfg.price_usd).toFixed(2),
    btc: (amt * cfg.price_btc).toFixed(8),
  }
}

// ─── Stripe helper — lazy-init so missing key doesn't crash the server ────────
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
    case 'btc':
      if (!m.address) throw new Error('BTC_ADDRESS_NOT_CONFIGURED')
      return { ...base, address: m.address, amount_btc: prices.btc,
               qr: `bitcoin:${m.address}?amount=${prices.btc}&label=H8C-${orderId}` }
    case 'lightning':
      return { ...base, invoice: null, status: 'invoice_pending',
               info: 'Lightning invoice will be generated — contact admin or use the node UI.' }
    case 'paypal':
      if (!m.paypal_email) throw new Error('PAYPAL_NOT_CONFIGURED')
      return { ...base, paypal_email: m.paypal_email, amount_eur: prices.eur,
               reference: orderId, link: `https://paypal.me/${m.paypal_email.split('@')[0]}/${prices.eur}EUR` }
    case 'sepa':
      if (!m.iban) throw new Error('SEPA_NOT_CONFIGURED')
      return { ...base, iban: m.iban, bic: m.bic, holder: m.holder,
               amount_eur: prices.eur, reference: orderId }
    case 'usdt':
      if (!m.address) throw new Error('USDT_ADDRESS_NOT_CONFIGURED')
      return { ...base, address: m.address, network: m.network, amount_usd: prices.usd }
    case 'stripe':
      // PaymentIntent is created async — caller handles it separately via createStripeIntent()
      return { ...base, publishable_key: m.publishable_key, currency: m.currency,
               amount_eur: prices.eur, amount_usd: prices.usd,
               info: 'Use the returned client_secret with Stripe.js to complete payment.' }
    default:
      throw new Error(`UNKNOWN_METHOD: ${method}`)
  }
}

// ─── Create Stripe PaymentIntent (called after order row is inserted) ─────────
async function createStripeIntent(orderId, amountH8C, currency) {
  const cfg     = loadConfig()
  const prices  = calcOrderPrice(amountH8C)
  const stripe  = getStripe()
  const cur     = (currency || cfg.methods.stripe.currency || 'eur').toLowerCase()
  const amount  = cur === 'usd' ? Math.round(parseFloat(prices.usd) * 100)
                                : Math.round(parseFloat(prices.eur) * 100)  // cents

  const intent = await stripe.paymentIntents.create({
    amount,
    currency: cur,
    metadata: { order_id: orderId, h8c_amount: String(amountH8C) },
    description: `H8 Coin — ${amountH8C} H8C (Order ${orderId})`,
    payment_method_types: ['card'],   // Apple Pay + Google Pay auto-enabled via Payment Element
  })

  // Store intent ID so webhook can match it back to the order
  getDb().prepare("UPDATE shop_orders SET payment_ref=? WHERE id=?").run(intent.id, orderId)

  return { client_secret: intent.client_secret, intent_id: intent.id, amount, currency: cur }
}

// ─── Handle Stripe webhook event ─────────────────────────────────────────────
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

    if (!orderId) {
      console.warn('[H8SHOP] Stripe webhook: no order_id in metadata', intent.id)
      return { received: true, action: 'skipped' }
    }

    const order = getDb().prepare('SELECT * FROM shop_orders WHERE id=?').get(orderId)
    if (!order) {
      console.warn('[H8SHOP] Stripe webhook: order not found', orderId)
      return { received: true, action: 'order_not_found' }
    }
    if (order.status === 'fulfilled') {
      return { received: true, action: 'already_fulfilled' }
    }

    const txid = await fulfillOrder(orderId, `Stripe auto-fulfill (intent: ${intent.id})`)
    console.log(`[H8SHOP] ✓ Stripe auto-fulfilled ${orderId} — tx: ${txid.fulfilled_tx}`)
    return { received: true, action: 'fulfilled', order_id: orderId }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent  = event.data.object
    const orderId = intent.metadata.order_id
    if (orderId) {
      getDb().prepare("UPDATE shop_orders SET status='failed', notes=? WHERE id=? AND status='pending'")
        .run(`Stripe payment failed: ${intent.last_payment_error?.message || 'unknown'}`, orderId)
    }
    return { received: true, action: 'marked_failed' }
  }

  return { received: true, action: 'ignored' }
}

// ─── Create order ─────────────────────────────────────────────────────────────
// Returns a plain object for manual methods.
// For 'stripe', returns a Promise (caller must await) — includes client_secret.
function createOrder({ buyerAddress, method, amountH8C }) {
  initShopDb()
  const cfg = loadConfig()

  const amt = parseFloat(amountH8C)
  if (isNaN(amt) || amt < cfg.min_order_h8c) throw new Error(`MIN_ORDER: ${cfg.min_order_h8c} H8C`)
  if (amt > cfg.max_order_h8c)               throw new Error(`MAX_ORDER: ${cfg.max_order_h8c} H8C`)

  const amountSat = coin.parseH8C(String(amt))
  const prices    = calcOrderPrice(amt)
  const orderId   = 'H8C-' + crypto.randomBytes(6).toString('hex').toUpperCase()
  const now       = Math.floor(Date.now() / 1000)

  const instructions = buildPaymentInstructions(method, orderId, prices)

  getDb().prepare(`
    INSERT INTO shop_orders
      (id, buyer_address, method, amount_h8c, amount_sat, price_eur, price_usd, price_btc, payment_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderId, buyerAddress, method, String(amt), String(amountSat), prices.eur, prices.usd, prices.btc, orderId, now)

  console.log(`[H8SHOP] Order ${orderId} — ${amt} H8C via ${method} — buyer: ${buyerAddress}`)

  const base = { order_id: orderId, amount_h8c: String(amt), buyer_address: buyerAddress, created_at: now, status: 'pending', payment: instructions }

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

// ─── Fulfill order (admin only) ───────────────────────────────────────────────
async function fulfillOrder(orderId, notes = '') {
  initShopDb()
  const order = getDb().prepare('SELECT * FROM shop_orders WHERE id=?').get(orderId)
  if (!order)                       throw new Error('ORDER_NOT_FOUND')
  if (order.status === 'fulfilled') throw new Error('ALREADY_FULFILLED')
  if (order.status === 'cancelled') throw new Error('ORDER_CANCELLED')

  const txid = await coin.issueReward(order.buyer_address, BigInt(order.amount_sat), `Purchase order ${orderId} via ${order.method}`)
  const now  = Math.floor(Date.now() / 1000)

  getDb().prepare(`
    UPDATE shop_orders SET status='fulfilled', fulfilled_tx=?, fulfilled_at=?, notes=? WHERE id=?
  `).run(txid, now, notes, orderId)

  console.log(`[H8SHOP] ✓ Fulfilled ${orderId} — ${order.amount_h8c} H8C → ${order.buyer_address} (tx: ${txid})`)
  return { order_id: orderId, fulfilled_tx: txid, amount_h8c: order.amount_h8c, buyer_address: order.buyer_address }
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
  const rows = getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='fulfilled' THEN 1 ELSE 0 END) as fulfilled,
      SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status='fulfilled' THEN CAST(amount_h8c AS REAL) ELSE 0 END) as total_h8c_sold,
      SUM(CASE WHEN status='fulfilled' THEN CAST(price_eur   AS REAL) ELSE 0 END) as total_eur
    FROM shop_orders
  `).get()
  return rows
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
