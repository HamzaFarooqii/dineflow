import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { chromium, expect as baseExpect } from '@playwright/test'

// Browser check: a store with products cannot change currency and silently revalue
// cached prices or paid offline sales on other devices.

const root = fileURLToPath(new URL('../../../', import.meta.url))
const expect = baseExpect.configure({ timeout: 20_000 })
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
process.env.SUPABASE_URL = 'http://127.0.0.1:3197'
process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture'
const { db } = await import('../src/db.js')
const { createApp } = await import('../src/app.js')

const database = new PGlite()
await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';
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
  '202609180004_product_images.sql', '202609180005_refunds.sql']) {
  await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}
const owner = randomUUID(), store = randomUUID()
await database.query('insert into auth.users(id) values ($1)', [owner])
await database.query("insert into public.stores(id,name,code,created_by,currency) values ($1,'Fixture Currency Store','currency-browser',$2,'USD')", [store, owner])
await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'owner')", [store, owner])
// Existing products make a currency change unsafe for offline devices.
const productId = randomUUID()
await database.query(
  "insert into public.pos_products(id,store_id,sku,barcode,name,unit_price_cents,active,revision) values ($1,$2,'MUG-USD','1','Test Mug',1250,true,1)",
  [productId, store],
)
await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,10)', [store, productId])

const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; release: () => void }> }
let tail = Promise.resolve()
const query = async (sql: string, params?: unknown[]) => {
  const result = await database.query(sql, params)
  return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
}
fixture.query = query
fixture.connect = async () => { const previous = tail; let release!: () => void; tail = new Promise<void>(r => { release = r }); await previous; return { query, release } }

const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.fixture`
const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
const identity = express()
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3196', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${token}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(user) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner', user_id: owner, active: true, joined_at: new Date().toISOString() }]) })
identity.get('/rest/v1/profiles', (_req, res) => { res.json([{ id: owner, full_name: 'Fixture Owner' }]) })
identity.get('/rest/v1/stores', (req, res) => { const row = { id: store, name: 'Fixture Currency Store', onboarding_completed_at: new Date().toISOString() }; res.json(String(req.headers.accept).includes('vnd.pgrst.object') ? row : [row]) })
const identityServer = identity.listen(3197, '127.0.0.1')

const web = express()
web.use('/api', createApp({ pool: db, origin: 'http://127.0.0.1:3196', supabaseUrl: 'http://127.0.0.1:3197', supabaseKey: 'fixture', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile('index.html', { root: join(root, 'apps/web/dist') }) })
const webServer = web.listen(3196, '127.0.0.1')

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
    cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3197', VITE_SUPABASE_PUBLISHABLE_KEY: 'fixture', VITE_API_URL: '/api' }, stdio: 'inherit', windowsHide: true })
  assert.equal(await new Promise<number | null>(resolve => build.on('exit', resolve)), 0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }))
  }, { token, user })
  const page = await context.newPage()
  page.on('dialog', dialog => void dialog.accept())

  await page.goto('http://127.0.0.1:3196/settings/store')
  await expect(page.getByText('Store details.')).toBeVisible()
  await expect(page.getByLabel('Currency')).toHaveValue('USD')

  const patchResponse = page.waitForResponse(response => response.url().includes('/api/stores/') && response.request().method() === 'PATCH')
  await page.getByLabel('Currency').selectOption('PKR')
  await page.getByRole('button', { name: 'Save store details' }).click()
  const response = await patchResponse
  assert.equal(response.status(), 409, 'Currency changes must be blocked once products exist')
  const body = await response.json() as { code: string }
  assert.equal(body.code, 'currency_change_blocked')
  const storeRow = await database.query<{ currency: string }>('select currency from public.stores where id=$1', [store])
  assert.equal(storeRow.rows[0].currency, 'USD')
  const productRow = await database.query<{ unit_price_cents: string }>('select unit_price_cents::text as unit_price_cents from public.pos_products where id=$1', [productId])
  assert.equal(Number(productRow.rows[0].unit_price_cents), 1250)
  console.log('PASS: active store currency change is blocked; existing prices and currency remain intact.')
} finally {
  await browser?.close(); webServer.closeAllConnections(); identityServer.closeAllConnections(); webServer.close(); identityServer.close(); await database.close(); await db.end()
}
