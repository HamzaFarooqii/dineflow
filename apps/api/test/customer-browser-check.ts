import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { chromium, expect as baseExpect } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const pictures = root + 'docs/screenshots/customer-sale-sync/'
const expect = baseExpect.configure({ timeout: 20_000 })
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
process.env.SUPABASE_URL = 'http://127.0.0.1:3185'
process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture'
const { db } = await import('../src/db.js')
const { createApp } = await import('../src/app.js')
const database = new PGlite()
await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
// Replay every migration in supabase/migrations/APPLIED.md's order, not a hand-picked subset —
// a partial list drifts from the app's actual schema expectations the moment a later migration
// adds a column the app comes to depend on (this one previously missed cart_discounts.sql's
// pos_orders.discount_cents, which the dashboard's report query now selects unconditionally).
for (const name of ['202609130001_auth_and_stores.sql', '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql', '202609150002_terminal_device_sessions.sql',
  '202609150003_team_profile_visibility.sql', '202609160001_customers_and_sale_attachment.sql',
  '202609170001_change_feed_product_entity.sql', '202609170002_cart_discounts.sql',
  '202609180001_terminal_name_uniqueness.sql', '202609180002_pos_orders_report_read_access.sql',
  '202609190001_audit_log.sql', '202609190001_store_onboarding_status.sql',
  '202609190002_remove_demo_catalog_seed.sql', '202609190003_store_sync_feed_init.sql',
  '202609200001_service_role_only_rls_policies.sql']) {
  await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
}
const owner = randomUUID(), store = randomUUID(), device = randomUUID(), employee = randomUUID()
await database.query('insert into auth.users(id) values ($1)', [owner])
await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture General','customer-browser',$2)", [store, owner])
await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'owner')", [store, owner])
// New stores no longer auto-seed a demo catalog (202609190002_remove_demo_catalog_seed.sql) —
// that behavior was deliberately removed, so this fixture now seeds the one product the flow
// below needs, the way a real owner would via the catalog screen.
const product = randomUUID()
await database.query("insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'MUG-001','Ceramic Mug',1800)", [product, store])
await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,50)', [store, product])
const access = 'a'.repeat(64), cashier = 'b'.repeat(64)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
  values ($1,$2,'Front Counter','TEST-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`, [device, store, owner, digest('c'.repeat(64)), digest(access)])
await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
  values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(access), digest('d'.repeat(64))])
