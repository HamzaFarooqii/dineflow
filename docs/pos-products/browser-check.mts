// Isolated browser acceptance test for FEAT-CAT-01's cashier-facing /pos/products screen.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '../../apps/api/node_modules/@playwright/test/index.mjs'
import { preview } from '../../apps/web/node_modules/vite/dist/node/index.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = root + 'docs/pos-products/screenshots/'
await mkdir(output, { recursive: true })
const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
  cwd: root + 'apps/web', windowsHide: true, stdio: 'inherit',
  env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3221', VITE_SUPABASE_PUBLISHABLE_KEY: 'pos-products-test-public', VITE_API_URL: '/api' },
})
assert.equal(await new Promise(resolve => build.on('exit', resolve)), 0)
const server = await preview({ root: root + 'apps/web', preview: { host: '127.0.0.1', port: 3220, strictPort: true } })
const browser = await chromium.launch()

const store = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const device = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const cashierId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const taxId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const categoryId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const productMug = '11111111-1111-4111-8111-111111111111'
const productTote = '22222222-2222-4222-8222-222222222222'
const productLow = '33333333-3333-4333-8333-333333333333'
const productOut = '44444444-4444-4444-8444-444444444444'

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript('window.__name = (value) => value')
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.route('**/api/**', route => route.fulfill({ status: 503, json: { message: 'Test service unavailable' } }))
  await page.goto('http://127.0.0.1:3220/pos/login')
  await page.evaluate(async ({ store, device, cashierId, taxId, categoryId, productMug, productTote, productLow, productOut }) => {
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
    await write('counterline-terminal-access', 10, { access: { keyPath: 'key' } }, { access: [{
      key: 'current', device: { id: device, store_id: store, name: 'Front counter', receipt_prefix: 'DEMO-' },
      employees: [{ id: cashierId, name: 'Cara Cashier', role: 'cashier', permission_version: 1, locked_until: null, verifier: { version: 1, algorithm: 'PBKDF2-SHA256', iterations: 600000, salt: '00', hash: '00' } }],
      session: { employee_id: cashierId, permission_version: 1, logged_in_at: now, last_server_validated_at: now },
      validated_at: now, locked_until: null, attempts: 0, localLockedUntil: 0, lastSeen: Date.now(),
    }] })
    await write('counterline-pos', 50, {
      store_config: { keyPath: 'id' },
      categories: { keyPath: 'id', indexes: [['store_id', 'store_id'], ['active', 'active']] },
      tax_rates: { keyPath: 'id', indexes: [['store_id', 'store_id'], ['active', 'active']] },
      products: { keyPath: 'id', indexes: [['[store_id+sku]', ['store_id', 'sku'], true], ['[store_id+barcode]', ['store_id', 'barcode']], ['[store_id+category_id]', ['store_id', 'category_id']], ['active', 'active'], ['store_id', 'store_id']] },
      server_stock: { keyPath: 'product_id' },
      orders: { keyPath: 'id', indexes: [['receipt_number', 'receipt_number', true], ['client_generated_at', 'client_generated_at'], ['sync_status', 'sync_status'], ['store_id', 'store_id'], ['[store_id+client_generated_at]', ['store_id', 'client_generated_at']], ['customer_id', 'customer_id']] },
      customers: { keyPath: 'id', indexes: [['store_id', 'store_id'], ['[store_id+phone_normalized]', ['store_id', 'phone_normalized']], ['creating_operation_id', 'creating_operation_id'], ['sync_status', 'sync_status']] },
      order_items: { keyPath: 'id', indexes: [['order_id', 'order_id'], ['product_id', 'product_id']] },
      payments: { keyPath: 'id', indexes: [['order_id', 'order_id', true]] },
      outbox: { keyPath: 'id', autoIncrement: true, indexes: [['operation_id', 'operation_id', true], ['status', 'status'], ['next_attempt_at', 'next_attempt_at'], ['store_id', 'store_id'], ['entity_type', 'entity_type']] },
      sync_metadata: { keyPath: 'key' },
      stock_adjustments: { keyPath: ['operation_id', 'product_id'], indexes: [['product_id', 'product_id'], ['operation_id', 'operation_id']] },
    }, {
      store_config: [{ id: store, store_id: store, name: 'POS Products Demo Store', currency: 'USD', timezone: 'UTC', catalog_version: 1 }],
      categories: [{ id: categoryId, store_id: store, name: 'General', parent_id: null, active: true }],
      tax_rates: [{ id: taxId, store_id: store, name: 'Standard', rate_bps: 500, active: true }],
      products: [
        { id: productMug, store_id: store, sku: 'MUG-001', barcode: 'BC-MUG-001', name: 'Ceramic Mug', category_id: categoryId, tax_rate_id: taxId, unit_price_cents: 1999, active: true, revision: 1 },
        { id: productTote, store_id: store, sku: 'TOTE-001', barcode: 'BC-TOTE-001', name: 'Canvas Tote', category_id: categoryId, tax_rate_id: taxId, unit_price_cents: 3200, active: true, revision: 1 },
        { id: productLow, store_id: store, sku: 'CANDLE-A', barcode: 'BC-CANDLE-A', name: 'Rose Candle', category_id: categoryId, tax_rate_id: taxId, unit_price_cents: 1200, active: true, revision: 1 },
        { id: productOut, store_id: store, sku: 'SCARF-001', barcode: 'BC-SCARF-001', name: 'Wool Scarf', category_id: categoryId, tax_rate_id: taxId, unit_price_cents: 4800, active: true, revision: 1 },
        { id: 'inactive-item', store_id: store, sku: 'OLD-001', barcode: null, name: 'Discontinued Soap', category_id: categoryId, tax_rate_id: taxId, unit_price_cents: 500, active: false, revision: 1 },
      ],
      server_stock: [
        { product_id: productMug, current_stock: 50, updated_at: now },
        { product_id: productTote, current_stock: 20, updated_at: now },
        { product_id: productLow, current_stock: 3, updated_at: now },
        { product_id: productOut, current_stock: 0, updated_at: now },
      ],
      sync_metadata: [{ key: `receipt_prefix:${store}`, value: 'DEMO-' }],
    })
    await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
  }, { store, device, cashierId, taxId, categoryId, productMug, productTote, productLow, productOut })

  // Reach /pos/products via the cashier nav link, not a direct URL, to prove it is wired into the sidebar.
  await page.goto('http://127.0.0.1:3220/pos/register')
  await expect(page.getByRole('heading', { name: 'Current Sale' })).toBeVisible()
  await page.getByRole('link', { name: 'Products' }).click()
  await expect(page).toHaveURL(/\/pos\/products$/)
  await expect(page.getByRole('heading', { name: 'The menu.' })).toBeVisible()

  // Read-only: no add/edit affordance anywhere on the page.
  await expect(page.getByRole('button', { name: /add product/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /edit/i })).toHaveCount(0)

  // Only the 4 active products show; the inactive one is excluded (matches FEAT-CAT-01).
  await expect(page.locator('.pc-row')).toHaveCount(4)
  await expect(page.getByText('Discontinued Soap')).toHaveCount(0)
  await expect(page.locator('.pc-stat-value').nth(0)).toHaveText('4')

  // Search and category filter work.
  await page.getByLabel('Search products').fill('tote')
  await expect(page.locator('.pc-row')).toHaveCount(1)
  await expect(page.getByText('Canvas Tote')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.locator('.pc-row')).toHaveCount(4)

  // Stock badges reflect low/out of stock state.
  await expect(page.locator('.pc-row', { hasText: 'Rose Candle' }).locator('.pc-stock-pill')).toContainText('Low Stock')
  await expect(page.locator('.pc-row', { hasText: 'Wool Scarf' }).locator('.pc-stock-pill')).toContainText('Out of Stock')

  await page.screenshot({ path: output + 'products-1440.png', fullPage: true })
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}px`)
    await page.screenshot({ path: output + `products-${width}.png`, fullPage: true })
  }

  assert.deepEqual(errors, [])
  console.log(`PASS: cashier /pos/products is read-only, nav-linked, filters correctly, hides inactive products, shows stock state, no overflow at 375/390/1440. Chromium ${browser.version()}`)
} finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())) }
