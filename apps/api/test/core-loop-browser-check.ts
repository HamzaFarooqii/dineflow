// Hamza's plan item 7: a real click-through of the core POS loop (dine-in order -> kitchen ->
// served -> table freed -> payment recorded), end to end, in an actual rendered browser -- not a
// simulation of one. There is no interactive browser tool available in the coding-agent session
// that wrote this, so this script IS the click-through: it launches real headless Chromium
// (Playwright, already a dependency here -- see browser-check.ts) against the real built web app,
// the real Express API, and a local Postgres fixture (PGlite) replaying every committed
// migration. Only Supabase's identity/REST boundary is replaced by a local fixture, exactly like
// browser-check.ts, and for the same reason: the owner-side provisioning step
// (/devices/provision) genuinely requires a verified owner/manager session, so there is no way to
// reach a working terminal without going through it once, same as a real restaurant would on day
// one.
import assert from 'node:assert/strict'
import { readFile, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { chromium, expect as baseExpect } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const expect = baseExpect.configure({ timeout: 20_000 })
// Every route outside terminalAuthRouter (floor, catalog, kitchen, shifts, orders...) imports the
// db singleton from src/db.js directly rather than taking a pool through createApp()'s options --
// so unlike browser-check.ts (which only ever exercises terminalAuthRouter's own options.pool),
// this script must monkey-patch that real singleton too, same as every other PGlite-backed test
// in this repo, and pass that SAME object as createApp()'s pool so both code paths hit one fixture.
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
const { db: pgDb } = await import('../src/db.js')
const { createApp } = await import('../src/app.js')
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
// Replay every committed migration, in order -- the most faithful reproduction of the real
// develop schema available without a live Postgres, and the only way to be sure this script is
// exercising today's app, not a hand-picked subset that happens to be convenient. The one
// exceptions:
// - 202609180004_product_images.sql provisions a real Supabase Storage bucket
//   (storage.buckets/storage.objects), a managed schema this local fixture never creates (same
//   reason every other PGlite-backed test in this repo skips it too) -- product photos are
//   unrelated to the core POS loop this script proves.
// - 202609180006_stores_country_column.sql is a fix-up written against a specific PRODUCTION
//   database's drifted state (its own comment: that deployed DB ended up with an "address" column
//   and an unplanned "locale" column instead of "country", missing both check constraints) --
//   but the migration file it patches, 202609180002_store_business_details.sql, already adds
//   country correctly as committed today. Replaying every migration from a clean database (this
//   script's whole point) hits the fix-up's already-satisfied precondition and fails with
//   "column already exists" -- a genuine migration-history inconsistency, not something to work
//   around silently. Reported to the user rather than the fix-up's target state (address/country
//   with both constraints) not mattering here: it already holds via 202609180002.
const migrationFiles = (await readdir(root + 'supabase/migrations'))
  .filter(name => name.endsWith('.sql') && !['202609180004_product_images.sql', '202609180006_stores_country_column.sql'].includes(name))
  .sort()
for (const name of migrationFiles) {
  await db.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}
// The pos_products.image_url column (normally added by 202609180004_product_images.sql, skipped
// above) is a real column the catalog snapshot query selects -- add it directly so that query
// matches the real schema, without the Storage-bucket statements this fixture can't satisfy.
await db.exec(`alter table public.pos_products add column image_url text,
  add constraint pos_products_image_url_length check (image_url is null or char_length(image_url) <= 2048);`)

const owner = randomUUID(), store = randomUUID()
const station = randomUUID(), area = randomUUID(), table = randomUUID(), product = randomUUID()
await db.query('insert into auth.users(id) values($1)', [owner])
await db.query("insert into public.stores(id,name,code,created_by) values($1,'Demo General','core-loop-browser',$2)", [store, owner])
await db.query("insert into public.store_memberships(store_id,user_id,role) values($1,$2,'owner')", [store, owner])
await db.query("insert into public.kitchen_stations(id,store_id,name) values ($1,$2,'Hot line')", [station, store])
await db.query("insert into public.floor_areas(id,store_id,name) values ($1,$2,'Main room')", [area, store])
await db.query("insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats,status) values ($1,$2,$3,'T1',4,'available')", [table, store, area])
await db.query("insert into public.pos_products(id,store_id,sku,name,unit_price_cents,station_id) values ($1,$2,'CL-1','Grilled Chicken',1450,$3)", [product, store, station])
await db.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,20)', [store, product])