await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash)
  values ($1,$2,'Alex Cashier','cashier',$3,$4)`, [employee, store, '1'.repeat(32), '2'.repeat(64)])
await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
  values ($1,$2,$3,$4,1,now()+interval '1 day')`, [store, device, employee, digest(cashier)])
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
identity.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:3184', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,x-client-info,x-supabase-api-version', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); next() })
identity.options('/{*path}', (_req, res) => { res.sendStatus(204) })
identity.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${token}`) { res.sendStatus(401); return }; next() })
identity.get('/auth/v1/user', (_req, res) => { res.json(user) })
identity.get('/rest/v1/store_memberships', (_req, res) => { res.json([{ store_id: store, role: 'owner', user_id: owner, active: true, joined_at: new Date().toISOString() }]) })
identity.get('/rest/v1/profiles', (_req, res) => { res.json([{ id: owner, full_name: 'Fixture Owner' }]) })
// App.tsx's onboarding-status check (202609190001_store_onboarding_status.sql) reads this
// directly via the Supabase client, so the fixture must answer it or every route falls into the
// "Something needs your attention" store-load-failure screen. .single() expects a bare object.
identity.get('/rest/v1/stores', (_req, res) => { res.json({ id: store, onboarding_completed_at: new Date().toISOString() }) })
const identityServer = identity.listen(3185, '127.0.0.1')
const web = express()
web.use('/api', createApp({ pool: db, origin: 'http://127.0.0.1:3184', supabaseUrl: 'http://127.0.0.1:3185', supabaseKey: 'fixture', secureCookies: false }))
web.use(express.static(root + 'apps/web/dist'))
web.get('/{*path}', (_req, res) => { res.sendFile(root + 'apps/web/dist/index.html') })
const webServer = web.listen(3184, '127.0.0.1')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
    cwd: root + 'apps/web', env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3185',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'fixture', VITE_API_URL: '/api' }, stdio: 'inherit', windowsHide: true })
  assert.equal(await new Promise<number | null>(resolve => build.on('exit', resolve)), 0)
  await mkdir(pictures, { recursive: true })
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ownerContext.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await ownerContext.route('https://fonts.gstatic.com/**', route => route.abort())
  await ownerContext.addInitScript(({ token, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }))
  }, { token, user })
  const ownerPage = await ownerContext.newPage()
  await ownerPage.goto('http://127.0.0.1:3184/dashboard')
  await expect(ownerPage.getByRole('heading', { name: 'Today at a glance.' })).toBeVisible()
  await ownerPage.goto('http://127.0.0.1:3184/settings')
  await expect(ownerPage.getByRole('heading', { name: 'Store settings' })).toBeVisible()
  await ownerPage.goto('http://127.0.0.1:3184/register')
  await expect(ownerPage.getByRole('heading', { name: 'Current Sale' })).toBeVisible()
  await expect(ownerPage.getByRole('button', { name: 'Ceramic Mug', exact: false })).toBeVisible()
  await ownerPage.getByRole('button', { name: 'Ceramic Mug', exact: false }).click()
  await ownerPage.getByRole('link', { name: 'Proceed to payment' }).click()
  await expect(ownerPage.getByRole('heading', { name: 'Payment' })).toBeVisible()
  await ownerPage.goto('http://127.0.0.1:3184/customers')
  await expect(ownerPage.getByRole('heading', { name: 'Customers' })).toBeVisible()
  await ownerPage.getByLabel('Customer name').fill('Fixture owner customer')
  await ownerPage.getByLabel('Phone with country code (optional)').fill('+923001234567')
  await ownerPage.getByRole('button', { name: 'Save customer' }).click()
  await expect(ownerPage.getByText('Customer saved on this browser.', { exact: false })).toBeVisible()
  await ownerPage.getByLabel('Phone with country code', { exact: true }).fill('+923001234567')
  await ownerPage.getByRole('button', { name: 'Search online' }).click()
  await expect(ownerPage.getByText('Fixture owner customer')).toBeVisible()
  for (const width of [375, 390, 768, 1440]) {
    await ownerPage.setViewportSize({ width, height: 1000 })
    assert(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Owner customer page scrolls at ${width}`)
    if (width === 390 || width === 1440) await ownerPage.screenshot({ path: `${pictures}owner-${width}.png`, fullPage: true })
  }
  const cashierContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await cashierContext.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await cashierContext.route('https://fonts.gstatic.com/**', route => route.abort())
  await cashierContext.addCookies([
    { name: 'terminal_access', value: access, url: 'http://127.0.0.1:3184/api' },
    { name: 'terminal_cashier', value: cashier, url: 'http://127.0.0.1:3184/api' },
  ])
  const cashierPage = await cashierContext.newPage()
  cashierPage.on('response', response => { if (response.status() >= 400) console.log('Cashier API response:', response.status(), new URL(response.url()).pathname) })
  cashierPage.on('requestfailed', request => console.log('Cashier request failed:', new URL(request.url()).pathname, request.failure()?.errorText))
  await cashierPage.goto('http://127.0.0.1:3184/pos/login')
  await cashierPage.evaluate(async () => { await navigator.serviceWorker.ready })
  await cashierPage.evaluate(async ({ store, device, employee }) => {
    const now = new Date().toISOString()
    const connection = indexedDB.open('counterline-terminal-access')
    connection.onupgradeneeded = () => { connection.result.createObjectStore('access', { keyPath: 'key' }) }
    const db = await new Promise<IDBDatabase>((resolve, reject) => { connection.onsuccess = () => resolve(connection.result); connection.onerror = () => reject(connection.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('access', 'readwrite')
      tx.objectStore('access').put({ key: 'current', device: { id: device, store_id: store, name: 'Front Counter', receipt_prefix: 'TEST-' },
        validated_at: now, locked_until: null, employees: [{ id: employee, name: 'Alex Cashier', role: 'cashier', permission_version: 1, locked_until: null,
          verifier: { version: 1, algorithm: 'PBKDF2-SHA256', iterations: 600000, salt: '1'.repeat(32), hash: '2'.repeat(64) } }],
        session: { employee_id: employee, permission_version: 1, logged_in_at: now, last_server_validated_at: now },
        attempts: 0, localLockedUntil: 0, lastSeen: Date.now() - 1000 })
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, { store, device, employee })
  await cashierPage.goto('http://127.0.0.1:3184/pos/register')
  await expect(cashierPage.getByRole('heading', { name: 'Current Sale' })).toBeVisible()
  await expect(cashierPage.getByRole('button', { name: 'Ceramic Mug', exact: false })).toBeVisible()
  await cashierPage.goto('http://127.0.0.1:3184/pos/customers')
  await expect(cashierPage.getByRole('heading', { name: 'Customers' })).toBeVisible()
  assert.equal(await cashierPage.getByRole('link', { name: 'Reports' }).count(), 0)
  for (const width of [375, 390, 768, 1440]) {
    await cashierPage.setViewportSize({ width, height: 1000 })
    assert(await cashierPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Cashier customer page scrolls at ${width}`)
    if (width === 390 || width === 1440) await cashierPage.screenshot({ path: `${pictures}cashier-${width}.png`, fullPage: true })
  }
  await cashierPage.setViewportSize({ width: 390, height: 1000 })
  await cashierContext.setOffline(true)
  await cashierPage.getByLabel('Customer name').fill('Fixture offline customer')
  await cashierPage.getByLabel('Phone with country code (optional)').fill('+913001234567')
  await cashierPage.getByRole('button', { name: 'Save customer' }).click()
  await expect(cashierPage.getByRole('heading', { name: 'Current Sale' })).toBeVisible()
  await expect(cashierPage.getByText('Fixture offline customer')).toBeVisible()
  await expect(cashierPage.getByRole('button', { name: 'Ceramic Mug', exact: false })).toBeVisible()
  await cashierPage.screenshot({ path: `${pictures}register-selected-390.png`, fullPage: true })
  await cashierPage.getByRole('button', { name: 'Ceramic Mug', exact: false }).click()
  await cashierPage.getByRole('link', { name: 'Proceed to payment' }).click()
  await expect(cashierPage.getByRole('heading', { name: 'Payment' })).toBeVisible()
  await cashierPage.screenshot({ path: `${pictures}payment-selected-390.png`, fullPage: true })
  await cashierPage.getByLabel('Amount received').fill('20.00')
  await cashierPage.getByRole('button', { name: 'Complete sale' }).click()
  // Completing a sale now navigates straight to the Receipt screen (receipt-first UX), rather than
  // staying on Register — the sale is "saved locally" but its sync is blocked behind the still-
  // offline customer upload, which the receipt's status line makes explicit.
  await expect(cashierPage.getByRole('heading', { name: 'Receipt.' })).toBeVisible()
  await expect(cashierPage.getByText('Waiting for customer upload', { exact: false })).toBeVisible()
  await cashierPage.reload()
  await expect(cashierPage.getByRole('heading', { name: 'Receipt.' })).toBeVisible()
  const offline = await database.query('select id from public.pos_customers where phone_normalized=$1', ['913001234567'])
  assert.equal(offline.rows.length, 0, 'Offline customer should not have uploaded before reconnect')
  await cashierContext.setOffline(false)
  // Regression check for the QA_REPORT.md finding: CashierPosLayout now carries its own
  // 'online'/poll sync trigger, so a cashier who completes a sale (landing on Receipt, per the
  // receipt-first UX) and stays right there while reconnecting still sees it upload — no manual
  // navigation to Sell or Orders required, unlike before this fix.
  await expect.poll(async () => (await database.query('select id from public.pos_customers where phone_normalized=$1', ['913001234567'])).rows.length, { timeout: 45_000 }).toBe(1)
  await expect.poll(async () => (await database.query('select id from public.pos_orders where customer_id in (select id from public.pos_customers where phone_normalized=$1)', ['913001234567'])).rows.length, { timeout: 45_000 }).toBe(1)
  const ledger = await database.query<{ entity_type: string }>('select entity_type from public.pos_operation_ledger where store_id=$1 order by accepted_checkpoint', [store])
  assert.deepEqual(ledger.rows.slice(-2).map(row => row.entity_type), ['customer', 'order'])
  console.log('PASS: existing dashboard, Settings, register and payment rendered; owner and cashier customers at 375/390/768/1440 without horizontal scrolling; offline customer and cash sale survived reload, then uploaded customer before order.')
} finally {
  await browser?.close(); webServer.closeAllConnections(); identityServer.closeAllConnections(); webServer.close(); identityServer.close(); await database.close(); await db.end()
}
