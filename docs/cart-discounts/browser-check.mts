// Isolated browser acceptance test for FEAT-AUTH-02 / FEAT-CART-01 / FEAT-CART-02.
// Seeds only identity/catalog fixtures; every cart, discount, approval and sale under test
// runs through the real UI, the real Web Crypto PIN verifier and the real Dexie transaction.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '../../apps/api/node_modules/@playwright/test/index.mjs'
import { preview } from '../../apps/web/node_modules/vite/dist/node/index.js'
import { verifier } from '../../apps/api/src/terminal-auth/security.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = root + 'docs/cart-discounts/screenshots/'
await mkdir(output, { recursive: true })
const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
  cwd: root + 'apps/web', windowsHide: true, stdio: 'inherit',
  env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3211', VITE_SUPABASE_PUBLISHABLE_KEY: 'cart-discount-test-public', VITE_API_URL: '/api' },
})
assert.equal(await new Promise(resolve => build.on('exit', resolve)), 0)
const server = await preview({ root: root + 'apps/web', preview: { host: '127.0.0.1', port: 3210, strictPort: true } })
const browser = await chromium.launch()

const store = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const device = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const cashierId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const managerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const taxId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const categoryId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const productMug = '11111111-1111-4111-8111-111111111111'
const productTote = '22222222-2222-4222-8222-222222222222'
const productCandleA = '33333333-3333-4333-8333-333333333333'
const productCandleB = '44444444-4444-4444-8444-444444444444'
const cashierPin = '1234'
const managerPin = '5678'
const cashierVerifierRaw = await verifier(cashierPin)
const managerVerifierRaw = await verifier(managerPin)
const cashierVerifier = { version: 1, algorithm: 'PBKDF2-SHA256', iterations: 600_000, salt: cashierVerifierRaw.salt, hash: cashierVerifierRaw.hash }
const managerVerifier = { version: 1, algorithm: 'PBKDF2-SHA256', iterations: 600_000, salt: managerVerifierRaw.salt, hash: managerVerifierRaw.hash }

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript('window.__name = (value) => value')
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.route('**/api/**', route => route.fulfill({ status: 503, json: { message: 'Test service unavailable' } }))
  await page.goto('http://127.0.0.1:3210/pos/login')
  await page.evaluate(async ({ store, device, cashierId, managerId, cashierVerifier, managerVerifier, taxId, categoryId,
    productMug, productTote, productCandleA, productCandleB }) => {
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
      employees: [
        { id: cashierId, name: 'Cara Cashier', role: 'cashier', permission_version: 1, locked_until: null, verifier: cashierVerifier },
        { id: managerId, name: 'Mona Manager', role: 'manager', permission_version: 1, locked_until: null, verifier: managerVerifier },
      ],
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
      store_config: [{ id: store, store_id: store, name: 'Cart Discount Demo Store', currency: 'USD', timezone: 'UTC', catalog_version: 1 }],
      categories: [{ id: categoryId, store_id: store, name: 'General', parent_id: null, active: true }],
      tax_rates: [{ id: taxId, store_id: store, name: 'Standard', rate_bps: 500, active: true }],
      products: [
        { id: productMug, store_id: store, sku: 'MUG-001', barcode: 'BC-MUG-001', name: 'Ceramic Mug', category_id: categoryId, tax_rate_id: taxId, unit_price_cents: 1999, active: true, revision: 1 },
        { id: productTote, store_id: store, sku: 'TOTE-001', barcode: 'BC-TOTE-001', name: 'Canvas Tote', category_id: categoryId, tax_rate_id: taxId, unit_price_cents: 3200, active: true, revision: 1 },
        { id: productCandleA, store_id: store, sku: 'CANDLE-A', barcode: 'BC-DUPLICATE', name: 'Rose Candle', category_id: categoryId, tax_rate_id: taxId, unit_price_cents: 1200, active: true, revision: 1 },
        { id: productCandleB, store_id: store, sku: 'CANDLE-B', barcode: 'BC-DUPLICATE', name: 'Cedar Candle', category_id: categoryId, tax_rate_id: taxId, unit_price_cents: 1400, active: true, revision: 1 },
      ],
      server_stock: [productMug, productTote, productCandleA, productCandleB].map(id => ({ product_id: id, current_stock: 50, updated_at: now })),
      sync_metadata: [{ key: `receipt_prefix:${store}`, value: 'DEMO-' }],
    })
    await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
  }, { store, device, cashierId, managerId, cashierVerifier, managerVerifier, taxId, categoryId, productMug, productTote, productCandleA, productCandleB })

  await page.goto('http://127.0.0.1:3210/pos/register')
  await expect(page.getByRole('heading', { name: 'Current Sale' })).toBeVisible() // pre-seeded session opens the register directly, no login screen
  await expect(page.locator('.catalog-card')).toHaveCount(4)

  // 1) Add item; apply a 10% discount -> calculates correctly without manager prompt.
  await page.locator('.catalog-card', { hasText: 'Ceramic Mug' }).click()
  const mugLine = page.locator('.cart-line-wrap', { hasText: 'Ceramic Mug' })
  await expect(mugLine).toBeVisible()
  await mugLine.getByRole('button', { name: '% Discount' }).click()
  await page.locator('.discount-popover input').fill('10')
  await page.locator('.discount-popover').getByRole('button', { name: 'Apply' }).click()
  await expect(page.locator('.manager-approval-overlay')).toHaveCount(0)
  await expect(mugLine.locator('.cart-line-discount-amount')).toContainText('$2.00') // floor((1999*1000+5000)/10000) = 200 cents
  await expect(page.locator('.totals-discount')).toBeVisible()

  // 2) A 25% discount -> triggers the Manager Approval Modal.
  await mugLine.getByRole('button', { name: 'Edit discount' }).click()
  await page.locator('.discount-popover input').fill('25')
  await page.locator('.discount-popover').getByRole('button', { name: 'Apply' }).click()
  await expect(page.locator('.manager-approval-overlay')).toBeVisible()
  await expect(page.locator('.manager-approval-dialog select')).toHaveValue(managerId) // sole manager auto-selected
  await page.screenshot({ path: output + 'manager-approval-modal-1440.png', fullPage: true })

  // 3) Invalid PIN -> shows error and lockout count.
  await page.getByLabel('Manager PIN', { exact: true }).fill('0000')
  await page.locator('.manager-approval-dialog').getByRole('button', { name: 'Approve discount' }).click()
  await expect(page.locator('.manager-approval-dialog')).toContainText('PIN not accepted')
  await expect(page.locator('.manager-approval-dialog')).toContainText('attempt')

  // 4) Valid manager PIN -> modal closes, discount is applied, total recalculates.
  await page.getByLabel('Manager PIN', { exact: true }).fill(managerPin)
  await page.locator('.manager-approval-dialog').getByRole('button', { name: 'Approve discount' }).click()
  await expect(page.locator('.manager-approval-overlay')).toHaveCount(0)
  await expect(mugLine.locator('.cart-line-discount-amount')).toContainText('$5.00') // floor((1999*2500+5000)/10000) = 500 cents
  await expect(page.locator('.manager-approval-banner')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Proceed to payment' })).not.toHaveClass(/cta-disabled/)

  // 5) Edit quantity -> approval invalidates as required by the PRD.
  await mugLine.getByRole('button', { name: 'Add one Ceramic Mug' }).click()
  await expect(page.locator('.manager-approval-banner')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Proceed to payment' })).toHaveClass(/cta-disabled/)
  await page.locator('.manager-approval-banner').getByRole('button', { name: 'Get manager approval' }).click()
  await expect(page.locator('.manager-approval-overlay')).toBeVisible()
  await page.getByLabel('Manager PIN', { exact: true }).fill(managerPin)
  await page.locator('.manager-approval-dialog').getByRole('button', { name: 'Approve discount' }).click()
  await expect(page.locator('.manager-approval-overlay')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Proceed to payment' })).not.toHaveClass(/cta-disabled/)

  // 6) Scan or type barcode + Enter -> item auto-added to cart immediately.
  await page.getByPlaceholder('Search name, SKU or barcode — scan and press Enter').fill('BC-TOTE-001')
  await page.getByPlaceholder('Search name, SKU or barcode — scan and press Enter').press('Enter')
  await expect(page.locator('.cart-line-wrap', { hasText: 'Canvas Tote' })).toBeVisible()
  await expect(page.getByPlaceholder('Search name, SKU or barcode — scan and press Enter')).toHaveValue('')
  await expect(page.locator('.scan-toast')).toContainText('Canvas Tote')

  // Duplicate barcode -> visible picker, never a silent guess.
  await page.getByPlaceholder('Search name, SKU or barcode — scan and press Enter').fill('BC-DUPLICATE')
  await page.getByPlaceholder('Search name, SKU or barcode — scan and press Enter').press('Enter')
  await expect(page.locator('.scan-picker')).toBeVisible()
  await expect(page.locator('.scan-picker li')).toHaveCount(2)
  await page.locator('.scan-picker li', { hasText: 'Rose Candle' }).getByRole('button', { name: 'Add' }).click()
  await expect(page.locator('.cart-line-wrap', { hasText: 'Rose Candle' })).toBeVisible()
  await expect(page.locator('.scan-picker')).toHaveCount(0)

  // Unknown barcode -> explicit not-found message.
  await page.getByPlaceholder('Search name, SKU or barcode — scan and press Enter').fill('NOPE-DOES-NOT-EXIST')
  await page.getByPlaceholder('Search name, SKU or barcode — scan and press Enter').press('Enter')
  await expect(page.getByText('Product not found for barcode: NOPE-DOES-NOT-EXIST')).toBeVisible()

  // Adding the scanned items changed the cart again, so the earlier manager approval is
  // invalidated once more (PRD: any cart edit invalidates approval) and must be re-entered.
  await expect(page.locator('.manager-approval-banner')).toBeVisible()
  await page.locator('.manager-approval-banner').getByRole('button', { name: 'Get manager approval' }).click()
  await page.getByLabel('Manager PIN', { exact: true }).fill(managerPin)
  await page.locator('.manager-approval-dialog').getByRole('button', { name: 'Approve discount' }).click()
  await expect(page.locator('.manager-approval-overlay')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Proceed to payment' })).not.toHaveClass(/cta-disabled/)

  await page.screenshot({ path: output + 'cart-with-discount-1440.png', fullPage: true })
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}px`)
    await page.screenshot({ path: output + `register-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })

  // 7) Complete sale -> saved receipt reflects the applied discount and net totals.
  await page.getByRole('link', { name: 'Proceed to payment' }).click()
  const totalText = await page.locator('.summary-lines strong b').innerText()
  await page.getByRole('button', { name: 'Exact amount' }).click()
  await page.getByRole('button', { name: 'Complete sale' }).click()
  await expect(page).toHaveURL(/\/pos\/orders\/[a-f0-9-]+$/)
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('Discount')
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('Manager approval')
  await expect(page.locator('.receipt-page .sale-receipt .receipt-total dd')).toHaveText(totalText)
  await page.screenshot({ path: output + 'receipt-with-discount-1440.png', fullPage: true })

  // 8) Verify offline operation on terminal: reload fully offline and repeat a discounted, approved sale.
  await context.setOffline(true)
  await page.getByRole('link', { name: 'New sale' }).click()
  await expect(page.locator('.catalog-card')).toHaveCount(4)
  await page.locator('.catalog-card', { hasText: 'Canvas Tote' }).click()
  const toteLine = page.locator('.cart-line-wrap', { hasText: 'Canvas Tote' })
  await toteLine.getByRole('button', { name: '% Discount' }).click()
  await page.locator('.discount-popover input').fill('30')
  await page.locator('.discount-popover').getByRole('button', { name: 'Apply' }).click()
  await expect(page.locator('.manager-approval-overlay')).toBeVisible()
  await page.getByLabel('Manager PIN', { exact: true }).fill(managerPin)
  await page.locator('.manager-approval-dialog').getByRole('button', { name: 'Approve discount' }).click()
  await expect(page.locator('.manager-approval-overlay')).toHaveCount(0)
  await page.getByRole('link', { name: 'Proceed to payment' }).click()
  await page.getByRole('button', { name: 'Exact amount' }).click()
  await page.getByRole('button', { name: 'Complete sale' }).click()
  await expect(page).toHaveURL(/\/pos\/orders\/[a-f0-9-]+$/)
  await expect(page.locator('.receipt-page .sale-receipt')).toContainText('Discount')
  await expect(page.getByText('Sale saved in this browser.', { exact: false })).toBeVisible()
  await context.setOffline(false)

  assert.deepEqual(errors, [])
  console.log(`PASS: 10%% cashier discount, 25%% manager-gated discount with invalid/valid PIN, quantity-edit invalidation, single/duplicate/unknown barcode scan, responsive 375/390/1440, saved receipt discount+approval, fully offline discounted sale. Chromium ${browser.version()}`)
} finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())) }
