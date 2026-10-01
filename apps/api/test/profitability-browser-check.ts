// Day 2 (profitability): real Reports > Profitability screen, against the real API (createApp)
// backed by an in-memory Postgres (PGlite) replaying every committed migration this branch
// actually has, and a fixture Supabase identity server standing in for auth/REST. Same harness
// shape as apps/api/test/open-checks-browser-check.ts (an owner/manager, non-terminal flow). No
// live account or store data is used.
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
const screenshots = root + 'docs/qa/profitability'
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
for (const name of [
  '202609130001_auth_and_stores.sql', '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql', '202609150002_terminal_device_sessions.sql',
  '202609150003_team_profile_visibility.sql', '202609160001_customers_and_sale_attachment.sql',
  '202609170001_change_feed_product_entity.sql', '202609170002_cart_discounts.sql',
  '202609180001_terminal_name_uniqueness.sql', '202609180002_pos_orders_report_read_access.sql',
  '202609180002_store_business_details.sql', '202609180003_tax_rate_change_feed.sql',
  '202609180004_product_images.sql',
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
  '202609280002_open_checks.sql', '202609280003_split_settlement.sql',
  '202609280004_refund_settlement_integrity.sql', '202609290002_sellable_combos.sql',
  '202609300001_qr_table_ordering.sql',
]) {
  await db.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}
const owner = randomUUID(), store = randomUUID(), taxRate = randomUUID()
const product = randomUUID(), unit = randomUUID(), ingredient = randomUUID(), recipe = randomUUID()
await db.query('insert into auth.users(id) values($1)', [owner])
await db.query("insert into public.stores(id,name,code,created_by,timezone,currency) values($1,'Demo General','profitability-qa',$2,'UTC','USD')", [store, owner])
await db.query("insert into public.store_memberships(store_id,user_id,role) values($1,$2,'owner')", [store, owner])
await db.query("insert into public.pos_tax_rates(id,store_id,name,rate_bps) values($1,$2,'Standard',1000)", [taxRate, store])
await db.query("insert into public.pos_products(id,store_id,sku,name,unit_price_cents,tax_rate_id) values($1,$2,'BURGER-1','Cheeseburger',1000,$3)", [product, store, taxRate])
await db.query('insert into public.pos_stock(store_id,product_id,current_stock) values($1,$2,20)', [store, product])
// A real, complete recipe so cost of goods shows up as non-zero: one "each" ingredient at $3.00,
// yield 1, so portion cost is exactly 300 cents.
await db.query(`insert into public.units(id,store_id,name,abbreviation,kind,factor_to_base) values($1,$2,'Each','ea','count',1)`, [unit, store])
await db.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values($1,$2,'Bun & patty',$3,300,100)`, [ingredient, store, unit])
await db.query(`insert into public.recipes(id,store_id,product_id,yield_quantity,yield_unit_id) values($1,$2,$3,1,$4)`, [recipe, store, product, unit])
await db.query(`insert into public.recipe_ingredients(id,store_id,recipe_id,ingredient_id,unit_id,quantity) values($1,$2,$3,$4,$5,1)`, [randomUUID(), store, recipe, ingredient, unit])

// One sale, today (store timezone is UTC): 2 units at $10.00, a 10% line discount, 10% tax, no
// service charge, paid in cash with a $1.00 tip. subtotal 2000, discount 200, taxable 1800, tax
// 180, total 1980 + 100 tip tendered.
const now = new Date().toISOString()
const orderId = randomUUID()
await db.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
    subtotal_cents,discount_cents,tax_cents,service_charge_cents,total_cents,catalog_version,client_generated_at,order_type)
  values($1,$2,'R-0001','USD','Demo General','UTC',2000,200,180,0,1980,1,$3,'dine_in')`, [orderId, store, now])
await db.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
    snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,discount_kind,discount_value,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
  values($1,$2,$3,$4,'Cheeseburger','BURGER-1',1000,1000,1,2,'percent',1000,2000,200,1800,180,1980)`, [randomUUID(), store, orderId, product])
await db.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,tip_cents,client_generated_at)
  values($1,$2,$3,'cash',1980,2080,0,100,$4)`, [randomUUID(), store, orderId, now])

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
process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:1/fixture'
const realDb = (await import('../src/db.js')).db
realDb.query = runQueued as typeof realDb.query
realDb.connect = pool.connect as unknown as typeof realDb.connect
const { createApp } = await import('../src/app.js')
const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
const accessToken = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.test-signature`
const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3185', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${accessToken}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(user) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner' }]) })
identity.get('/rest/v1/stores', (req, res) => {
  const single = String(req.headers.accept ?? '').includes('vnd.pgrst.object')
  const row = { id: store, name: 'Demo General', onboarding_completed_at: new Date().toISOString() }
  res.json(single ? row : [row])
})
const identityServer = identity.listen(3186, '127.0.0.1')
process.env.SUPABASE_URL = 'http://127.0.0.1:3186'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable'
const web = express()
web.use('/api', createApp({ pool, origin: 'http://127.0.0.1:3185', supabaseUrl: 'http://127.0.0.1:3186', supabaseKey: 'test-publishable', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile(root + 'apps/web/dist/index.html') })
const server = web.listen(3185, '127.0.0.1')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], { cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3186', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable', VITE_API_URL: '/api' }, stdio: 'inherit', windowsHide: true })
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
  page.on('response', response => { if (response.status() >= 400) console.log('Browser response:', response.request().method(), response.status(), new URL(response.url()).pathname + new URL(response.url()).search) })

  // Reports' useFinancialReport needs a local Dexie store-config snapshot; visiting Register
  // first bootstraps it via loadCatalog(), the same real path a brand-new browser takes, rather
  // than relying on Reports' own best-effort self-heal (which depends on this already existing).
  await page.goto('http://127.0.0.1:3185/register', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: 'Cheeseburger', exact: false }).first()).toBeVisible({ timeout: 30_000 })

  await page.goto('http://127.0.0.1:3185/reports', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('tab', { name: 'Profitability' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: 'Profitability' }).click()

  // Net merchandise revenue: 2000 gross - 200 discount - 0 refund = 1800 = $18.00.
  await expect(page.getByText('$18.00', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  // Cost of goods: 2 units x $3.00 portion cost = $6.00.
  await expect(page.getByText('$6.00', { exact: true }).first()).toBeVisible()
  // Gross profit: 1800 - 600 = 1200 = $12.00.
  await expect(page.getByText('$12.00', { exact: true }).first()).toBeVisible()
  // Tax/tips/service-charge reference line (not part of gross profit above).
  await expect(page.getByText(/Tax \$1\.80, tips \$1\.00/)).toBeVisible()

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Profitability report overflow at ${width}px`)
    await page.screenshot({ path: screenshots + `/profitability-${width}.png`, fullPage: true })
  }

  assert.deepEqual(errors, [])
  console.log('PASS: Profitability tab reconciles gross sales -> discount -> net revenue -> cost of goods -> gross profit through the real rendered UI; tax/tips/service charge shown separately; screenshots at 390/768/1440px.')
} finally {
  await browser?.close()
  server.close()
  identityServer.close()
}
