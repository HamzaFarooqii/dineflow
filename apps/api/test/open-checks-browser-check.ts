// Real Open Checks screen + Register hold/resume flow, against the real API (createApp) backed by
// an in-memory Postgres (PGlite) replaying every committed migration this branch actually has, and
// a fixture Supabase identity server standing in for auth/REST. Same harness shape as
// apps/api/test/browser-check.ts. No live account or store data is used.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { chromium, expect as baseExpect } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const screenshots = root + 'docs/qa/a1'
await mkdir(screenshots, { recursive: true })
const expect = baseExpect.configure({ timeout: 20_000 })
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';
  create schema storage;
  create table storage.buckets(id text primary key, name text, public boolean);
  create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create function storage.foldername(name text) returns text[] language sql as 'select string_to_array($1, ''/'')';`)
// Replay every migration this branch actually has, in filename order -- a hand-picked subset
// drifts from the app's real schema/UI expectations the moment a route (like catalog snapshot)
// queries a table/column only a later migration adds (learned the hard way: missing
// service_charge.sql/promotions.sql/loyalty_foundation.sql caused snapshot() to 500 on
// service_charge_bps and the reward_rules/promotions tables).
for (const name of [
  '202609130001_auth_and_stores.sql', '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql', '202609150002_terminal_device_sessions.sql',
  '202609150003_team_profile_visibility.sql', '202609160001_customers_and_sale_attachment.sql',
  '202609170001_change_feed_product_entity.sql', '202609170002_cart_discounts.sql',
  '202609180001_terminal_name_uniqueness.sql', '202609180002_pos_orders_report_read_access.sql',
  '202609180002_store_business_details.sql', '202609180003_tax_rate_change_feed.sql',
  '202609180004_product_images.sql',
  // 202609180006_stores_country_column.sql is a fix-up for a live-database drift where the real
  // deployed 202609180002 migration ended up missing `country` -- this repo's copy of
  // 202609180002 already includes it, so replaying both on a fresh database collides.
  '202609180005_refunds.sql',
  '202609190001_audit_log.sql', '202609190001_store_onboarding_status.sql',
  '202609190002_remove_demo_catalog_seed.sql', '202609190003_store_sync_feed_init.sql',
  '202609200001_service_role_only_rls_policies.sql', '202609210001_restaurant_foundation.sql',
  '202609230001_kitchen_display_system.sql', '202609230002_table_waiter_assignment.sql',
  '202609240001_units_and_recipes.sql', '202609240002_ingredient_inventory.sql',
  '202609240003_inventory_audit_columns.sql', '202609240004_inventory_terminal_audit.sql',
  '202609250001_loyalty_foundation.sql', '202609250002_inventory_batch_tracking.sql',
  '202609250003_promotions.sql', '202609260001_unit_conversion.sql',
  '202609260002_staff_roles_and_shifts.sql', '202609260003_service_charge.sql',
  '202609270001_modifiers.sql', '202609280001_inventory_terminal_tenant_fks.sql',
  '202609280002_open_checks.sql', '202609300001_qr_table_ordering.sql',
]) {
  await db.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}
const owner = randomUUID(), store = randomUUID(), area = randomUUID(), table = randomUUID(), product = randomUUID(), taxRate = randomUUID()
await db.query('insert into auth.users(id) values($1)', [owner])
await db.query("insert into public.stores(id,name,code,created_by,timezone,currency) values($1,'Demo General','open-checks-qa',$2,'UTC','USD')", [store, owner])
await db.query("insert into public.store_memberships(store_id,user_id,role) values($1,$2,'owner')", [store, owner])
await db.query("insert into public.pos_tax_rates(id,store_id,name,rate_bps) values($1,$2,'Standard',1000)", [taxRate, store])
await db.query("insert into public.pos_products(id,store_id,sku,name,unit_price_cents,tax_rate_id) values($1,$2,'BURGER-1','Cheeseburger',1200,$3)", [product, store, taxRate])
await db.query('insert into public.pos_stock(store_id,product_id,current_stock) values($1,$2,20)', [store, product])
await db.query('insert into public.floor_areas(id,store_id,name) values($1,$2,$3)', [area, store, 'Main Hall'])
await db.query('insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats,status) values($1,$2,$3,$4,4,$5)', [table, store, area, 'T1', 'seated'])

let tail = Promise.resolve()
async function runQueued(sql: string, values?: unknown[]) {
  const previous = tail; let release!: () => void
  tail = new Promise<void>(resolve => { release = resolve }); await previous
  try {
    const result = await db.query(sql, values)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  } finally { release() }
}
const pool = { async connect() {
  return { query: runQueued, release() {} }
} } as unknown as Pool
// apps/api/src/routes/auth.ts's requireStoreMember (and every owner-web router: open-checks,
// orders, catalog, floor, ...) queries the module-level `db` singleton from src/db.js directly --
// it never sees createApp()'s injected `pool` option, which only the terminal-auth router uses.
// db.js throws at import time unless DATABASE_URL is already set, so set a syntactically valid
// (never dialed) one before importing it, then overwrite its query/connect with the same PGlite
// queue used above, before dynamically importing app.js so every router downstream shares it.
process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:1/fixture'
const realDb = (await import('../src/db.js')).db
realDb.query = runQueued as typeof realDb.query
realDb.connect = pool.connect as unknown as typeof realDb.connect
const { createApp } = await import('../src/app.js')
const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
const accessToken = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.test-signature`
const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3182', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${accessToken}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(user) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner' }]) })
identity.get('/rest/v1/stores', (req, res) => {
  const single = String(req.headers.accept ?? '').includes('vnd.pgrst.object')
  const row = { id: store, name: 'Demo General', onboarding_completed_at: new Date().toISOString() }
  res.json(single ? row : [row])
})
const identityServer = identity.listen(3183, '127.0.0.1')
// requireStoreMember (apps/api/src/routes/auth.ts) verifies the bearer token against these two
// env vars directly, independent of createApp()'s own options -- must point at the same fixture
// identity server or every owner-web (non-terminal) route 401s.
process.env.SUPABASE_URL = 'http://127.0.0.1:3183'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable'
const web = express()
web.use('/api', createApp({ pool, origin: 'http://127.0.0.1:3182', supabaseUrl: 'http://127.0.0.1:3183', supabaseKey: 'test-publishable', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile(root + 'apps/web/dist/index.html') })
const server = web.listen(3182, '127.0.0.1')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], { cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3183', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable', VITE_API_URL: '/api' }, stdio: 'inherit', windowsHide: true })
  assert.equal(await new Promise<number | null>(resolve => build.on('exit', resolve)), 0)
  try { browser = await chromium.launch({ headless: true }) }
  catch (reason) { if (process.platform !== 'win32') throw reason; browser = await chromium.launch({ headless: true, channel: 'chrome' }) }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.addInitScript(({ accessToken, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: accessToken, refresh_token: 'test-owner-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }))
  }, { accessToken, user })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 400) console.log('Browser response:', response.request().method(), response.status(), new URL(response.url()).pathname + new URL(response.url()).search, '| body:', response.request().postData()) })

  // --- Floor: select the seated table and add an order, which sets activeTableId and hands off to Register ---
  await page.goto('http://127.0.0.1:3182/floor', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.table-card', { hasText: 'T1' })).toBeVisible({ timeout: 30_000 })
  await page.locator('.table-card', { hasText: 'T1' }).click()
  await page.getByRole('button', { name: 'Add order', exact: true }).click()
  await expect(page).toHaveURL(/\/register$/, { timeout: 15_000 })

  // --- Register: hold a dine-in check against the seated table ---
  await expect(page.getByRole('button', { name: 'Cheeseburger', exact: false }).first()).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Cheeseburger', exact: false }).first().click()
  await expect(page.locator('b').filter({ hasText: '$12.00' })).toBeVisible()

  // --- A validated owner/manager must attach a guest to the check before holding it ---
  await page.getByRole('button', { name: 'Select or add a guest (required)' }).click()
  await expect(page.getByRole('heading', { name: 'Add guest' })).toBeVisible()
  await page.getByLabel('Guest name').fill('Ayesha Khan')
  await page.getByRole('button', { name: 'Save guest', exact: true }).click()
  await expect(page.getByText('Ayesha Khan')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Hold', exact: true }).click()
  await expect(page.getByText(/Check held for table service/)).toBeVisible({ timeout: 15_000 })

  // --- Open Checks: the held check appears, with its real total ---
  await page.getByRole('link', { name: 'Resume a held check' }).click()
  await expect(page.getByRole('heading', { name: 'Open checks.' })).toBeVisible()
  const checkCard = page.locator('article', { hasText: 'T1' })
  await expect(checkCard).toBeVisible({ timeout: 15_000 })
  await expect(checkCard).toContainText('$13.20') // $12.00 + 10% tax, no service charge configured
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Open Checks overflow at ${width}px`)
    await page.screenshot({ path: screenshots + `/open-checks-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })

  // --- Resume it, confirm the cart is repopulated from the server, then close it ---
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(page).toHaveURL(/\/register$/, { timeout: 15_000 })
  await expect(page.getByText('Cheeseburger')).toBeVisible()
  await page.getByRole('link', { name: 'Proceed to payment' }).click()
  await expect(page).toHaveURL(/\/payment$/)
  await page.getByLabel('Amount received').fill('20.00')
  await page.getByRole('button', { name: 'Close check', exact: true }).click()
  await expect(page).toHaveURL(/\/orders\//, { timeout: 15_000 })
  await expect(page.getByText('Cheeseburger').first()).toBeVisible()

  // --- Floor screen shows the table freed back to dirty after close ---
  await page.goto('http://127.0.0.1:3182/floor', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.table-card', { hasText: 'T1' })).toBeVisible({ timeout: 15_000 })

  assert.deepEqual(errors, [])
  console.log('PASS: hold a dine-in check, see it in Open Checks with a real running total, resume it, close it, table frees on Floor; screenshots at 390/768/1440px.')
} finally {
  await browser?.close()
  server.close()
  identityServer.close()
}
