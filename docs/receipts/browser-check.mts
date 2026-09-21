// Isolated browser acceptance test. Only identity/catalog inputs are fixtures;
// every receipt under test is created by the real checkout UI and Dexie transaction.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '../../apps/api/node_modules/@playwright/test/index.mjs'
import { preview } from '../../apps/web/node_modules/vite/dist/node/index.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = root + 'docs/receipts/screenshots/'
await mkdir(output, { recursive: true })
const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
  cwd: root + 'apps/web', windowsHide: true, stdio: 'inherit',
  env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3191', VITE_SUPABASE_PUBLISHABLE_KEY: 'receipt-test-public', VITE_API_URL: '/api' },
})
assert.equal(await new Promise(resolve => build.on('exit', resolve)), 0)
const server = await preview({ root: root + 'apps/web', preview: { host: '127.0.0.1', port: 3190, strictPort: true } })
const browser = await chromium.launch()
const store = '00000000-0000-4000-8000-000000000002'
const owner = '00000000-0000-4000-8000-000000000001'
const employee = '00000000-0000-4000-8000-000000000003'
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  // tsx preserves function names in serialized evaluate callbacks.
  await context.addInitScript('window.__name = (value) => value')
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  let terminalPushes = 0, ownerPushes = 0
  let syncOutcomes = false
  await context.route('**/api/**', async route => {
    if (route.request().url().includes('/orders/push')) {
      if (route.request().url().includes('/pos/')) { terminalPushes++; assert.equal(route.request().headers().authorization, undefined) }
      else { ownerPushes++; assert.match(route.request().headers().authorization, /^Bearer /) }
      if (syncOutcomes) {
        const operation = route.request().postDataJSON() as { operation_id: string; order: { receipt_number: string } }
        const accepted = operation.order.receipt_number.endsWith('000001')
        await route.fulfill({ status: accepted ? 200 : 422, json: accepted
          ? { status: 'accepted', operation_id: operation.operation_id, accepted_checkpoint: '1' }
          : { code: 'review_required', message: 'Paid sale requires reconciliation.' } })
        return
      }
    }
    await route.fulfill({ status: 503, json: { message: 'Test service unavailable' } })
  })
  const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'review@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
  await context.route('http://127.0.0.1:3191/**', route => route.fulfill({ json: route.request().url().includes('/user') ? user : [{ store_id: store, role: 'owner', name: 'Receipt review store' }] }))
  await page.goto('http://127.0.0.1:3190/pos/login')
  await page.evaluate(async ({ store, employee }) => {
    const write = (name: string, version: number, schemas: Record<string, { keyPath: string | string[]; autoIncrement?: boolean; indexes?: [string, string | string[], boolean?][] }>, values: Record<string, object[]>) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, version)
      request.onupgradeneeded = () => {
        for (const [table, schema] of Object.entries(schemas)) {
          if (request.result.objectStoreNames.contains(table)) continue
          const target = request.result.createObjectStore(table, { keyPath: schema.keyPath, autoIncrement: schema.autoIncrement })
          for (const [index, path, unique] of schema.indexes ?? []) target.createIndex(index, path, { unique })
        }
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const transaction = request.result.transaction(Object.keys(values), 'readwrite')
        for (const [table, rows] of Object.entries(values)) for (const row of rows) transaction.objectStore(table).put(row)
        transaction.oncomplete = () => { request.result.close(); resolve() }
        transaction.onerror = () => reject(transaction.error)
      }
    })
    const now = new Date().toISOString()
    await write('counterline-terminal-access', 10, { access: { keyPath: 'key' } }, { access: [{ key: 'current', device: { id: 'test-terminal', store_id: store, name: 'Front counter', receipt_prefix: 'FRONT-' }, employees: [{ id: employee, name: 'Review cashier', role: 'cashier', permission_version: 1 }], session: { employee_id: employee, permission_version: 1, logged_in_at: now, last_server_validated_at: now }, validated_at: now, attempts: 0, localLockedUntil: 0, lastSeen: Date.now() }] })
    await write('counterline-pos', 30, {
      store_config: { keyPath: 'id' }, categories: { keyPath: 'id', indexes: [['store_id','store_id'],['active','active']] }, tax_rates: { keyPath: 'id', indexes: [['store_id','store_id'],['active','active']] },
      products: { keyPath: 'id', indexes: [['[store_id+sku]',['store_id','sku'],true],['[store_id+barcode]',['store_id','barcode']],['[store_id+category_id]',['store_id','category_id']],['active','active'],['store_id','store_id']] },
      stock_adjustments: { keyPath: ['operation_id','product_id'], indexes: [['product_id','product_id'],['operation_id','operation_id']] },
      server_stock: { keyPath: 'product_id' }, orders: { keyPath: 'id', indexes: [['receipt_number','receipt_number',true],['client_generated_at','client_generated_at'],['sync_status','sync_status'],['store_id','store_id'],['[store_id+client_generated_at]',['store_id','client_generated_at']]] },
      order_items: { keyPath: 'id', indexes: [['order_id','order_id'],['product_id','product_id']] }, payments: { keyPath: 'id', indexes: [['order_id','order_id',true]] },
      outbox: { keyPath: 'id', autoIncrement: true, indexes: [['operation_id','operation_id',true],['status','status'],['next_attempt_at','next_attempt_at'],['store_id','store_id']] }, sync_metadata: { keyPath: 'key' },
    }, { store_config: [{ id: store, store_id: store, name: 'Receipt review store', currency: 'USD', timezone: 'Asia/Karachi', catalog_version: 1 }],
      products: [{ id: 'product-one', store_id: store, name: 'Saved-name tea', sku: 'TEA-001', barcode: null, category_id: null, tax_rate_id: null, unit_price_cents: 650, active: true, revision: 1 }],
      sync_metadata: [{ key: `receipt_prefix:${store}`, value: 'FRONT-' }] })
    await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
  }, { store, employee })
  await page.goto('http://127.0.0.1:3190/pos/orders')
  await expect(page.getByText('No orders have been saved for this store in this browser yet.')).toBeVisible()
  await page.getByRole('link', { name: 'Sell', exact: true }).click()
  await expect(page.locator('.catalog-card')).toHaveCount(1)
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  await context.setOffline(true)
  await page.locator('.catalog-card').click()
  await page.getByRole('link', { name: 'Proceed to payment' }).click()
  await page.getByLabel('Amount received').fill('10.00')
  await page.getByRole('button', { name: 'Complete sale' }).click()
  await expect(page).toHaveURL(/\/pos\/orders\/[a-f0-9-]+$/)
  await expect(page.getByText('Sale saved in this browser.', { exact: false })).toBeVisible()
  const cashUrl = page.url()
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('$3.50')
  const snapshot = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('counterline-pos'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const names = Array.from(db.objectStoreNames)
    const transaction = db.transaction(names, 'readonly')
    const result = await Promise.all(names.map(name => new Promise(resolve => { const r = transaction.objectStore(name).getAll(); r.onsuccess = () => resolve([name,r.result]) })))
    db.close(); return JSON.stringify(result)
  })
  const before = await snapshot()
  await page.evaluate(() => { window.print = () => {} }) // Dialog cancellation/return simulation, not physical printing.
  await page.getByRole('button', { name: 'Print receipt', exact: true }).click()
  await page.getByRole('button', { name: 'Print duplicate receipt' }).click()
  await expect(page.locator('.sale-print-root')).toContainText('DUPLICATE RECEIPT')
  await page.evaluate(() => { window.print = () => { throw new Error('simulated printer failure') } })
  await page.getByRole('button', { name: 'Print duplicate receipt' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'could not open' })).toBeVisible()
  assert.equal(await snapshot(), before, 'Print attempts must not mutate any business table')
  await page.reload()
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('DUPLICATE RECEIPT')
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('Saved-name tea')
  assert.equal(await snapshot(), before, 'Offline receipt reload is read-only')
  for (const width of [375,390,768,1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: output + `receipt-${width}.png`, fullPage: true })
  }
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('#root')).toBeHidden()
  await page.pdf({ path: output + 'receipt-80mm.pdf', preferCSSPageSize: true, printBackground: true })
  await page.locator('.sale-print-root').screenshot({ path: output + 'receipt-print.png' })
  await page.emulateMedia({ media: 'screen' })
  await page.getByRole('link', { name: 'Back to orders' }).click()
  await expect(page.getByRole('link', { name: 'Orders', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('link', { name: 'Sell', exact: true })).not.toHaveAttribute('aria-current', 'page')
  await page.getByLabel('Find receipt or date').fill('not-a-receipt')
  await expect(page.getByText('No orders match your search.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).click()
  await page.getByLabel('Sale date', { exact: true }).fill('2000-01-01')
  await expect(page.getByText('No orders match your search.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).click()
  for (const width of [375,390,768,1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: output + `history-${width}.png`, fullPage: true })
  }
  await page.getByRole('link', { name: 'View receipt / print' }).click()
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('DUPLICATE RECEIPT')
  await page.getByRole('link', { name: 'New sale' }).click()
  await page.locator('.catalog-card').click()
  await page.getByRole('link', { name: 'Proceed to payment' }).click()
  await page.getByRole('button', { name: 'Card (external)' }).click()
  await page.getByLabel('External payment reference (optional)').fill('CARD-APPROVED-42')
  await page.getByLabel('I confirm the external card payment was approved.').check()
  await page.getByRole('button', { name: 'Complete sale' }).click()
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('CARD-APPROVED-42')
  const cardUrl = page.url()
  await page.goto(cashUrl.replace(/[^/]+$/, 'missing-order'))
  await expect(page.getByRole('heading', { name: 'Receipt not found' })).toBeVisible()
  // Catalog changes must not alter historical snapshots.
  await page.evaluate(async () => {
    const request = indexedDB.open('counterline-pos')
    await new Promise<void>(resolve => { request.onsuccess = () => {
      const tx = request.result.transaction('products','readwrite'), table = tx.objectStore('products'), read = table.get('product-one')
      read.onsuccess = () => table.put({ ...read.result, name: 'Changed catalog name', unit_price_cents: 9900 })
      tx.oncomplete = () => { request.result.close(); resolve() }
    } })
  })
  await page.goto(cashUrl)
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('Saved-name tea')
  await expect(page.locator('.receipt-page .sale-receipt')).not.toContainText('Changed catalog name')
  // Long names, long provisioned prefix, and a multi-page basket, all committed by checkout.
  await page.evaluate(async ({ store }) => {
    const request = indexedDB.open('counterline-pos')
    await new Promise<void>(resolve => { request.onsuccess = () => {
      const tx = request.result.transaction('products','readwrite')
      for (let i=0;i<32;i++) tx.objectStore('products').put({ id: `long-${i}`, store_id: store, name: `Long basket item ${i} with a deliberately extended product description and packaging information`, sku: `LONG-SKU-${i}`, unit_price_cents: 199, barcode: null, category_id: null, tax_rate_id: null, active: true, revision: 1 })
      tx.oncomplete = () => { request.result.close(); resolve() }
    } })
    const terminal = indexedDB.open('counterline-terminal-access')
    await new Promise<void>(resolve => { terminal.onsuccess = () => {
      const tx = terminal.result.transaction('access','readwrite'), table = tx.objectStore('access'), read = table.get('current')
      read.onsuccess = () => table.put({ ...read.result, device: { ...read.result.device, receipt_prefix: 'LONG-INSTALLATION-PREFIX-FOR-RECEIPT-WRAPPING-' } })
      tx.oncomplete = () => { terminal.result.close(); resolve() }
    } })
  }, { store })
  await page.getByRole('link', { name: 'New sale' }).click()
  await expect(page.locator('.catalog-card')).toHaveCount(33)
  for (let i=0;i<32;i++) await page.locator('.catalog-card').filter({ hasText: `LONG-SKU-${i}` }).filter({ has: page.locator('small', { hasText: new RegExp(`LONG-SKU-${i}$`) }) }).click()
  await page.getByRole('link', { name: 'Proceed to payment' }).click()
  await page.getByLabel('Amount received').fill('100.00')
  await page.getByRole('button', { name: 'Complete sale' }).click()
  await expect(page.locator('.receipt-page .receipt-line')).toHaveCount(32)
  await page.getByRole('link', { name: 'Back to orders' }).focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'New sale' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Print receipt', exact: true })).toBeFocused()
  const longBefore = await snapshot()
  for (const width of [375,390,768,1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  await page.emulateMedia({ media: 'print' })
  await page.pdf({ path: output + 'receipt-long-80mm.pdf', preferCSSPageSize: true })
  assert.equal(await page.locator('.sale-print-root').evaluate(node => node.scrollWidth <= node.clientWidth), true)
  await page.emulateMedia({ media: 'screen' })
  assert.equal(await snapshot(), longBefore)
  const longPdf = await readFile(output + 'receipt-long-80mm.pdf', 'latin1')
  assert.ok((longPdf.match(/\/Type \/Page\b/g) ?? []).length > 1, 'Long basket must paginate')
  await context.setOffline(false)
  await page.getByRole('link', { name: 'Back to orders' }).click()
  await page.getByRole('button', { name: 'Sync pending orders' }).click()
  await expect.poll(() => terminalPushes).toBeGreaterThan(0)
  assert.equal(ownerPushes,0,'Cashier must never use owner upload')
  await page.evaluate(({ user }) => localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: 'receipt-owner-token', refresh_token: 'test-refresh', expires_at: Math.floor(Date.now()/1000)+3600, user })), { user })
  await page.goto('http://127.0.0.1:3190/orders')
  await expect(page.getByRole('heading', { name: 'Orders.' })).toBeVisible()
  await page.getByRole('button', { name: 'Retry now' }).first().click()
  await expect.poll(() => ownerPushes).toBeGreaterThan(0)
  syncOutcomes = true
  for (let i=0;i<3;i++) {
    if (!await page.getByRole('button', { name: 'Retry now' }).count()) break
    const retry = page.getByRole('button', { name: 'Retry now' }).first()
    await expect(retry).toBeEnabled()
    await retry.click()
    await expect(page.getByRole('button', { name: 'Sync pending orders' })).toBeEnabled()
  }
  await expect(page.getByText('Synced', { exact: true })).toHaveCount(1)
  await expect(page.getByText('Rejected / needs review', { exact: true })).toHaveCount(2)
  await page.getByRole('link', { name: 'View receipt / print' }).first().click()
  await expect(page.locator('.receipt-page .sale-receipt')).toBeVisible()
  await page.screenshot({ path: output + 'owner-receipt-1440.png', fullPage: true })
  for (const width of [375,390,768]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    if (width === 375) await page.screenshot({ path: output + 'owner-receipt-375.png', fullPage: true })
  }
  await page.goto(cardUrl)
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('CARD-APPROVED-42')
  assert.deepEqual(errors, [])
  const pdf = await readFile(output + 'receipt-80mm.pdf','latin1')
  assert.match(pdf,/\/MediaBox \[0 0 22[67]\.\d+ 56[67]\.\d+\]/)
  console.log(`PASS: cash/card checkout, offline history and URL reload, reprint/cancel/failure, no business writes from print, historical snapshots, owner/terminal sync context, all four widths, isolated 80mm PDF. Chromium ${browser.version()}`)
} finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())) }
