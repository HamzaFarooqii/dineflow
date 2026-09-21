import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { chromium, expect as baseExpect } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const pictures = root + 'docs/screenshots/owner-product-catalog/'
const expect = baseExpect.configure({ timeout: 20_000 })
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
process.env.SUPABASE_URL = 'http://127.0.0.1:3189'
process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture'
const { db } = await import('../src/db.js')
const { createApp } = await import('../src/app.js')

// In-memory Postgres with the real migrations applied — no real Supabase project or
// credentials required. Mirrors the pattern in customer-browser-check.ts.
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
  '202609180002_store_business_details.sql', '202609180003_tax_rate_change_feed.sql',
  '202609180004_product_images.sql']) {
  await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}
const owner = randomUUID(), store = randomUUID()
await database.query('insert into auth.users(id) values ($1)', [owner])
await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture Catalog Store','catalog-browser',$2)", [store, owner])
await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'owner')", [store, owner])

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

const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.fixture`
const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3188', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${token}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(user) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner', user_id: owner, active: true, joined_at: new Date().toISOString() }]) })
identity.get('/rest/v1/profiles', (_req, res) => { res.json([{ id: owner, full_name: 'Fixture Owner' }]) })
// App.tsx's onboarding-status check (202609190001_store_onboarding_status.sql) reads this
// directly via the Supabase client, so the fixture must answer it or every route falls into the
// "Something needs your attention" store-load-failure screen.
// .single() calls expect a bare object in the response body, not an array wrapping one.
identity.get('/rest/v1/stores', (req, res) => { const row = { id: store, name: 'Fixture Catalog Store', onboarding_completed_at: new Date().toISOString() }; res.json(String(req.headers.accept).includes('vnd.pgrst.object') ? row : [row]) })
const identityServer = identity.listen(3189, '127.0.0.1')
const web = express()
web.use('/api', createApp({ pool: db, origin: 'http://127.0.0.1:3188', supabaseUrl: 'http://127.0.0.1:3189', supabaseKey: 'fixture', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile('index.html', { root: join(root, 'apps/web/dist') }) })
const webServer = web.listen(3188, '127.0.0.1')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
    cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3189',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'fixture', VITE_API_URL: '/api' }, stdio: 'inherit', windowsHide: true })
  assert.equal(await new Promise<number | null>(resolve => build.on('exit', resolve)), 0)
  await mkdir(pictures, { recursive: true })
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }))
  }, { token, user })
  const page = await context.newPage()
  page.on('response', response => { if (response.status() >= 400) console.log('API response:', response.status(), new URL(response.url()).pathname) })

  // 1. Browse existing (seeded) catalog with stock counts
  await page.goto('http://127.0.0.1:3188/products')
  await expect(page.getByRole('heading', { name: 'Product catalog.' })).toBeVisible()
  await expect(page.getByText('Total Products')).toBeVisible()
  await expect(page.getByText('Ceramic Mug')).toBeVisible()
  await expect(page.getByText('Low Stock').first()).toBeVisible() // Wool Scarf seeds at 5 units

  // 2. Search by name, SKU and barcode
  await page.getByLabel('Search products').fill('mug')
  await expect(page.getByText('Ceramic Mug')).toBeVisible()
  await expect(page.getByText('Canvas Tote')).toHaveCount(0)
  await page.getByLabel('Search products').fill('TOTE-001')
  await expect(page.getByText('Canvas Tote')).toBeVisible()
  await page.getByLabel('Search products').fill('2000000000005') // Olive Oil barcode
  await expect(page.getByText('Olive Oil')).toBeVisible()

  // 3. Search-not-found state
  await page.getByLabel('Search products').fill('not-a-real-product-zzz')
  await expect(page.getByRole('heading', { name: 'No products found' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).click()

  // 4. Category filter
  await page.getByLabel('Filter by category').selectOption({ label: 'Apparel' })
  await expect(page.getByText('Wool Scarf')).toBeVisible()
  await expect(page.getByText('Ceramic Mug')).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByText('Ceramic Mug')).toBeVisible()

  // 5. Add a new product — exercises price/cents conversion, a brand-new category, and initial stock
  await page.getByRole('button', { name: '+ Add product' }).click()
  const drawer = page.getByRole('dialog', { name: 'Add Product' })
  await expect(drawer.getByRole('heading', { name: 'Add new product' })).toBeVisible()
  await drawer.getByLabel('Product name').fill('Cold Brew Concentrate')
  await drawer.getByLabel('SKU').fill('BEV-CB-01')
  await drawer.getByLabel('Barcode').fill('CB010001')
  await drawer.getByLabel('Category').selectOption({ label: '+ Create new category…' })
  await drawer.getByPlaceholder('Category name (e.g. Specialty Beverages)').fill('Cold Beverages')
  // New stores get zero tax rates (202609190002_remove_demo_catalog_seed.sql removed the only
  // insert that ever created one) and there was no way to add one until now — exercise it here,
  // the same way a brand-new category is created inline above.
  await drawer.getByLabel('Tax rate').selectOption({ label: '+ Create new tax rate…' })
  await drawer.getByPlaceholder('Tax rate name (e.g. Sales tax)').fill('State sales tax')
  await drawer.getByPlaceholder('Percent (e.g. 8.5)').fill('8.5')
  await drawer.getByLabel('Unit price').fill('12.50')
  await drawer.getByLabel('Initial stock').fill('10')
  const createResponse = page.waitForResponse(response => response.url().includes('/catalog/products') && response.request().method() === 'POST')
  await drawer.getByRole('button', { name: 'Save to Catalog' }).click()
  const response = await createResponse
  assert.equal(response.status(), 201, 'POST /catalog/products should return 201 on success')
  await expect(page.getByText('added and available on the register', { exact: false })).toBeVisible()
  const newRow = page.locator('.pc-row', { hasText: 'Cold Brew Concentrate' })
  await expect(newRow).toBeVisible()
  await expect(newRow.getByText('$12.50')).toBeVisible()
  await expect(newRow.getByText('Cold Beverages')).toBeVisible()

  // 6. Verify the transaction actually committed: pos_products, pos_stock, and the change feed
  const created = await database.query<{ id: string; unit_price_cents: string; tax_rate_id: string | null }>(
    'select id, unit_price_cents::text as unit_price_cents, tax_rate_id from public.pos_products where store_id=$1 and sku=$2', [store, 'BEV-CB-01'])
  assert.equal(created.rows.length, 1, 'Product should be committed to pos_products')
  assert.equal(created.rows[0].unit_price_cents, '1250', 'Price must be stored as integer cents (12.50 -> 1250)')
  assert(created.rows[0].tax_rate_id, 'Product should be linked to the newly created tax rate')
  const newTaxRate = await database.query<{ name: string; rate_bps: number }>(
    'select name, rate_bps from public.pos_tax_rates where id=$1', [created.rows[0].tax_rate_id])
  assert.equal(newTaxRate.rows.length, 1, 'Tax rate should be committed to pos_tax_rates')
  assert.equal(newTaxRate.rows[0].name, 'State sales tax')
  assert.equal(newTaxRate.rows[0].rate_bps, 850, 'Percent must convert to basis points (8.5% -> 850 bps)')
  const productId = created.rows[0].id
  const stockRow = await database.query<{ current_stock: number }>(
    'select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productId])
  assert.equal(stockRow.rows[0]?.current_stock, 10, 'Initial stock should be committed to pos_stock')
  const feedRow = await database.query<{ entity_type: string }>(
    "select entity_type from public.pos_change_feed where store_id=$1 and entity_id=$2 and entity_type='product'", [store, productId])
  assert.equal(feedRow.rows.length, 1, 'Product creation should write a pos_change_feed entry so terminals receive it on pull sync')

  // 7. Immediate Register availability — no manual refresh, product can be added to the cart
  await page.goto('http://127.0.0.1:3188/register')
  await expect(page.getByRole('heading', { name: 'Current Sale' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cold Brew Concentrate', exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Cold Brew Concentrate', exact: false }).click()
  const proceedLink = page.getByRole('link', { name: 'Proceed to payment' })
  await expect(proceedLink).not.toHaveClass(/cta-disabled/)
  await proceedLink.click()
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()

  // 8. Responsive check — no horizontal scroll at 375/390/768/1440; screenshots at 390 and 1440
  await page.goto('http://127.0.0.1:3188/products')
  await expect(page.getByRole('heading', { name: 'Product catalog.' })).toBeVisible()
  for (const width of [375, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Product catalog page scrolls horizontally at ${width}`)
    if (width === 390 || width === 1440) await page.screenshot({ path: `${pictures}products-${width}.png`, fullPage: true })
  }
  console.log('PASS: owner product catalog browse/search/filter/add-product committed to pos_products + pos_stock + pos_change_feed; new product instantly sellable at /register; 375/390/768/1440 responsive without horizontal scroll.')
} finally {
  await browser?.close(); webServer.closeAllConnections(); identityServer.closeAllConnections(); webServer.close(); identityServer.close(); await database.close(); await db.end()
}
