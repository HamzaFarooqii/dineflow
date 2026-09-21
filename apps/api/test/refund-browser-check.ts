import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { chromium, expect as baseExpect } from '@playwright/test'

// End-to-end verification for the owner/manager whole-order refund (money-correctness code —
// held to the same review bar as checkout itself). Follows the customer-browser-check.ts
// pattern: an in-memory Postgres with the real migrations applied, faked Supabase auth, a real
// cash sale driven through the actual Register -> Payment flow, then a refund driven through the
// actual Receipt screen — not a shortcut that seeds an order directly with SQL.

const root = fileURLToPath(new URL('../../../', import.meta.url))
const pictures = root + 'docs/screenshots/refunds/'
const expect = baseExpect.configure({ timeout: 20_000 })
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
process.env.SUPABASE_URL = 'http://127.0.0.1:3193'
process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture'
const { db } = await import('../src/db.js')
const { createApp } = await import('../src/app.js')

const database = new PGlite()
await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';
  -- Minimal storage schema stub: PGlite has no Supabase Storage extension, but the product-images
  -- migration expects storage.buckets/storage.objects/storage.foldername() to exist.
  create schema storage;
  create table storage.buckets(id text primary key, name text, public boolean);
  create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  create function storage.foldername(name text) returns text[] language sql as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;`)
for (const name of ['202609130001_auth_and_stores.sql', '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql', '202609150002_terminal_device_sessions.sql',
  '202609160001_customers_and_sale_attachment.sql', '202609170001_change_feed_product_entity.sql',
  '202609170002_cart_discounts.sql', '202609180001_terminal_name_uniqueness.sql',
  '202609180002_pos_orders_report_read_access.sql',
  '202609180002_store_business_details.sql', '202609180003_tax_rate_change_feed.sql',
  '202609180004_product_images.sql', '202609180005_refunds.sql']) {
  await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}

const owner = randomUUID(), cashier = randomUUID(), store = randomUUID()
await database.query('insert into auth.users(id) values ($1),($2)', [owner, cashier])
await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture Refund Store','refund-browser',$2)", [store, owner])
await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'owner'),($1,$3,'cashier')", [store, owner, cashier])

const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; release: () => void }> }
let tail = Promise.resolve()
const query = async (sql: string, params?: unknown[]) => {
  const result = await database.query(sql, params)
  return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
}
fixture.query = query
fixture.connect = async () => {
  const previous = tail; let release!: () => void
  tail = new Promise<void>(resolve => { release = resolve }); await previous
  return { query, release }
}

function fixtureToken(userId: string) {
  return `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.fixture`
}
const ownerToken = fixtureToken(owner)
const cashierToken = fixtureToken(cashier)
const ownerUser = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
const cashierUser = { id: cashier, aud: 'authenticated', role: 'authenticated', email: 'cashier@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }

const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3192', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => {
  const auth = req.headers.authorization
  if (auth === `Bearer ${ownerToken}`) { (req as unknown as { fixtureUser: typeof ownerUser }).fixtureUser = ownerUser; next(); return }
  if (auth === `Bearer ${cashierToken}`) { (req as unknown as { fixtureUser: typeof cashierUser }).fixtureUser = cashierUser; next(); return }
  res.sendStatus(401)
})
identity.get('/auth/v1/user', (req, res) => { res.json((req as unknown as { fixtureUser: typeof ownerUser }).fixtureUser) })
identity.get('/rest/v1/store_memberships', (req, res) => {
  const isOwner = (req as unknown as { fixtureUser: typeof ownerUser }).fixtureUser.id === owner
  res.json([{ store_id: store, role: isOwner ? 'owner' : 'cashier', user_id: isOwner ? owner : cashier, active: true, joined_at: new Date().toISOString() }])
})
identity.get('/rest/v1/profiles', (_req, res) => { res.json([{ id: owner, full_name: 'Fixture Owner' }]) })
identity.get('/rest/v1/stores', (req, res) => { const row = { id: store, name: 'Fixture Refund Store', onboarding_completed_at: new Date().toISOString() }; res.json(String(req.headers.accept).includes('vnd.pgrst.object') ? row : [row]) })
const identityServer = identity.listen(3193, '127.0.0.1')

const web = express()
web.use('/api', createApp({ pool: db, origin: 'http://127.0.0.1:3192', supabaseUrl: 'http://127.0.0.1:3193', supabaseKey: 'fixture', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile('index.html', { root: join(root, 'apps/web/dist') }) })
const webServer = web.listen(3192, '127.0.0.1')

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
    cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3193',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'fixture', VITE_API_URL: '/api' }, stdio: 'inherit', windowsHide: true })
  assert.equal(await new Promise<number | null>(resolve => build.on('exit', resolve)), 0)
  await mkdir(pictures, { recursive: true })
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }))
  }, { token: ownerToken, user: ownerUser })
  const page = await context.newPage()
  page.on('dialog', dialog => void dialog.accept())
  page.on('response', response => { if (response.status() >= 400 && response.status() !== 401 && response.status() !== 409) console.log('API response:', response.status(), new URL(response.url()).pathname) })

  // 1. Complete a real cash sale as the owner (no terminal provisioned — falls back to the
  //    LOCAL- receipt prefix, same as any owner selling straight from the web app).
  await page.goto('http://127.0.0.1:3192/register')
  await expect(page.getByRole('heading', { name: 'Current Sale' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ceramic Mug', exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Ceramic Mug', exact: false }).click()
  await page.getByRole('link', { name: 'Proceed to payment' }).click()
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
  await page.getByLabel('Amount received').fill('20.00')
  await page.getByRole('button', { name: 'Complete sale' }).click()
  await expect(page.getByRole('heading', { name: 'Receipt.' })).toBeVisible()
  const orderId = new URL(page.url()).pathname.split('/').pop()!
  assert.ok(orderId && orderId.length > 10, `Expected an order id in the URL, got: ${page.url()}`)

  // Wait for the background push to land so the order is 'synced' server-side — the refund button
  // only appears once sync_status is 'synced' (a refund reverses a server-accepted sale).
  await expect(page.getByText('Synced')).toBeVisible({ timeout: 30_000 })
  const stockBefore = await database.query<{ current_stock: number }>(
    "select current_stock from public.pos_stock s join public.pos_products p on p.id=s.product_id where s.store_id=$1 and p.sku='MUG-001'", [store])
  const stockBeforeRefund = stockBefore.rows[0].current_stock

  // 2. Negative check first: a cashier cannot refund. Hit the API directly with the cashier's
  //    token (there is no UI path for this — the button is owner/manager only — so this checks
  //    the server-side gate itself, not just that the button is hidden).
  const cashierAttempt = await fetch(`http://127.0.0.1:3192/api/orders/${orderId}/refund`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}`, Origin: 'http://127.0.0.1:3192' },
    body: JSON.stringify({ store_id: store }),
  })
  assert.equal(cashierAttempt.status, 403, 'A cashier must not be able to refund an order')

  // 3. Refund as the owner through the actual Receipt screen UI.
  await expect(page.getByRole('button', { name: 'Refund this receipt' })).toBeVisible()
  await page.screenshot({ path: `${pictures}receipt-before-refund-1440.png`, fullPage: true })
  const refundResponse = page.waitForResponse(response => response.url().includes('/refund') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Refund this receipt' }).click()
  const response = await refundResponse
  assert.equal(response.status(), 201, 'POST /orders/:id/refund should return 201 on success')
  await expect(page.getByText('Refunded', { exact: false })).toBeVisible()
  await page.screenshot({ path: `${pictures}receipt-after-refund-1440.png`, fullPage: true })

  // 4. Verify the transaction actually committed: pos_refunds, pos_refund_items, reversed stock,
  //    a 'refund' inventory movement, and 'refund' + 'stock' change_feed entries.
  const refundRow = await database.query<{ amount_cents: string }>('select amount_cents::text as amount_cents from public.pos_refunds where store_id=$1 and order_id=$2', [store, orderId])
  assert.equal(refundRow.rows.length, 1, 'A pos_refunds row should exist for this order')
  assert.equal(refundRow.rows[0].amount_cents, '1944', 'Refund amount should equal the order total ($18.00 + 8% tax = $19.44)')
  const refundItems = await database.query('select 1 from public.pos_refund_items ri join public.pos_refunds r on r.id=ri.refund_id where r.store_id=$1 and r.order_id=$2', [store, orderId])
  assert.equal(refundItems.rowCount, 1, 'One pos_refund_items row should exist for the single line sold')
  const stockAfter = await database.query<{ current_stock: number }>(
    "select current_stock from public.pos_stock s join public.pos_products p on p.id=s.product_id where s.store_id=$1 and p.sku='MUG-001'", [store])
  assert.equal(stockAfter.rows[0].current_stock, stockBeforeRefund + 1, 'Refunding one unit should restore one unit of stock')
  const movement = await database.query("select 1 from public.pos_inventory_movements where store_id=$1 and order_id=$2 and reason='refund'", [store, orderId])
  assert.equal(movement.rowCount, 1, 'A refund inventory movement should be recorded')
  const feed = await database.query<{ entity_type: string }>('select entity_type from public.pos_change_feed where store_id=$1 order by position desc limit 2', [store])
  assert.deepEqual(feed.rows.map(row => row.entity_type).sort(), ['refund', 'stock'], 'The refund should write both a refund and a stock change_feed entry')

  // 5. The refunded state must persist locally across a reload (it's written to the local order
  //    record, not held in transient component state) — reload and confirm the button is gone and
  //    the "Refunded" banner shows immediately, with no new request needed to know that.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Receipt.' })).toBeVisible()
  await expect(page.getByText('Refunded', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refund this receipt' })).toHaveCount(0)

  // 6. The server-side guard must independently reject a second refund of the same order as a
  //    conflict, not silently accept it twice — simulated as a direct API call (e.g. a second
  //    device that doesn't yet know locally that this order was refunded).
  const secondAttempt = await fetch(`http://127.0.0.1:3192/api/orders/${orderId}/refund`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}`, Origin: 'http://127.0.0.1:3192' },
    body: JSON.stringify({ store_id: store }),
  })
  assert.equal(secondAttempt.status, 409, 'A second refund of the same order should be rejected as a conflict')
  const refundCount = await database.query('select 1 from public.pos_refunds where store_id=$1 and order_id=$2', [store, orderId])
  assert.equal(refundCount.rowCount, 1, 'Exactly one refund row must exist no matter how many times refund is attempted')

  console.log('PASS: owner refunded a real completed sale through the Receipt screen; stock, pos_refunds/pos_refund_items and the change feed all committed correctly; a cashier was rejected server-side; a duplicate refund was rejected as a conflict, not double-applied.')
} finally {
  await browser?.close(); webServer.closeAllConnections(); identityServer.closeAllConnections(); webServer.close(); identityServer.close(); await database.close(); await db.end()
}
