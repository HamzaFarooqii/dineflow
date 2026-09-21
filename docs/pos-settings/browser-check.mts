// Isolated browser acceptance test for FEAT-SET-01's cashier-facing /pos/settings screen.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '../../apps/api/node_modules/@playwright/test/index.mjs'
import { preview } from '../../apps/web/node_modules/vite/dist/node/index.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = root + 'docs/pos-settings/screenshots/'
await mkdir(output, { recursive: true })
const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
  cwd: root + 'apps/web', windowsHide: true, stdio: 'inherit',
  env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3231', VITE_SUPABASE_PUBLISHABLE_KEY: 'pos-settings-test-public', VITE_API_URL: '/api' },
})
assert.equal(await new Promise(resolve => build.on('exit', resolve)), 0)
const server = await preview({ root: root + 'apps/web', preview: { host: '127.0.0.1', port: 3230, strictPort: true } })
const browser = await chromium.launch()

const store = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const device = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const cashierId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript('window.__name = (value) => value')
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  await context.route('**/api/**', route => route.fulfill({ status: 503, json: { message: 'Test service unavailable' } }))
  await page.goto('http://127.0.0.1:3230/pos/login')
  await page.evaluate(async ({ store, device, cashierId }) => {
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
    }, { store_config: [{ id: store, store_id: store, name: 'Settings Demo Store', currency: 'USD', timezone: 'UTC', catalog_version: 1 }] })
    await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
  }, { store, device, cashierId })

  // Reach /pos/settings via the cashier nav link, not a direct URL, to prove it is wired in.
  await page.goto('http://127.0.0.1:3230/pos/register')
  await expect(page.getByRole('heading', { name: 'Current Sale' })).toBeVisible()
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/pos\/settings$/)
  await expect(page.getByRole('heading', { name: 'Terminal hardware & storage' })).toBeVisible()

  // Identity resolves from local terminal cache — no owner Supabase session involved.
  await expect(page.getByText('Authorized locally', { exact: true })).toBeVisible()
  const identity = page.locator('.identity-details')
  await expect(identity).toContainText('Front counter')
  await expect(identity).toContainText('Settings Demo Store')
  await expect(identity).toContainText('DEMO-')

  // No owner-only actions leak onto the cashier page.
  await expect(page.getByRole('link', { name: /manage cashier employees/i })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /terminal provisioning/i })).toHaveCount(0)

  // Storage, scanner and printer panels are all present and functional.
  await expect(page.getByRole('heading', { name: 'Browser storage' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Keyboard scanner test' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '80 mm printer test' })).toBeVisible()

  await page.getByLabel('Scan test value').fill('TEST-BARCODE-001')
  await page.getByRole('button', { name: 'Capture test value' }).click()
  await expect(page.getByText('Scan captured.')).toBeVisible()
  await expect(page.locator('.scanner-value')).toHaveText('TEST-BARCODE-001')

  await page.evaluate(() => { window.print = () => {} })
  await page.getByRole('button', { name: 'Print test receipt' }).click()
  await expect(page.getByText('Print dialog requested.', { exact: false })).toBeVisible()

  await page.screenshot({ path: output + 'settings-1440.png', fullPage: true })
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}px`)
    await page.screenshot({ path: output + `settings-${width}.png`, fullPage: true })
  }

  assert.deepEqual(errors, [])
  console.log(`PASS: cashier /pos/settings is nav-linked, shows local terminal identity with no owner-only actions, storage/scanner/printer panels all work, no overflow at 375/390/1440. Chromium ${browser.version()}`)
} finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())) }
