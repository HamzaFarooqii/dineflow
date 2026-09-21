import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import express from 'express'
import { chromium, expect as baseExpect } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const expect = baseExpect.configure({ timeout: 20_000 })
const store = '10000000-0000-4000-8000-000000000001'
const owner = '20000000-0000-4000-8000-000000000001'
const now = new Date()
const accessToken = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.test`
const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: now.toISOString() }
// 'owner' and 'manager' both get full reporting access (management-access.ts); 'cashier' is the
// negative case this fixture switches to below to prove the "Reporting unavailable" gate — it used
// to switch to 'manager' for that, which broke the moment manager access was deliberately relaxed
// to match owner (commit 28517d6) and this fixture was never updated to match.
let membershipRole: 'owner' | 'manager' | 'cashier' = 'owner'

const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3198', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${accessToken}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(user) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: membershipRole }]) })
// App.tsx's onboarding-status check (202609190001_store_onboarding_status.sql) reads this
// directly via the Supabase client, so the fixture must answer it or every route falls into the
// "Something needs your attention" store-load-failure screen. .single() expects a bare object.
identity.get('/rest/v1/stores', (_req, res) => { res.json({ id: store, onboarding_completed_at: now.toISOString() }) })
const identityServer = identity.listen(3199, '127.0.0.1')
const web = express()
// Explicit mocks for the server-only report endpoints (no local-Dexie equivalent, per the code
// comments in ReportingScreens.tsx) — this fixture has no real Postgres/API backend at all, so
// before these existed, isApiReachable()'s /health probe was "reachable" only by accident (the
// catch-all below answers any path with 200 + the SPA's HTML), and the "Sales by cashier" panel's
// fetch of this JSON endpoint got that HTML back and failed to parse it. Deliberately NOT mocking
// /reports/daily-summary: useFinancialReport already falls back to the local Dexie calculation on
// any fetch/parse failure, which is what this fixture's $15.90 assertion below depends on — mocking
// it would replace that local math with these canned numbers instead of proving it.
web.get('/api/health', (_req, res) => { res.json({ ok: true }) })
web.get('/api/reports/orders', (_req, res) => {
  res.json({ orders: [{ id: 'server-order-1', receiptNumber: 'FC-000099', time: now.toISOString(), totalCents: 875, paymentMethod: 'cash', itemCount: 1, syncStatus: 'synced', employeeId: 'employee-1', cashierName: 'Casey Cashier' }], next_cursor: null })
})
web.get('/api/reports/oversold', (_req, res) => { res.json({ products: [] }) })
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile(root + 'apps/web/dist/index.html') })
const webServer = web.listen(3198, '127.0.0.1')

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], { cwd: root + 'apps/web', env: { ...process.env,
    VITE_SUPABASE_URL: 'http://127.0.0.1:3199', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable', VITE_API_URL: '/api' }, stdio: 'inherit', windowsHide: true })
  assert.equal(await new Promise<number | null>(resolve => build.on('exit', resolve)), 0)
  browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.addInitScript(({ accessToken, user }) => localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: accessToken,
    refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user })), { accessToken, user })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:3198/dashboard', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Reporting unavailable' })).toBeVisible()
  await page.evaluate(`(async () => {
    const store = ${JSON.stringify(store)}, instant = ${JSON.stringify(now.toISOString())}
    const request = indexedDB.open('counterline-pos')
    const database = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const transaction = database.transaction(['store_config', 'orders', 'order_items', 'payments', 'outbox'], 'readwrite')
    const add = (name, value) => transaction.objectStore(name).put(value)
    add('store_config', { id: store, store_id: store, name: 'Riverside General', timezone: 'Asia/Karachi', currency: 'USD', catalog_version: 1 })
    const orders = [
      { id: 'order-cash', receipt_number: 'DEMO-000001', subtotal_cents: 1500, tax_cents: 90, total_cents: 1590, sync_status: 'pending' },
      { id: 'order-card', receipt_number: 'DEMO-000002', subtotal_cents: 2000, tax_cents: 200, total_cents: 2200, sync_status: 'synced' },
      { id: 'order-rejected', receipt_number: 'DEMO-000003', subtotal_cents: 500, tax_cents: 50, total_cents: 550, sync_status: 'failed' },
    ]
    for (const order of orders) add('orders', { ...order, store_id: store, catalog_version: 1, client_generated_at: instant, currency: 'USD', store_name_snapshot: 'Riverside General', timezone_snapshot: 'Asia/Karachi', accepted_checkpoint: null, failure_reason: order.sync_status === 'failed' ? 'Needs review' : null })
    add('order_items', { id: 'item-1', order_id: 'order-cash', product_id: 'p1', snapshot_name: 'Ceramic Mug', snapshot_sku: 'MUG', snapshot_price_cents: 750, snapshot_tax_bps: 600, catalog_version: 1, quantity: 2, subtotal_cents: 1500, tax_cents: 90, total_cents: 1590 })
    add('order_items', { id: 'item-2', order_id: 'order-card', product_id: 'p2', snapshot_name: 'Canvas Tote', snapshot_sku: 'TOTE', snapshot_price_cents: 2000, snapshot_tax_bps: 1000, catalog_version: 1, quantity: 1, subtotal_cents: 2000, tax_cents: 200, total_cents: 2200 })
    add('order_items', { id: 'item-3', order_id: 'order-rejected', product_id: 'p3', snapshot_name: 'Tea Blend', snapshot_sku: 'TEA', snapshot_price_cents: 500, snapshot_tax_bps: 1000, catalog_version: 1, quantity: 1, subtotal_cents: 500, tax_cents: 50, total_cents: 550 })
    add('payments', { id: 'pay-1', order_id: 'order-cash', method: 'cash', amount_cents: 1590, tendered_cents: 2000, change_cents: 410, reference: null })
    add('payments', { id: 'pay-2', order_id: 'order-card', method: 'card', amount_cents: 2200, tendered_cents: 2200, change_cents: 0, reference: 'EXT-1' })
    add('payments', { id: 'pay-3', order_id: 'order-rejected', method: 'cash', amount_cents: 550, tendered_cents: 550, change_cents: 0, reference: null })
    const queued = { store_id: store, operation_id: 'op-pending', order_id: 'order-cash', status: 'pending', failure_reason: null, failure_kind: 'connectivity', reason_code: null, attempt_count: 1, lease_owner: null, lease_expires_at: null, accepted_checkpoint: null, next_attempt_at: instant, created_at: instant, payload: '{}' }
    add('outbox', queued); add('outbox', { ...queued, operation_id: 'op-rejected', order_id: 'order-rejected', status: 'failed', failure_kind: 'validation' })
    await new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error) })
    database.close()
  })()`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Today at a glance.' })).toBeVisible()
  const screenshots = root + 'docs/screenshots/daily-sales-reporting/'
  await mkdir(screenshots, { recursive: true })
  for (const width of [1440, 390, 375, 768]) {
    await page.setViewportSize({ width, height: 1000 }); const dashboardWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })); assert(dashboardWidth.scroll <= dashboardWidth.inner, `Owner dashboard overflow at ${width}px: ${JSON.stringify(dashboardWidth)}`)
    if (width === 1440 || width === 390) await page.screenshot({ path: `${screenshots}owner-dashboard-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('link', { name: 'Reports' }).click()
  await expect(page.getByRole('heading', { name: 'Daily sales report.' })).toBeVisible()
  await expect(page.getByText('$15.90', { exact: true })).toBeVisible()
  // Cross-device cashier attribution, sourced from the mocked GET /api/reports/orders above —
  // proves the panel renders real JSON data instead of the JSON-parse-error state it hit before.
  await expect(page.getByRole('heading', { name: 'Sales by cashier' })).toBeVisible()
  await expect(page.getByText('Casey Cashier')).toBeVisible()
  await expect(page.getByText('$8.75', { exact: true })).toBeVisible()
  for (const width of [1440, 390, 375, 768]) {
    await page.setViewportSize({ width, height: 1000 }); const reportWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })); assert(reportWidth.scroll <= reportWidth.inner, `Owner reports overflow at ${width}px: ${JSON.stringify(reportWidth)}`)
    if (width === 1440 || width === 390) await page.screenshot({ path: `${screenshots}owner-reports-${width}.png`, fullPage: true })
  }
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Daily sales report.' })).toBeVisible()
  await context.setOffline(false)
  membershipRole = 'cashier'
  await page.goto('http://127.0.0.1:3198/reports', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Reporting unavailable' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Reports' })).toHaveCount(0)
  await page.goto('http://127.0.0.1:3198/pos/login', { waitUntil: 'domcontentloaded' })
  await page.evaluate(`(async () => {
    const store = ${JSON.stringify(store)}, instant = ${JSON.stringify(now.toISOString())}
    const request = indexedDB.open('counterline-terminal-access')
    const database = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const transaction = database.transaction('access', 'readwrite')
    transaction.objectStore('access').put({ key: 'current', device: { id: 'device-1', store_id: store, name: 'Front counter', receipt_prefix: 'FC' }, validated_at: instant, locked_until: null,
      employees: [{ id: 'employee-1', name: 'Alex Rivera', role: 'cashier', permission_version: 1, locked_until: null, verifier: { version: 1, algorithm: 'PBKDF2-SHA256', iterations: 600000, salt: '0'.repeat(32), hash: '0'.repeat(64) } }],
      session: { employee_id: 'employee-1', permission_version: 1, logged_in_at: instant, last_server_validated_at: instant }, attempts: 0, localLockedUntil: 0, lastSeen: Date.parse(instant) })
    await new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error) }); database.close()
  })()`)
  await page.goto('http://127.0.0.1:3198/pos/dashboard', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Hello, Alex Rivera.' })).toBeVisible()
  await expect(page.getByText('Today’s recorded sales')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Reports' })).toHaveCount(0)
  for (const width of [1440, 390, 375, 768]) {
    await page.setViewportSize({ width, height: 1000 }); const cashierWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })); assert(cashierWidth.scroll <= cashierWidth.inner, `Cashier dashboard overflow at ${width}px: ${JSON.stringify(cashierWidth)}`)
    if (width === 1440 || width === 390) await page.screenshot({ path: `${screenshots}cashier-dashboard-${width}.png`, fullPage: true })
  }
  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Hello, Alex Rivera.' })).toBeVisible()
  await context.setOffline(false)
  await page.goto('http://127.0.0.1:3198/pos/reports')
  await expect(page).toHaveURL('http://127.0.0.1:3198/pos/dashboard')
  assert.deepEqual(errors, [])
  console.log('PASS: owner dashboard/reports and cashier operational dashboard at 375/390/768/1440; cashier report route blocked; screenshots saved.')
} finally {
  await browser?.close(); webServer.closeAllConnections(); identityServer.closeAllConnections(); webServer.close(); identityServer.close()
}
