// Day 2 (Bisma): a real click-through of structured wastage, batch cost visibility and the
// server-verified approval threshold, in headless Chromium against the real built web app, the real
// Express API and a PGlite database replaying every committed migration -- same harness shape as
// core-loop-browser-check.ts (only Supabase's identity/REST boundary is a local fixture).
//
//   npm run test:browser:inventory-wastage          (QA_SCREENSHOT_DIR overrides docs/qa/day2-wastage-costing/)
import assert from 'node:assert/strict'
import { readFile, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { chromium, expect as baseExpect, type Page } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const expect = baseExpect.configure({ timeout: 20_000 })
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
// requireStoreMember reads these from the environment (not from createApp's options), and apps/api/.env
// would otherwise point owner-session calls at the REAL Supabase project. Always aim them at the local fixture.
process.env.SUPABASE_URL = 'http://127.0.0.1:3183'
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable'
const { db: pgDb } = await import('../src/db.js')
const { createApp } = await import('../src/app.js')
const { consumeRecipeIngredients } = await import('../src/routes/kitchen.js')
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
// Same two exclusions, for the same reasons, as core-loop-browser-check.ts. Local-only seed files
// (never committed) are also skipped so a developer's scratch data cannot break the replay.
const migrationFiles = (await readdir(root + 'supabase/migrations'))
  .filter(name => name.endsWith('.sql') && !['202609180004_product_images.sql', '202609180006_stores_country_column.sql'].includes(name) && !name.includes('_seed_'))
  .sort()
for (const name of migrationFiles) await db.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
await db.exec(`alter table public.pos_products add column image_url text,
  add constraint pos_products_image_url_length check (image_url is null or char_length(image_url) <= 2048);`)

const owner = randomUUID(), store = randomUUID()
await db.query('insert into auth.users(id) values($1)', [owner])
await db.query("insert into public.stores(id,name,code,created_by) values($1,'Demo General','wastage-browser',$2)", [store, owner])
await db.query("insert into public.store_memberships(store_id,user_id,role) values($1,$2,'owner')", [store, owner])

// --- Inventory fixture: two batches at different costs, one served dish, one untouched ingredient ---
const kg = randomUUID(), gram = randomUUID(), flour = randomUUID(), saffron = randomUUID()
await db.query(`insert into public.units(id,store_id,name,abbreviation,kind,factor_to_base) values ($1,$2,'Kilogram','kg','mass',1000), ($3,$2,'Gram','g','mass',1)`, [kg, store, gram])
await db.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Flour',$3,70,14), ($4,$2,'Saffron',$3,900,0)`, [flour, store, kg, saffron])
await db.query(`insert into public.ingredient_batches(store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents,expires_at,received_at,reference) values
  ($1,$2,4,4,50,now()+interval '3 days',now()-interval '10 days','INV-1001'), ($1,$2,10,10,80,now()+interval '40 days',now()-interval '2 days','INV-1002')`, [store, flour])
const product = randomUUID(), recipe = randomUUID(), orderId = randomUUID(), orderItem = randomUUID(), ticket = randomUUID(), servedItem = randomUUID()
await db.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'PZ-1','Margherita',1200)`, [product, store])
await db.query(`insert into public.recipes(id,store_id,product_id,yield_quantity,yield_unit_id) values ($1,$2,$3,1,$4)`, [recipe, store, product, kg])
await db.query(`insert into public.recipe_ingredients(store_id,recipe_id,ingredient_id,quantity,unit_id) values ($1,$2,$3,1500,$4)`, [store, recipe, flour, gram]) // 1500 g per sale, ingredient stocked in kg
await db.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,order_type)
  values ($1,$2,'WB-1','USD','Demo General','UTC',1200,0,0,1200,1,now(),'dine_in')`, [orderId, store])
