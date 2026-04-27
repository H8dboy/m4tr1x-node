/**
 * M4TR1X smoke test — verifica end-to-end del ledger H8.
 * Exit 0 se tutto passa, exit 1 al primo fail.
 */
const { spawn } = require('child_process')
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = 8765
const BASE = `http://localhost:${PORT}`
const DATA_DIR = path.join(__dirname, '..', '.smoke-tmp')
const ADMIN = 'smoke_admin_' + Math.random().toString(36).slice(2, 10)
const PASS = 'smokepass1234'

if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true })
fs.mkdirSync(DATA_DIR, { recursive: true })

function req(method, pathUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + pathUrl)
    const r = http.request({
      method, hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...headers }, timeout: 5000,
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }) }
        catch { resolve({ status: res.statusCode, body: d }) }
      })
    })
    r.on('error', reject)
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')) })
    if (body) r.write(JSON.stringify(body))
    r.end()
  })
}

function assert(cond, msg) {
  if (!cond) { console.error('✗ FAIL:', msg); process.exit(1) }
  console.log('✓', msg)
}

async function run() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    ADMIN_KEY: ADMIN,
    H8_MINT_ADDRESS:     'H8' + '0'.repeat(38),
    H8_PLATFORM_ADDRESS: 'H8' + '1'.repeat(38),
    H8_SERVER_ADDRESS:   'H8' + '2'.repeat(38),
    APP_SECRET: 'a'.repeat(64),
    M4TR1X_DATA_DIR: DATA_DIR,
  }

  const srv = spawn('node', ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  srv.stdout.on('data', d => process.stdout.write('[srv] ' + d))
  srv.stderr.on('data', d => process.stderr.write('[srv-err] ' + d))

  for (let i = 0; i < 30; i++) {
    try { const h = await req('GET', '/health'); if (h.status === 200) break }
    catch {}
    await new Promise(r => setTimeout(r, 500))
  }

  try {
    assert((await req('GET', '/health')).status === 200, 'health 200')

    const create = await req('POST', '/api/v1/h8/wallet/create', { password: PASS })
    assert(create.status === 201, `wallet create (${create.status})`)
    const addr = create.body.address
    assert(/^H8[0-9a-f]{38}$/.test(addr), `valid H8 address ${addr}`)

    assert((await req('POST', '/api/v1/h8/wallet/unlock', { password: PASS })).status === 200, 'unlock')

    const mint = await req('POST', '/api/v1/admin/h8/mint',
      { toAddress: addr, amount: 10000 }, { 'x-admin-key': ADMIN })
    assert(mint.status === 200, 'admin mint 10000')

    assert((await req('GET', '/api/v1/h8/balance')).body.balance === 10000, 'balance after mint = 10000')

    const tip = await req('POST', '/api/v1/h8/tip',
      { creatorAddress: 'nostr_' + 'a'.repeat(38), amount: 1000, contentId: 'vid_smoke_1' })
    assert(tip.status === 200, 'tip 200')
    assert(tip.body.creator.amount === 500,  `creator share 500 (${tip.body.creator.amount})`)
    assert(tip.body.platform.amount === 200, `platform share 200 (${tip.body.platform.amount})`)
    assert(tip.body.server.amount === 300,   `server share 300 (${tip.body.server.amount})`)

    assert((await req('POST', '/api/v1/h8/boost', { contentId: 'vid_smoke_1', amount: 500 })).status === 200, 'boost')
    assert((await req('GET', '/api/v1/h8/boost/vid_smoke_1')).body.score === 500, 'boost score 500')

    const batch = await req('GET', '/api/v1/h8/boost/batch?ids=vid_smoke_1,vid_nope')
    assert(batch.body.vid_smoke_1 === 500 && batch.body.vid_nope === 0, 'batch boost')

    assert((await req('GET', '/api/v1/h8/balance')).body.balance === 8500, 'balance after spend = 8500')

    const history = await req('GET', '/api/v1/h8/history')
    assert(Array.isArray(history.body) && history.body.length >= 5, `history >= 5 entries`)

    const verify = await req('GET', '/api/v1/h8/chain/verify')
    assert(verify.body.valid === true, `chain valid (${verify.body.blocks} blocks)`)

    console.log('\n✓ ALL SMOKE TESTS PASSED')
    process.exit(0)
  } catch (e) {
    console.error('✗ ERROR:', e.message)
    process.exit(1)
  } finally {
    srv.kill('SIGTERM')
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 500)
  }
}

run()
