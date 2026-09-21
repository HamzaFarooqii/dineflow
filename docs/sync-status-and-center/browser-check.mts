// Isolated browser acceptance test for FEAT-STAT-02 (granular sync status) and the new
// Sync Center screen (SYNC-01/02). Seeds outbox/order fixtures directly to cover every state
// combination without needing a real server round trip.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '../../apps/api/node_modules/@playwright/test/index.mjs'
import { preview } from '../../apps/web/node_modules/vite/dist/node/index.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = root + 'docs/sync-status-and-center/screenshots/'
await mkdir(output, { recursive: true })
const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
  cwd: root + 'apps/web', windowsHide: true, stdio: 'inherit',
  env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3261', VITE_SUPABASE_PUBLISHABLE_KEY: 'sync-center-test-public', VITE_API_URL: '/api' },
})
assert.equal(await new Promise(resolve => build.on('exit', resolve)), 0)
const server = await preview({ root: root + 'apps/web', preview: { host: '127.0.0.1', port: 3260, strictPort: true } })
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
  await page.goto('http://127.0.0.1:3260/pos/login')
  await page.evaluate(async ({ store, device, cashierId }) => {
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
    const now = new Date()
    const iso = now.toISOString()
    await write('counterline-terminal-access', 10, { access: { keyPath: 'key' } }, { access: [{
      key: 'current', device: { id: device, store_id: store, name: 'Front counter', receipt_prefix: 'DEMO-' },
      employees: [{ id: cashierId, name: 'Cara Cashier', role: 'cashier', permission_version: 1, locked_until: null, verifier: { version: 1, algorithm: 'PBKDF2-SHA256', iterations: 600000, salt: '00', hash: '00' } }],
      session: { employee_id: cashierId, permission_version: 1, logged_in_at: iso, last_server_validated_at: iso },
      validated_at: iso, locked_until: null, attempts: 0, localLockedUntil: 0, lastSeen: Date.now(),
    }] })

    const order = (id: string, seq: string, syncStatus: string, failureReason: string | null) => ({
      id, store_id: store, receipt_number: `DEMO-${seq}`, subtotal_cents: 1000, discount_cents: 0, tax_cents: 50, total_cents: 1050,
      catalog_version: 1, client_generated_at: iso, sync_status: syncStatus, currency: 'USD', store_name_snapshot: 'Sync Center Demo Store',
      timezone_snapshot: 'UTC', accepted_checkpoint: null, failure_reason: failureReason, customer_id: null, manager_id: null, manager_approved_at: null,
    })
    const orderPayload = (id: string, seq: string) => JSON.stringify({ operation_id: id, order: { id, receipt_number: `DEMO-${seq}` }, items: [], payment: {} })

    const pendingId = 'aaaaaaaa-0000-4000-8000-000000000001'
    const inFlightId = 'aaaaaaaa-0000-4000-8000-000000000002'
    const blockedId = 'aaaaaaaa-0000-4000-8000-000000000003'
    const rejectedId = 'aaaaaaaa-0000-4000-8000-000000000004'
    const syncedId = 'aaaaaaaa-0000-4000-8000-000000000005'
    const customerOpId = 'bbbbbbbb-0000-4000-8000-000000000001'

    await write('counterline-pos', 50, {
      store_config: { keyPath: 'id' }, categories: { keyPath: 'id' }, tax_rates: { keyPath: 'id' },
      products: { keyPath: 'id' }, server_stock: { keyPath: 'product_id' },
      orders: { keyPath: 'id', indexes: [['receipt_number', 'receipt_number', true], ['client_generated_at', 'client_generated_at'], ['sync_status', 'sync_status'], ['store_id', 'store_id'], ['[store_id+client_generated_at]', ['store_id', 'client_generated_at']]] },
      customers: { keyPath: 'id' },
      order_items: { keyPath: 'id' }, payments: { keyPath: 'id' },
      outbox: { keyPath: 'id', autoIncrement: true, indexes: [['operation_id', 'operation_id', true], ['status', 'status'], ['next_attempt_at', 'next_attempt_at'], ['store_id', 'store_id'], ['entity_type', 'entity_type']] },
      sync_metadata: { keyPath: 'key' }, stock_adjustments: { keyPath: ['operation_id', 'product_id'] },
    }, {
      store_config: [{ id: store, store_id: store, name: 'Sync Center Demo Store', currency: 'USD', timezone: 'UTC', catalog_version: 1 }],
      orders: [
        order(pendingId, '000001', 'pending', null),
        order(inFlightId, '000002', 'pending', null),
        order(blockedId, '000003', 'pending', 'Waiting for customer to sync before this sale can proceed.'),
        order(rejectedId, '000004', 'failed', 'Sale total did not match recomputed totals.'),
        order(syncedId, '000005', 'synced', null),
      ],
      outbox: [
        { operation_id: pendingId, order_id: pendingId, store_id: store, status: 'pending', failure_reason: null, failure_kind: null, reason_code: null,
          attempt_count: 0, lease_owner: null, lease_expires_at: null, accepted_checkpoint: null, next_attempt_at: iso, created_at: iso,
          payload: orderPayload(pendingId, '000001'), entity_type: 'order', depends_on: [] },
        { operation_id: inFlightId, order_id: inFlightId, store_id: store, status: 'pending', failure_reason: null, failure_kind: null, reason_code: null,
          attempt_count: 1, lease_owner: 'worker-under-test', lease_expires_at: new Date(now.getTime() + 30_000).toISOString(), accepted_checkpoint: null,
          next_attempt_at: iso, created_at: iso, payload: orderPayload(inFlightId, '000002'), entity_type: 'order', depends_on: [] },
        { operation_id: customerOpId, order_id: customerOpId, store_id: store, status: 'pending', failure_reason: null, failure_kind: null, reason_code: null,
          attempt_count: 0, lease_owner: null, lease_expires_at: null, accepted_checkpoint: null, next_attempt_at: iso, created_at: iso,
          payload: JSON.stringify({ operation_id: customerOpId, customer: { id: 'cust-1', name: 'Priya Patel' } }), entity_type: 'customer', depends_on: [] },
        { operation_id: blockedId, order_id: blockedId, store_id: store, status: 'pending', failure_reason: 'Waiting for customer to sync before this sale can proceed.',
          failure_kind: 'dependency', reason_code: 'dependency_pending', attempt_count: 1, lease_owner: null, lease_expires_at: null, accepted_checkpoint: null,
          next_attempt_at: iso, created_at: iso, payload: orderPayload(blockedId, '000003'), entity_type: 'order', depends_on: [customerOpId] },
        { operation_id: rejectedId, order_id: rejectedId, store_id: store, status: 'failed', failure_reason: 'Sale total did not match recomputed totals.',
          failure_kind: 'validation', reason_code: 'total_mismatch', attempt_count: 2, lease_owner: null, lease_expires_at: null, accepted_checkpoint: null,
          next_attempt_at: iso, created_at: iso, payload: orderPayload(rejectedId, '000004'), entity_type: 'order', depends_on: [] },
        { operation_id: syncedId, order_id: syncedId, store_id: store, status: 'synced', failure_reason: null, failure_kind: null, reason_code: null,
          attempt_count: 1, lease_owner: null, lease_expires_at: null, accepted_checkpoint: '1', next_attempt_at: iso, created_at: iso,
          payload: orderPayload(syncedId, '000005'), entity_type: 'order', depends_on: [] },
      ],
    })
    await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
  }, { store, device, cashierId })

  // --- Dashboard: the Sync Outbox tile shows a distinct chip per state, not a single count. ---
  await page.goto('http://127.0.0.1:3260/pos/dashboard')
  await expect(page.getByRole('heading', { name: /Cara Cashier|Dashboard/i }).first()).toBeVisible()
  const syncTile = page.locator('.terminal-status-list').locator('div', { hasText: 'Sync Outbox' })
  await expect(syncTile.locator('.sync-chip.pending')).toContainText('1 pending')
  await expect(syncTile.locator('.sync-chip.in_flight')).toContainText('1 syncing')
  await expect(syncTile.locator('.sync-chip.blocked')).toContainText('1 blocked')
  await expect(syncTile.locator('.sync-chip.rejected')).toContainText('1 rejected')
  await expect(page.getByText('1 sync operation needs review. Ask a manager for assistance.')).toBeVisible()
  await page.screenshot({ path: output + 'dashboard-sync-breakdown-1440.png', fullPage: true })

  // --- Orders list: each order shows its own distinct state, not a collapsed Pending/Rejected. ---
  await page.getByRole('link', { name: 'Open Sync Center →' }).click()
  await expect(page).toHaveURL(/\/pos\/sync$/)
  await page.goto('http://127.0.0.1:3260/pos/orders')
  await expect(page.locator('article', { hasText: 'DEMO-000001' }).locator('.order-state')).toHaveText('Pending sync')
  await expect(page.locator('article', { hasText: 'DEMO-000002' }).locator('.order-state')).toHaveText('Syncing…')
  await expect(page.locator('article', { hasText: 'DEMO-000003' }).locator('.order-state')).toHaveText('Blocked — waiting on dependency')
  await expect(page.locator('article', { hasText: 'DEMO-000004' }).locator('.order-state')).toHaveText('Rejected — needs review')
  await expect(page.locator('article', { hasText: 'DEMO-000005' }).locator('.order-state')).toHaveText('Synced')
  await page.screenshot({ path: output + 'orders-granular-states-1440.png', fullPage: true })

  // --- Sync Center: full queue, filters, and diagnostic export. ---
  await page.goto('http://127.0.0.1:3260/pos/sync')
  await expect(page.getByRole('heading', { name: 'Sync Center.' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^All \(6\)$/ })).toBeVisible() // 5 orders + 1 customer
  await expect(page.getByRole('button', { name: /Pending sync \(2\)/ })).toBeVisible() // 1 order + 1 customer entry
  await expect(page.getByRole('button', { name: /Syncing… \(1\)/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Blocked.*\(1\)/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Rejected.*\(1\)/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Synced \(1\)/ })).toBeVisible()
  await expect(page.locator('.history-list article')).toHaveCount(6)
  await page.screenshot({ path: output + 'sync-center-all-1440.png', fullPage: true })

  await page.getByRole('button', { name: /Rejected.*\(1\)/ }).click()
  await expect(page.locator('.history-list article')).toHaveCount(1)
  await expect(page.locator('.history-list article').first()).toContainText('Sale total did not match recomputed totals.')
  await expect(page.locator('.history-list article').first().getByRole('button', { name: 'Retry now' })).toHaveCount(0) // rejected cannot retry
  await page.screenshot({ path: output + 'sync-center-rejected-filter-1440.png', fullPage: true })

  await page.getByRole('button', { name: /Blocked.*\(1\)/ }).click()
  await expect(page.locator('.history-list article').first().getByRole('button', { name: 'Retry now' })).toBeVisible() // blocked can retry

  await page.getByRole('button', { name: /^All \(6\)$/ }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export diagnostics (JSON)' }).click()
  const file = await download
  assert.match(file.suggestedFilename(), /^sync-diagnostics-.*\.json$/)
  const downloadPath = await file.path()
  assert(downloadPath)

  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}px`)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: output + 'sync-center-1440.png', fullPage: true })

  assert.deepEqual(errors, [])
  console.log(`PASS: dashboard tile and Orders list both show 5 distinct sync states instead of collapsed pending/rejected; Sync Center lists the full queue (orders + customers), filters by state, gates retry to pending/blocked only, and exports a diagnostic JSON download. No overflow at 375/390/1440. Chromium ${browser.version()}`)
} finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())) }