await db.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
  values ($1,$2,$3,$4,'Margherita','PZ-1',1200,0,1,1,1200,0,1200,0,1200)`, [orderItem, store, orderId, product])
await db.query(`insert into public.kitchen_tickets(id,store_id,order_id,status) values ($1,$2,$3,'served')`, [ticket, store, orderId])
await db.query(`insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,status) values ($1,$2,$3,$4,'served')`, [servedItem, store, ticket, orderItem])
// A low threshold (3.00) so a 6 kg wastage (~4.05) lands above it and exercises the verified-PIN path.
await db.query('insert into public.inventory_policies(store_id,wastage_approval_threshold_cents) values ($1,300)', [store])

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
// The served dish consumed 1.5 kg (recipe 1500 g, converted to kg) through the real KDS code path.
await consumeRecipeIngredients({ query } as unknown as import('pg').PoolClient, store, servedItem, product, 1)

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
const stockOf = async (id: string) => Number((await db.query<{ s: string }>('select current_stock::text as s from public.ingredients where id=$1', [id])).rows[0].s)
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], { cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3183', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable', VITE_API_URL: 'http://127.0.0.1:3182/api' }, stdio: 'inherit', windowsHide: true })
  assert.equal(await new Promise<number | null>(resolve => build.on('exit', resolve)), 0)
  try { browser = await chromium.launch({ headless: true }) } catch (reason) {
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
  page.on('response', async response => { if (response.status() >= 400) console.log('Browser response:', response.status(), new URL(response.url()).pathname, (await response.text().catch(() => '')).slice(0, 120)) })
  const shots = process.env.QA_SCREENSHOT_DIR ?? root + 'docs/qa/day2-wastage-costing/'
  await mkdir(shots, { recursive: true })
  const snap = (name: string) => page.screenshot({ path: `${shots}${name}.png`, fullPage: true })
  const base = 'http://127.0.0.1:3182'
  // Overflow of the inventory page's own content only: the terminal's top nav is a pre-existing, intentionally scrollable bar.
  const inventoryOverflow = () => page.evaluate(() => [...document.querySelectorAll('.inventory-page *')].filter(el => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map(el => el.tagName + '.' + String(el.className).slice(0, 50)))

  // --- Provision a terminal and unlock it as a manager (same real UI path as the core-loop check) ---
  await page.goto(`${base}/settings/employees`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('Staff name')).toBeEnabled({ timeout: 30_000 })
  const pin = String(100000 + Math.floor(Math.random() * 900000))
  await page.getByLabel('Staff name').fill('Alex Rivera')
  await page.getByLabel('PIN', { exact: true }).fill(pin)
  await page.getByLabel('Floor role').selectOption('manager')
  await page.getByRole('button', { name: 'Add staff member' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: 'Alex Rivera' }).getByRole('button', { name: 'Edit' })).toBeVisible()
  await page.goto(`${base}/settings/terminals`, { waitUntil: 'domcontentloaded' })
  await page.getByLabel('Terminal name').fill('Front counter')
  await page.getByRole('button', { name: 'Provision this browser' }).click()
  await expect(page.getByText('This browser is provisioned.', { exact: false })).toBeVisible()
  await page.getByRole('link', { name: 'Cashier sign in' }).click()
  await expect(page.getByRole('combobox', { name: 'Select staff member', exact: true })).toBeEnabled()
  await page.getByRole('combobox', { name: 'Select staff member', exact: true }).selectOption({ index: 1 })
  await page.getByLabel('PIN', { exact: true }).fill(pin)
  await page.getByRole('button', { name: 'Unlock terminal' }).click()
  await expect(page).toHaveURL(`${base}/pos/register`)

  const selectIngredient = async (page: Page, name: string) => {
    await page.getByRole('button', { name: new RegExp(name) }).first().click()
  }
  const approveAsManager = async () => {
    const dialog = page.getByRole('dialog', { name: /Manager approval required/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox').selectOption({ label: 'Alex Rivera' })
    await dialog.getByLabel('Manager PIN', { exact: true }).fill(pin)
    await dialog.getByRole('button', { name: 'Approve' }).click()
  }

  // --- 1. Terminal: batch cost visibility + the served dish's costed consumption in the ledger ---
  await page.goto(`${base}/pos/inventory`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: /Flour/ }).first()).toBeVisible({ timeout: 30_000 })
  await selectIngredient(page, 'Flour')
  await expect(page.getByText('BAT-', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('How this was costed')).toBeVisible()
  await expect(page.getByText(/Left on shelf worth/).first()).toBeVisible()
  await snap('01-terminal-detail-1440')
  console.log('STEP 1 PASS: batches show remaining value and draw-down; the served dish shows its batch-costed consumption.')

  // --- 2. Terminal: multi-batch wastage above the threshold is gated behind a server-verified PIN ---
  await page.locator('.inventory-detail-actions').getByRole('button', { name: 'Record Wastage' }).click()
  const form = page.locator('.inventory-wastage-form')
  await expect(form.getByLabel('Category')).toHaveValue('spoiled')
  await form.getByLabel('Quantity Wasted').fill('6')
  await expect(form.getByText(/Estimated cost/)).toBeVisible()
  await expect(form.getByText(/estimate at ingredient cost/)).toHaveCount(0)
  await expect(form.getByText(/PIN will be verified by the server/)).toBeVisible()
  await snap('02-wastage-form-preview-1440')

  // A forged request (client-supplied manager evidence, no token) must be refused at this value.
  const forged = await page.evaluate(async ({ storeId, ingredientId, managerId }) => {
    const response = await fetch(`/api/pos/inventory/ingredients/${ingredientId}/wastage?store_id=${storeId}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation_id: crypto.randomUUID(), quantity: 6, wastage_category: 'spoiled', manager_id: managerId, manager_approved_at: new Date().toISOString() }),
    })
    return { status: response.status, body: await response.json() as { code?: string } }
  }, { storeId: store, ingredientId: flour, managerId: (await db.query<{ id: string }>("select id from public.terminal_employees where role='manager'")).rows[0].id })
  assert.equal(forged.status, 403)
  assert.equal(forged.body.code, 'verified_approval_required')
  assert.equal(await stockOf(flour), 12.5, 'the forged request changed nothing')

  await form.getByRole('button', { name: 'Record Wastage' }).click()
  await approveAsManager()
  await expect(form.getByText(/recorded as spoiled wastage/)).toBeVisible()
  assert.equal(await stockOf(flour), 6.5, '12.5 kg - 6 kg')
  const movement = (await db.query<{ approval_method: string; approval_required: boolean; wastage_category: string; n: number }>(
    `select m.approval_method, m.approval_required, m.wastage_category, (select count(*) from public.stock_movement_allocations a where a.stock_movement_id=m.id)::int as n
     from public.stock_movements m where m.reason='wastage'`)).rows
  assert.deepEqual(movement, [{ approval_method: 'terminal_verified_token', approval_required: true, wastage_category: 'spoiled', n: 2 }])
  await expect(page.getByText('PIN verified by server').first()).toBeVisible()
  await snap('03-after-wastage-ledger-1440')
  console.log('STEP 2 PASS: forged evidence refused (403); verified PIN accepted once; movement spans 2 batches with cost snapshots.')

  // --- 3. Returned dish: re-labelled, never deducted a second time (the form is still open after step 2) ---
  await form.getByLabel('Category').selectOption('returned_order')
  await expect(form.getByText(/does not\s*take stock out a second time|does not take stock out a second time/)).toBeVisible()
  await form.getByLabel('Served dish').selectOption({ index: 1 })
  await form.getByLabel('Quantity Wasted').fill('0.5')
  await snap('04-returned-order-form-1440')
  await form.getByRole('button', { name: 'Record Wastage' }).click()
  await approveAsManager()
  await expect(form.getByText(/Stock was not deducted again/)).toBeVisible()
  assert.equal(await stockOf(flour), 6.5, 'stock unchanged by the returned-dish entry')
  await expect(page.getByText('No stock change').first()).toBeVisible()
  await snap('05-returned-order-ledger-1440')
  console.log('STEP 3 PASS: returned dish recorded for costing with no second deduction.')

  // --- 4. Error and empty states ---
  await form.getByLabel('Category').selectOption('spoiled')
  await form.getByLabel('Quantity Wasted').fill('500')
  await expect(form.getByText(/Only 6.5 in stock/).first()).toBeVisible()
  await snap('06-error-over-stock-1440')
  await page.locator('.inventory-detail-actions button.active').dispatchEvent('click')
  await selectIngredient(page, 'Saffron')
  await expect(page.getByText('No batches received yet')).toBeVisible()
  await expect(page.getByText('No stock activity yet')).toBeVisible()
  await snap('07-empty-states-1440')
  console.log('STEP 4 PASS: over-stock error and empty batch/ledger states render.')

  // --- 5. Responsive captures of the populated detail ---
  await selectIngredient(page, 'Flour')
  await expect(page.getByText('How this was costed').first()).toBeVisible()
  for (const [width, height] of [[768, 1024], [390, 844]] as const) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(300)
    await snap(`08-terminal-detail-${width}`)
    assert.deepEqual(await inventoryOverflow(), [], `inventory content overflows the viewport at ${width}px`)
    // dispatchEvent: at narrow widths the terminal's fixed nav intercepts pointer hit-testing for this toggle (pre-existing layout), so fire the click on the element itself.
    await page.locator('.inventory-detail-actions').getByRole('button', { name: 'Record Wastage' }).dispatchEvent('click')
    await page.locator('.inventory-wastage-form').getByLabel('Quantity Wasted').fill('2')
    await page.waitForTimeout(200)
    assert.deepEqual(await inventoryOverflow(), [], `inventory content overflows the viewport with the form open at ${width}px`)
    await snap(`09-wastage-form-${width}`)
    await page.locator('.inventory-detail-actions button.active').dispatchEvent('click')
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  console.log('STEP 5 PASS: 768 and 390 widths have no horizontal page scroll.')

  // --- 6. Owner/manager web session: no PIN needed, same categories and costing ---
  await page.goto(`${base}/inventory`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: /Flour/ }).first()).toBeVisible({ timeout: 30_000 })
  await selectIngredient(page, 'Flour')
  await page.locator('.inventory-detail-actions').getByRole('button', { name: 'Record Wastage' }).click()
  const webForm = page.locator('.inventory-wastage-form')
  await webForm.getByLabel('Category').selectOption('staff_meal')
  await webForm.getByLabel('Quantity Wasted').fill('1')
  await expect(webForm.getByText(/signed in as a manager, so no separate PIN is needed/)).toBeVisible()
  await webForm.getByRole('button', { name: 'Record Wastage' }).click()
  await expect(webForm.getByText(/recorded as staff meal wastage/)).toBeVisible()
  assert.equal(await stockOf(flour), 5.5)
  const web = (await db.query<{ approval_method: string }>(`select approval_method from public.stock_movements where wastage_category='staff_meal'`)).rows
  assert.deepEqual(web, [{ approval_method: 'web_manager_session' }])
  await snap('10-web-session-1440')
  console.log('STEP 6 PASS: owner/manager web session records categorised wastage without a PIN.')

  assert.deepEqual(errors, [], `Uncaught browser errors: ${errors.join(' | ')}`)
  console.log(`PASS: structured wastage, batch costing and the verified-approval threshold work through the real UI. Screenshots: ${shots}`)
} finally {
  await browser?.close()
  server.closeAllConnections(); identityServer.closeAllConnections(); server.close(); identityServer.close(); await db.close(); await pgDb.end()
}
