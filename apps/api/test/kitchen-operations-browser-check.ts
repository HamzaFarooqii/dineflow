// Real Kitchen Display + Ticket History screens, against the real API (createApp) backed by an
// in-memory Postgres (PGlite) replaying every migration this branch actually has, and a fixture
// Supabase identity server standing in for auth/REST. Same harness shape as
// apps/api/test/browser-check.ts and apps/api/test/open-checks-browser-check.ts -- including the
// db.js singleton patch that open-checks-browser-check.ts discovered is required for every
// owner-web (non-terminal) route, not just open-checks. No live account or store data is used.
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
const screenshots = root + 'docs/qa/a3'
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
// drifts from the app's real schema/UI expectations (open-checks-browser-check.ts hit this first).
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
  '202609280002_delivery_operations.sql', '202609280002_reservations_waitlist.sql',
  '202609280003_purchasing_vendors.sql', '202609280004_customer_profile_tools.sql',
  '202609280004_staff_breaks_and_corrections.sql', '202609290001_kitchen_operations_depth.sql',
]) {
  await db.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}

const owner = randomUUID(), store = randomUUID(), taxRate = randomUUID(), station = randomUUID()
const productA = randomUUID(), productB = randomUUID(), productC = randomUUID()
const orderActive = randomUUID(), orderHistory = randomUUID()
const ticketActive = randomUUID(), ticketHistory = randomUUID()
const itemAppetizer = randomUUID(), itemMain = randomUUID(), itemHistory = randomUUID()
const orderItemAppetizer = randomUUID(), orderItemMain = randomUUID(), orderItemHistory = randomUUID()
await db.query('insert into auth.users(id) values($1)', [owner])
await db.query("insert into public.stores(id,name,code,created_by,timezone,currency) values($1,'Demo General','kitchen-ops-qa',$2,'UTC','USD')", [store, owner])
await db.query("insert into public.store_memberships(store_id,user_id,role) values($1,$2,'owner')", [store, owner])
await db.query("insert into public.pos_tax_rates(id,store_id,name,rate_bps) values($1,$2,'Standard',1000)", [taxRate, store])
await db.query("insert into public.kitchen_stations(id,store_id,name) values($1,$2,'Grill')", [station, store])
for (const [id, name, sku] of [[productA, 'Garlic Bread', 'APP-1'], [productB, 'Grilled Steak', 'MAIN-1'], [productC, 'Iced Tea', 'BEV-1']] as const) {
  await db.query('insert into public.pos_products(id,store_id,sku,name,unit_price_cents,tax_rate_id) values($1,$2,$3,$4,1000,$5)', [id, store, sku, name, taxRate])
}

// One active order/ticket with two items: a still-queued appetizer (course-fire bar) and an
// already-firing main course sitting at 83% of its own prep-time target (SLA "Due soon").
await db.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,subtotal_cents,tax_cents,total_cents,client_generated_at)
  values($1,$2,'KOPS-000001','USD','Demo General','UTC',2000,200,2200,now())`, [orderActive, store])
await db.query('insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,tax_cents,total_cents,discount_applied_cents,taxable_cents) values($1,$2,$3,$4,$5,$6,1000,1000,1,1,1000,100,1100,0,1000)',
  [orderItemAppetizer, store, orderActive, productA, 'Garlic Bread', 'APP-1'])
await db.query('insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,tax_cents,total_cents,discount_applied_cents,taxable_cents) values($1,$2,$3,$4,$5,$6,1000,1000,1,1,1000,100,1100,0,1000)',
  [orderItemMain, store, orderActive, productB, 'Grilled Steak', 'MAIN-1'])
await db.query("insert into public.kitchen_tickets(id,store_id,order_id,status) values($1,$2,$3,'preparing')", [ticketActive, store, orderActive])
await db.query("insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,status,course,prep_time_target_seconds) values($1,$2,$3,$4,'queued','appetizer',600)",
  [itemAppetizer, store, ticketActive, orderItemAppetizer])
await db.query("insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,station_id,status,course,prep_time_target_seconds,fired_at) values($1,$2,$3,$4,$5,'preparing','main',600,now() - interval '500 seconds')",
  [itemMain, store, ticketActive, orderItemMain, station])

// A second, single-item order/ticket already "ready" and past its SLA target (late) -- serving
// its one item completes the whole ticket, which should then disappear from the active board and
// surface in ticket history.
await db.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,subtotal_cents,tax_cents,total_cents,client_generated_at)
  values($1,$2,'KOPS-000002','USD','Demo General','UTC',1000,100,1100,now())`, [orderHistory, store])
await db.query('insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,tax_cents,total_cents,discount_applied_cents,taxable_cents) values($1,$2,$3,$4,$5,$6,1000,1000,1,1,1000,100,1100,0,1000)',
  [orderItemHistory, store, orderHistory, productC, 'Iced Tea', 'BEV-1'])
