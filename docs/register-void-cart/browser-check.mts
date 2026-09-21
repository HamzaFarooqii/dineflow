// Isolated browser acceptance test for void-before-payment (task 5): clearing the cart before
// checkout is local-only (no server call) and now requires a deliberate confirmation.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '../../apps/api/node_modules/@playwright/test/index.mjs'
import { preview } from '../../apps/web/node_modules/vite/dist/node/index.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = root + 'docs/register-void-cart/screenshots/'
await mkdir(output, { recursive: true })
const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
  cwd: root + 'apps/web', windowsHide: true, stdio: 'inherit',
  env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3251', VITE_SUPABASE_PUBLISHABLE_KEY: 'void-cart-test-public', VITE_API_URL: '/api' },
})
assert.equal(await new Promise(resolve => build.on('exit', resolve)), 0)
const server = await preview({ root: root + 'apps/web', preview: { host: '127.0.0.1', port: 3250, strictPort: true } })
const browser = await chromium.launch()

const store = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const device = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const cashierId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const productMug = '11111111-1111-4111-8111-111111111111'

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript('window.__name = (value) => value')
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.route('**/api/**', route => route.fulfill({ status: 503, json: { message: 'Test service unavailable' } }))
  await page.goto('http://127.0.0.1:3250/pos/login')
  await page.evaluate(async ({ store, device, cashierId, productMug }) => {
    const write = (name: string, version: number, schemas: Record<string, { keyPath: string | string[]; autoIncrement?: boolean }>, values: Record<string, object[]>) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, version)
      request.onupgradeneeded = () => {
        for (const [table, schema] of Object.entries(schemas)) {
          if (request.result.objectStoreNames.contains(table)) continue
          request.result.createObjectStore(table, { keyPath: schema.keyPath, autoIncrement: schema.autoIncrement })
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
    await write('counterline-terminal-access', 10, { access: { keyPath: 'key' } }, { access: [{
      key: 'current', device: { id: device, store_id: store, name: 'Front counter', receipt_prefix: 'DEMO-' },
      employees: [{ id: cashierId, name: 'Cara Cashier', role: 'cashier', permission_version: 1, locked_until: null, verifier: { version: 1, algorithm: 'PBKDF2-SHA256', iterations: 600000, salt: '00', hash: '00' } }],
      session: { employee_id: cashierId, permission_version: 1, logged_in_at: now, last_server_validated_at: now },
      validated_at: now, locked_until: null, attempts: 0, localLockedUntil: 0, lastSeen: Date.now(),
    }] })
    await write('counterline-pos', 50, {
      store_config: { keyPath: 'id' }, categories: { keyPath: 'id' }, tax_rates: { keyPath: 'id' },
      products: { keyPath: 'id' }, server_stock: { keyPath: 'product_id' }, orders: { keyPath: 'id' },
      customers: { keyPath: 'id' }, order_items: { keyPath: 'id' }, payments: { keyPath: 'id' },
      outbox: { keyPath: 'id', autoIncrement: true }, sync_metadata: { keyPath: 'key' },
      stock_adjustments: { keyPath: ['operation_id', 'product_id'] },
    }, {
      store_config: [{ id: store, store_id: store, name: 'Void Cart Demo Store', currency: 'USD', timezone: 'UTC', catalog_version: 1 }],
      products: [{ id: productMug, store_id: store, sku: 'MUG-001', barcode: 'BC-MUG-001', name: 'Ceramic Mug', category_id: null, tax_rate_id: null, unit_price_cents: 1999, active: true, revision: 1 }],
      server_stock: [{ product_id: productMug, current_stock: 50, updated_at: now }],
      sync_metadata: [{ key: `receipt_prefix:${store}`, value: 'DEMO-' }],
    })
    await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
  }, { store, device, cashierId, productMug })

  await page.goto('http://127.0.0.1:3250/pos/register')
  await expect(page.getByRole('heading', { name: 'Current Sale' })).toBeVisible()
  await page.locator('.catalog-card', { hasText: 'Ceramic Mug' }).click()
  await expect(page.locator('.cart-line-wrap', { hasText: 'Ceramic Mug' })).toBeVisible()

  // Cancelling the confirm dialog leaves the cart untouched.
  page.once('dialog', dialog => { assert.match(dialog.message(), /void this sale/i); void dialog.dismiss() })
  await page.getByRole('button', { name: 'Clear cart' }).click()
  await expect(page.locator('.cart-line-wrap', { hasText: 'Ceramic Mug' })).toBeVisible()
  await page.screenshot({ path: output + 'confirm-dismissed-1440.png', fullPage: true })

  // Accepting the confirm dialog voids the cart, purely locally: no request goes out.
  let apiCalls = 0
  await context.route('**/api/**', route => { apiCalls++; return route.fulfill({ status: 503, json: { message: 'Test service unavailable' } }) })
  page.once('dialog', dialog => void dialog.accept())
  await page.getByRole('button', { name: 'Clear cart' }).click()
  await expect(page.getByText('Add a product to start a sale.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear cart' })).toBeDisabled()
  assert.equal(apiCalls, 0, 'Voiding the cart must not call the server')
  await page.screenshot({ path: output + 'cart-voided-1440.png', fullPage: true })

  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}px`)
  }

  assert.deepEqual(errors, [])
  console.log(`PASS: Clear cart requires a deliberate confirmation, cancelling preserves the cart, accepting voids it locally with zero API calls. Chromium ${browser.version()}`)
} finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())) }
