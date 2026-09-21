// Isolated browser acceptance test for the terminal reactivate button in ManagerSetup.tsx.
// The server-side route/migration/uniqueness logic is covered by apps/api/test/terminal-auth.test.ts;
// this proves the owner-facing UI wiring (button visibility, request, and list refresh).
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '../../apps/api/node_modules/@playwright/test/index.mjs'
import { preview } from '../../apps/web/node_modules/vite/dist/node/index.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = root + 'docs/terminal-reactivate/screenshots/'
await mkdir(output, { recursive: true })
const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
  cwd: root + 'apps/web', windowsHide: true, stdio: 'inherit',
  env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3241', VITE_SUPABASE_PUBLISHABLE_KEY: 'reactivate-test-public', VITE_API_URL: '/api' },
})
assert.equal(await new Promise(resolve => build.on('exit', resolve)), 0)
const server = await preview({ root: root + 'apps/web', preview: { host: '127.0.0.1', port: 3240, strictPort: true } })
const browser = await chromium.launch()

const store = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const revokedDevice = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const activeDevice = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())

  const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
  const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.test-signature`
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-refresh', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user }))
  }, { token, user })
  await context.route('http://127.0.0.1:3241/**', route => {
    const path = new URL(route.request().url()).pathname
    const data = path === '/auth/v1/user' ? user
      : path === '/rest/v1/store_memberships' ? [{ store_id: store }]
      : path === '/rest/v1/stores' ? [{ id: store, name: 'Reactivate Demo Store' }]
      : []
    return route.fulfill({ json: data })
  })

  let revoked = new Date().toISOString()
  let reactivateCalls = 0
  await context.route('**/api/**', route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === `/api/terminal-auth/manage/${store}`) {
      return route.fulfill({ json: { employees: [], devices: [
        { id: revokedDevice, name: 'Back Counter', receipt_prefix: 'BACK-', created_at: new Date().toISOString(), revoked_at: revoked },
        { id: activeDevice, name: 'Front Counter', receipt_prefix: 'FRONT-', created_at: new Date().toISOString(), revoked_at: null },
      ] } })
    }
    if (url.pathname === `/api/terminal-auth/devices/${revokedDevice}/reactivate` && request.method() === 'POST') {
      reactivateCalls++
      revoked = null as unknown as string
      return route.fulfill({ status: 204, body: '' })
    }
    return route.fulfill({ status: 503, json: { message: 'Unexpected request in this test' } })
  })

  await page.goto('http://127.0.0.1:3240/settings/terminals')
  await expect(page.getByRole('heading', { name: 'Terminals' })).toBeVisible()
  const revokedRow = page.locator('.terminal-list li', { hasText: 'Back Counter' })
  const activeRow = page.locator('.terminal-list li', { hasText: 'Front Counter' })
  await expect(revokedRow.locator('.terminal-state')).toHaveText('Revoked')
  await expect(revokedRow.getByRole('button', { name: 'Reactivate' })).toBeVisible()
  // An already-active terminal never shows a Reactivate button, only Revoke.
  await expect(activeRow.getByRole('button', { name: 'Reactivate' })).toHaveCount(0)
  await expect(activeRow.getByRole('button', { name: 'Revoke' })).toBeVisible()

  await page.screenshot({ path: output + 'terminals-before-reactivate-1440.png', fullPage: true })
  await revokedRow.getByRole('button', { name: 'Reactivate' }).click()
  await expect(page.getByText('Terminal reactivated.', { exact: false })).toBeVisible()
  await expect(revokedRow.locator('.terminal-state')).toHaveText('Active')
  await expect(revokedRow.getByRole('button', { name: 'Reactivate' })).toHaveCount(0)
  await expect(revokedRow.getByRole('button', { name: 'Revoke' })).toBeVisible()
  assert.equal(reactivateCalls, 1)
  await page.screenshot({ path: output + 'terminals-after-reactivate-1440.png', fullPage: true })

  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}px`)
  }

  assert.deepEqual(errors, [])
  console.log(`PASS: Reactivate button shows only on revoked terminals, calls the reactivate endpoint once, and the list updates to Active without a page reload. Chromium ${browser.version()}`)
} finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())) }