await db.query("insert into public.kitchen_tickets(id,store_id,order_id,status) values($1,$2,$3,'ready')", [ticketHistory, store, orderHistory])
await db.query("insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,status,prep_time_target_seconds,fired_at,ready_at) values($1,$2,$3,$4,'ready',300,now() - interval '800 seconds',now() - interval '100 seconds')",
  [itemHistory, store, ticketHistory, orderItemHistory])

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
// apps/api/src/routes/auth.ts's requireStoreMember (and every owner-web router: kitchen, orders,
// catalog, floor, open-checks, ...) queries the module-level `db` singleton from src/db.js
// directly -- it never sees createApp()'s injected `pool` option, which only the terminal-auth
// router uses. db.js throws at import time unless DATABASE_URL is already set, so set a
// syntactically valid (never dialed) one before importing it, then overwrite its query/connect
// with the same PGlite queue used above, before dynamically importing app.js so every router
// downstream shares it.
process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:1/fixture'
const realDb = (await import('../src/db.js')).db
realDb.query = runQueued as typeof realDb.query
realDb.connect = pool.connect as unknown as typeof realDb.connect
const { createApp } = await import('../src/app.js')
const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
const accessToken = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.test-signature`
const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3186', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${accessToken}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(user) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner' }]) })
identity.get('/rest/v1/stores', (req, res) => {
  const single = String(req.headers.accept ?? '').includes('vnd.pgrst.object')
  const row = { id: store, name: 'Demo General', onboarding_completed_at: new Date().toISOString() }
  res.json(single ? row : [row])
})
const identityServer = identity.listen(3187, '127.0.0.1')
// requireStoreMember (apps/api/src/routes/auth.ts) verifies the bearer token against these two
// env vars directly, independent of createApp()'s own options -- must point at the same fixture
// identity server or every owner-web (non-terminal) route 401s.
process.env.SUPABASE_URL = 'http://127.0.0.1:3187'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable'
const web = express()
web.use('/api', createApp({ pool, origin: 'http://127.0.0.1:3186', supabaseUrl: 'http://127.0.0.1:3187', supabaseKey: 'test-publishable', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile(root + 'apps/web/dist/index.html') })
const server = web.listen(3186, '127.0.0.1')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], { cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3187', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable', VITE_API_URL: '/api' }, stdio: 'inherit', windowsHide: true })
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

  // --- Kitchen board: both tickets visible, course-fire bar, SLA badges ---
  await page.goto('http://127.0.0.1:3186/kitchen', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Kitchen' })).toBeVisible({ timeout: 30_000 })
  const activeTicket = page.locator('.kitchen-ticket-card', { hasText: 'KOPS-000001' })
  const historyTicket = page.locator('.kitchen-ticket-card', { hasText: 'KOPS-000002' })
  await expect(activeTicket).toBeVisible({ timeout: 15_000 })
  await expect(historyTicket).toBeVisible()
  await expect(activeTicket.getByText('Due soon')).toBeVisible() // Grilled Steak at 500s of a 600s target
  await expect(historyTicket.getByText('Late')).toBeVisible() // Iced Tea at 800s of a 300s target
  const fireAppetizer = activeTicket.getByRole('button', { name: 'Fire Appetizer' })
  await expect(fireAppetizer).toBeVisible()
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Kitchen board overflow at ${width}px`)
    await page.screenshot({ path: screenshots + `/kitchen-board-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })

  // --- Fire the queued appetizer course; its course-fire bar disappears once nothing is queued ---
  await fireAppetizer.click()
  await expect(fireAppetizer).toBeHidden({ timeout: 15_000 })
  await expect(activeTicket.getByText('Garlic Bread')).toBeVisible()

  // --- Advance the main course to ready, then serve the single-item ticket to close it out ---
  await activeTicket.locator('li', { hasText: 'Grilled Steak' }).getByRole('button', { name: 'Mark ready' }).click()
  await expect(activeTicket.locator('li', { hasText: 'Grilled Steak' }).getByRole('button', { name: 'Serve' })).toBeVisible({ timeout: 15_000 })
  await historyTicket.getByRole('button', { name: 'Serve' }).click()
  await expect(historyTicket).toBeHidden({ timeout: 15_000 })

  // --- Ticket history: the served ticket now appears there instead ---
  await page.getByRole('link', { name: 'Ticket history' }).click()
  await expect(page.getByRole('heading', { name: 'Ticket history.' })).toBeVisible({ timeout: 15_000 })
  const servedCard = page.locator('.kitchen-ticket-card', { hasText: 'KOPS-000002' })
  await expect(servedCard).toBeVisible({ timeout: 15_000 })
  await expect(servedCard.getByText('Served', { exact: true }).first()).toBeVisible()
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Kitchen history overflow at ${width}px`)
    await page.screenshot({ path: screenshots + `/kitchen-history-${width}.png`, fullPage: true })
  }

  assert.deepEqual(errors, [])
  console.log('PASS: kitchen board shows course-fire bar + SLA badges, firing a course and advancing items closes a ticket out to history; screenshots at 390/768/1440px.')
} finally {
  await browser?.close()
  server.close()
  identityServer.close()
}
