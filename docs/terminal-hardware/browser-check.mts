/// <reference path="../../apps/api/node_modules/@types/node/index.d.ts" />
// Verification tooling. Uses existing API test dependencies; no production test route.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(root + 'apps/api/package.json')
const { chromium, expect: baseExpect } = require('@playwright/test') as typeof import('../../apps/api/node_modules/@playwright/test')
const { build, preview, createServer } = await import(pathToFileURL(root + 'apps/web/node_modules/vite/dist/node/index.js').href) as typeof import('../../apps/web/node_modules/vite')
declare global { interface Window { __printCalls?: number } }
const expect = baseExpect.configure({ timeout: 20000 })
const output = root + 'docs/terminal-hardware/screenshots/'
await mkdir(output, { recursive: true })
process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:3185'
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'test-publishable'
const webRoot = root + 'apps/web'
await build({ root: webRoot })
const production = await preview({ root: webRoot, preview: { host: '127.0.0.1', port: 3184, strictPort: true } })
const dev = await createServer({ root: webRoot, server: { port: 3186, strictPort: true }, plugins: [{ name: 'hardware-fixture-only', configureServer(server) {
  server.middlewares.use('/hardware-fixture', async (_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(await server.transformIndexHtml('/hardware-fixture', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/terminal-auth/hardware/testing/fixture.tsx"></script></body></html>'))
  })
} }] })
await dev.listen()
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())
  const store = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const device = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const owner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'hardware@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
  const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.test-signature`
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-refresh', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user }))
  }, { token, user })
  await context.route('http://127.0.0.1:3185/**', route => {
    const path = new URL(route.request().url()).pathname
    const data = path === '/auth/v1/user' ? user : path === '/rest/v1/stores' ? [{ id: store, name: 'Hardware Demo Store' }] : [{ store_id: store, role: 'owner' }]
    return route.fulfill({ json: data })
  })
  const writes: string[] = []
  await context.route('**/api/**', route => {
    if (route.request().method() !== 'GET') { writes.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 503, json: { message: 'No writes allowed in hardware checks' } }) }
    return route.fulfill({ json: { devices: [{ id: device, name: 'Front counter', receipt_prefix: 'HARDWARE-TEST-', created_at: new Date().toISOString(), revoked_at: null }], employees: [] } })
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:3184/settings', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('link', { name: /Manage terminals/i }).first()).toBeVisible()
  await page.waitForFunction(async () => (await indexedDB.databases()).some(database => database.name === 'counterline-terminal-access' && (database.version ?? 0) >= 10))
  // Seed only terminal metadata for this test profile. No scanner or business data.
  await page.evaluate(async ({ store, device }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('counterline-terminal-access'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('access', 'readwrite')
      transaction.objectStore('access').put({ key: 'current', device: { id: device, store_id: store, name: 'Front counter', receipt_prefix: 'HARDWARE-TEST-' }, validated_at: new Date().toISOString(), locked_until: null, employees: [], attempts: 0, localLockedUntil: 0, lastSeen: Date.now() })
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error)
    }); database.close()
  }, { store, device })
  await page.getByRole('link', { name: /Manage terminals/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Terminal hardware & storage' })).toBeVisible()
  await expect(page.getByText('Authorized locally', { exact: true })).toBeVisible()
  async function storedData() {
    return page.evaluate(async () => {
      const result: Record<string, Record<string, unknown[]>> = {}
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(info.name!); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        const contents: Record<string, unknown[]> = {}
        for (const name of db.objectStoreNames) contents[name] = await new Promise<unknown[]>((resolve, reject) => { const request = db.transaction(name).objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        result[info.name] = contents; db.close()
      }
      return { databases: result, local: { ...localStorage }, session: { ...sessionStorage } }
    })
  }
  const before = await storedData()
  await page.getByLabel('Scan test value').focus()
  await page.keyboard.type('HID-TEST-12345')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Scan captured.', { exact: true })).toBeVisible()
  await expect(page.locator('.scanner-value')).toHaveText('HID-TEST-12345')
  await expect(page.locator('.hardware-details').filter({ hasText: 'Character count' })).toContainText('14')
  await page.getByRole('button', { name: 'Clear scanner test' }).click()
  await expect(page.getByLabel('Scan test value')).toBeFocused()
  await expect(page.locator('.scanner-value')).toHaveCount(0)
  await page.keyboard.type('SCAN-SECOND')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Capture test value' })).toBeFocused()
  assert(await page.getByRole('button', { name: 'Capture test value' }).evaluate(node => getComputedStyle(node).outlineStyle !== 'none'))
  await page.evaluate(() => { window.print = () => { window.__printCalls = (window.__printCalls ?? 0) + 1 } })
  await page.getByRole('button', { name: 'Print test receipt' }).click()
  await expect(page.getByText('Print dialog requested.', { exact: false })).toBeVisible()
  assert.equal(await page.evaluate(() => window.__printCalls), 1)
  assert.deepEqual(await storedData(), before)
  assert.deepEqual(writes, [])
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready })
  await page.getByRole('button', { name: 'Check device status' }).click()
  await expect(page.getByText('Ready for offline cashier launch', { exact: true })).toBeVisible()
  const storageRequest = page.getByRole('button', { name: 'Request persistent storage' })
  if (await storageRequest.isEnabled()) {
    await storageRequest.click()
    await expect(page.locator('section[aria-labelledby="storage-heading"]').getByRole('status')).toContainText(/Persistent storage granted|browser did not grant persistent storage/)
  }
  await page.getByRole('button', { name: 'Clear scanner test' }).click()
  for (const width of [375, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}`)
    await page.screenshot({ path: `${output}terminals-${width}.png`, fullPage: true })
  }
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('#root')).toBeHidden()
  await expect(page.locator('.terminal-test-print')).toBeVisible()
  await expect(page.locator('.terminal-test-print')).toContainText('TEST RECEIPT — NOT A SALE')
  await expect(page.locator('.terminal-test-print')).toContainText('32.55')
  const printBounds = await page.locator('.terminal-test-print').boundingBox()
  assert(printBounds)
  assert(Math.abs(printBounds.width - 72 * 96 / 25.4) < 1)
  await page.pdf({ path: output + 'test-receipt-80mm.pdf', preferCSSPageSize: true, printBackground: true })
  const pdf = (await readFile(output + 'test-receipt-80mm.pdf')).toString('latin1')
  const mediaBox = pdf.match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/)
  assert(mediaBox)
  assert(Math.abs(Number(mediaBox[1]) - 80 * 72 / 25.4) < 1)
  assert(Math.abs(Number(mediaBox[2]) - 200 * 72 / 25.4) < 1)
  assert.equal([...pdf.matchAll(/\/Type\s*\/Page\b/g)].length, 1)
  await page.locator('.terminal-test-print').screenshot({ path: output + 'test-receipt-print.png' })
  await page.emulateMedia({ media: 'screen' })
  await context.setOffline(true)
  await expect(page.getByText('Browser offline', { exact: true })).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByText('Browser online', { exact: true })).toBeVisible()
  assert.deepEqual(await storedData(), before)
  assert.deepEqual(errors, [])
  // After proving hardware checks made no writes, verify the ready shell really
  // opens the cashier route offline. The existing cashier route updates its own
  // authorization clock metadata, outside the hardware no-write assertion.
  await context.setOffline(true)
  const offlinePage = await context.newPage()
  await offlinePage.goto('http://127.0.0.1:3184/pos/login', { waitUntil: 'domcontentloaded' })
  await expect(offlinePage.getByRole('heading', { name: 'Unlock Front counter' })).toBeVisible()
  await offlinePage.close()
  await context.setOffline(false)
  // Exercise unsupported/denied/error states with the typed component adapter.
  const fixture = await context.newPage()
  for (const [scenario, text] of [['unsupported', 'Not supported'], ['expired', 'Offline authorization expired'], ['revoked', 'Revoked — manager setup required'], ['rollback', 'Clock changed — online validation required'], ['identity-error', 'Terminal identity could not be read.'], ['storage-error', 'Browser storage status is unavailable.'], ['shell-error', 'Offline app status unavailable'], ['empty', 'This browser has no terminal identity'], ['other-store', 'This browser is provisioned for a different store.']]) {
    await fixture.goto(`http://127.0.0.1:3186/hardware-fixture?scenario=${scenario}`, { waitUntil: 'domcontentloaded' })
    await expect(fixture.getByText(text, { exact: false }).first()).toBeVisible()
  }
  for (const [scenario, text] of [['denied', 'The browser did not grant persistent storage.'], ['granted', 'Persistent storage granted.'], ['request-error', 'Could not request persistent storage.']]) {
    await fixture.goto(`http://127.0.0.1:3186/hardware-fixture?scenario=${scenario}`, { waitUntil: 'domcontentloaded' })
    await fixture.getByRole('button', { name: 'Request persistent storage' }).click()
    await expect(fixture.getByText(text, { exact: false })).toBeVisible()
  }
  await fixture.goto('http://127.0.0.1:3186/hardware-fixture?scenario=print-error', { waitUntil: 'domcontentloaded' })
  await fixture.getByRole('button', { name: 'Print test receipt' }).click()
  await expect(fixture.getByRole('alert')).toContainText('The print dialog could not be opened')
  console.log(`PASS: existing Settings entry, identity, connection changes, scanner Enter/clear/keyboard focus, print isolation/80mm PDF, unchanged IndexedDB/local/session storage and zero API writes, 4 responsive widths, capability/error/recovery states. Chromium ${browser.version()}; physical scanner/printer not attached.`)
} finally {
  await browser.close()
  await dev.close()
  await new Promise<void>(resolve => production.httpServer.close(() => resolve()))
}