let tail = Promise.resolve()
const query = async (sql: string, values?: unknown[]) => {
  const result = await db.query(sql, values)
  return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
}
const fixture = pgDb as unknown as { query: typeof query; connect: () => Promise<{ query: typeof query; release: () => void }> }
fixture.query = query
fixture.connect = async () => {
  const previous = tail; let release!: () => void
  tail = new Promise<void>(resolve => { release = resolve }); await previous
  return { query, release }
}
const pool = pgDb as unknown as Pool

const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
const accessToken = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.test-signature`
const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3182', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${accessToken}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(user) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner' }]) })
identity.get('/rest/v1/profiles', (_req, res) => { res.json([{ id: owner, full_name: 'Fixture Owner' }]) })
identity.get('/rest/v1/stores', (req, res) => {
  const single = String(req.headers.accept ?? '').includes('vnd.pgrst.object')
  const row = { id: store, name: 'Demo General', onboarding_completed_at: new Date().toISOString() }
  res.json(single ? row : [row])
})
const identityServer = identity.listen(3183, '127.0.0.1')
const web = express()
web.use('/api', createApp({ pool, origin: 'http://127.0.0.1:3182', supabaseUrl: 'http://127.0.0.1:3183', supabaseKey: 'test-publishable', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile(root + 'apps/web/dist/index.html') })
const server = web.listen(3182, '127.0.0.1')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], { cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3183', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable', VITE_API_URL: 'http://127.0.0.1:3182/api' }, stdio: 'inherit', windowsHide: true })
  assert.equal(await new Promise<number | null>(resolve => build.on('exit', resolve)), 0)
  try {
    browser = await chromium.launch({ headless: true })
  } catch (reason) {
    if (process.platform !== 'win32') throw reason
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.addInitScript(({ accessToken, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: accessToken, refresh_token: 'test-owner-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }))
  }, { accessToken, user })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 400) console.log('Browser response:', response.status(), new URL(response.url()).pathname) })
  const screenshots = root + 'docs/core-loop-screenshots/'
  await mkdir(screenshots, { recursive: true })
  let shot = 0
  const snap = async (name: string) => { await page.screenshot({ path: `${screenshots}${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true }) }

  // --- Provisioning: same real UI path as browser-check.ts (owner adds staff, provisions this
  // browser as a terminal, then signs in as that staff member with a PIN). Reproduced here rather
  // than skipped, because there is no way to reach a working terminal without it. ---
  await page.goto('http://127.0.0.1:3182/settings/employees', { waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('Staff name')).toBeEnabled({ timeout: 30_000 })
  const pin = String(100000 + Math.floor(Math.random() * 900000))
  await page.getByLabel('Staff name').fill('Alex Rivera')
  await page.getByLabel('PIN', { exact: true }).fill(pin)
  await page.getByRole('button', { name: 'Add staff member' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: 'Alex Rivera' }).getByRole('button', { name: 'Edit' })).toBeVisible()

  await page.goto('http://127.0.0.1:3182/settings/terminals', { waitUntil: 'domcontentloaded' })
  await page.getByLabel('Terminal name').fill('Front counter')
  await page.getByRole('button', { name: 'Provision this browser' }).click()
  await expect(page.getByText('This browser is provisioned.', { exact: false })).toBeVisible()

  await page.getByRole('link', { name: 'Cashier sign in' }).click()
  await expect(page.getByRole('combobox', { name: 'Select staff member', exact: true })).toBeEnabled()
  await page.getByRole('combobox', { name: 'Select staff member', exact: true }).selectOption({ index: 1 })
  await page.getByLabel('PIN', { exact: true }).fill(pin)
  await page.getByRole('button', { name: 'Unlock terminal' }).click()
  await expect(page).toHaveURL('http://127.0.0.1:3182/pos/register')
  await snap('terminal-unlocked')
  console.log('STEP 1/6 PASS: terminal provisioned, staff added, PIN unlock reaches the register.')

  // --- Floor: seat the pre-seeded table, then start its order. ---
  await page.goto('http://127.0.0.1:3182/pos/floor', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.table-card', { hasText: 'T1' })).toBeVisible({ timeout: 20_000 })
  await page.locator('.table-card', { hasText: 'T1' }).click()
  await expect(page.getByRole('button', { name: 'Seat' })).toBeEnabled()
  await page.getByRole('button', { name: 'Seat' }).click()
  await expect(page.getByRole('dialog').getByText('Seated', { exact: true })).toBeVisible()
  await snap('table-seated')
  await page.locator('.table-card', { hasText: 'T1' }).click()
  await expect(page.getByRole('button', { name: 'Add order' })).toBeEnabled()
  await page.getByRole('button', { name: 'Add order' }).click()
  await expect(page).toHaveURL('http://127.0.0.1:3182/pos/register')
  console.log('STEP 2/6 PASS: table seated and its order started from the real Floor screen.')

  // --- Register: add the seeded dish, attach a guest (required on every terminal check), and
  // proceed to payment. ---
  await expect(page.getByRole('button', { name: /Grilled Chicken/ })).toBeEnabled({ timeout: 20_000 })
  await page.getByRole('button', { name: /Grilled Chicken/ }).click()
  await expect(page.getByText('Open check')).toBeVisible()
  await page.getByRole('button', { name: 'Select or add a guest (required)' }).click()
  await page.getByLabel('Guest name').fill('Priya Sharma')
  await page.getByRole('button', { name: 'Save guest' }).click()
  await expect(page.getByText('Priya Sharma')).toBeVisible()
  await snap('register-cart')
  await expect(page.getByRole('link', { name: /Proceed to payment/ })).toBeEnabled()
  await page.getByRole('link', { name: /Proceed to payment/ }).click()
  await expect(page).toHaveURL('http://127.0.0.1:3182/pos/payment')
  console.log('STEP 3/6 PASS: dish added to the cart, guest attached, proceeded to payment.')

  // --- Payment: cash, exact amount, close the check. ---
  await page.getByRole('button', { name: 'Cash' }).click()
  await page.getByRole('button', { name: 'Exact amount' }).click()
  await expect(page.getByRole('button', { name: 'Close check' })).toBeEnabled()
  await page.getByRole('button', { name: 'Close check' }).click()
  await expect(page).toHaveURL(/\/pos\/orders\//, { timeout: 20_000 })
  await snap('receipt')
  console.log('STEP 4/6 PASS: payment recorded, receipt reached.')

  // --- Kitchen: checkout inserts kitchen_ticket_items straight into 'preparing' (fired_at=now()),
  // never 'queued' -- see orders.ts's own comment: "'queued' stays a valid state ... for any
  // future [manual ticket creation] step" that doesn't exist yet. So there is no "Fire" button to
  // click here; the real next actions are Mark ready, then Serve. (Discovered by this script:
  // the first version of it assumed Fire was always the first step and timed out here.) ---
  await page.goto('http://127.0.0.1:3182/pos/kitchen', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Grilled Chicken', { exact: false })).toBeVisible({ timeout: 20_000 })
  await snap('kitchen-preparing')
  await expect(page.getByRole('button', { name: 'Mark ready' })).toBeEnabled()
  await page.getByRole('button', { name: 'Mark ready' }).click()
  await expect(page.getByRole('button', { name: 'Serve' })).toBeEnabled()
  await page.getByRole('button', { name: 'Serve' }).click()
  await expect(page.getByText('Grilled Chicken', { exact: false })).toHaveCount(0, { timeout: 20_000 })
  console.log('STEP 5/6 PASS: kitchen ticket marked ready and served (checkout fires items straight to preparing).')

  // --- Floor again: confirm serving the last item auto-freed the table forward through its real
  // lifecycle, ending back at Available -- the "table freed" half of the loop nothing else in
  // this session's automated tests exercises through the real screens. ---
  await page.goto('http://127.0.0.1:3182/pos/floor', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.table-card', { hasText: 'T1' })).toContainText('Food Served', { timeout: 20_000 })
  await snap('table-served')
  await page.locator('.table-card', { hasText: 'T1' }).click()
  await page.getByRole('button', { name: 'Bill', exact: true }).click()
  await expect(page.getByRole('dialog').getByText('Bill Requested', { exact: true })).toBeVisible()
  await page.locator('.table-card', { hasText: 'T1' }).click()
  await page.getByRole('button', { name: 'Bill settled' }).click()
  await expect(page.getByRole('dialog').getByText('Needs Cleaning', { exact: true })).toBeVisible()
  await page.locator('.table-card', { hasText: 'T1' }).click()
  await page.getByRole('button', { name: 'Cleaned' }).click()
  await expect(page.locator('.table-card', { hasText: 'T1' })).toContainText('Available', { timeout: 20_000 })
  await snap('table-available-again')
  console.log('STEP 6/6 PASS: table moved served -> bill requested -> needs cleaning -> available.')

  assert.deepEqual(errors, [], `Uncaught browser errors: ${errors.join(' | ')}`)
  console.log('PASS: the full core POS loop -- seat, order, pay, fire/ready/serve, and free the table -- completed through the real rendered UI, not a simulation. Screenshots saved to docs/core-loop-screenshots/.')
} finally {
  await browser?.close()
  server.closeAllConnections(); identityServer.closeAllConnections(); server.close(); identityServer.close(); await db.close(); await pgDb.end()
}
