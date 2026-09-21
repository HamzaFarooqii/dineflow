// Isolated browser acceptance test for the mandatory owner onboarding wizard (OnboardingWizard.tsx).
// Server-side RPC/route validation belongs to supabase/migrations and apps/api tests; this proves the
// owner-facing UI wiring: signup lands on /onboarding, all three steps submit, and the wizard finishes
// on /dashboard without looping back.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '../../apps/api/node_modules/@playwright/test/index.mjs'
import { preview } from '../../apps/web/node_modules/vite/dist/node/index.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = root + 'docs/owner-onboarding/screenshots/'
await mkdir(output, { recursive: true })
const build = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', 'build'], {
  cwd: root + 'apps/web', windowsHide: true, stdio: 'inherit',
  env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3251', VITE_SUPABASE_PUBLISHABLE_KEY: 'onboarding-test-public', VITE_API_URL: '/api' },
})
assert.equal(await new Promise(resolve => build.on('exit', resolve)), 0)
const server = await preview({ root: root + 'apps/web', preview: { host: '127.0.0.1', port: 3250, strictPort: true } })
const browser = await chromium.launch()

const store = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await context.route('https://fonts.gstatic.com/**', route => route.abort())

  const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: { full_name: 'Owner', store_name: 'Riverside General' }, created_at: new Date().toISOString() }
  const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })).toString('base64url')}.test-signature`
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-refresh', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user }))
  }, { token, user })

  let onboardingCompleted = false
  await context.route('http://127.0.0.1:3251/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/auth/v1/user') return route.fulfill({ json: user })
    if (url.pathname === '/rest/v1/store_memberships') return route.fulfill({ json: [{ store_id: store, role: 'owner' }] })
    if (url.pathname === '/rest/v1/stores') return route.fulfill({ json: { id: store, name: 'Riverside General', timezone: 'UTC', currency: 'USD', onboarding_completed_at: onboardingCompleted ? new Date().toISOString() : null } })
    if (url.pathname === '/rest/v1/rpc/accept_store_invites') return route.fulfill({ json: 0 })
    if (url.pathname === '/rest/v1/rpc/update_store_profile') return route.fulfill({ json: null })
    if (url.pathname === '/rest/v1/rpc/complete_store_onboarding') { onboardingCompleted = true; return route.fulfill({ json: null }) }
    return route.fulfill({ json: null })
  })
  await context.route('**/api/**', route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/devices/provision' && request.method() === 'POST') {
      return route.fulfill({ json: { device: { id: 'device-1', name: 'Front Counter 1', receipt_prefix: 'FRONT-' }, employees: [], session: undefined, locked_until: null, validated_at: new Date().toISOString() } })
    }
    if (url.pathname === '/api/terminal-auth/employees' && request.method() === 'POST') {
      return route.fulfill({ json: { id: 'employee-1', name: 'Cashier One', role: 'cashier', active: true, permission_version: 1 } })
    }
    return route.fulfill({ status: 404, json: { code: 'not_found', message: 'unmocked route' } })
  })

  await page.goto('http://127.0.0.1:3250/onboarding')
  await expect(page.getByRole('heading', { name: 'Store profile' })).toBeVisible()
  await page.screenshot({ path: `${output}step-1-store-profile-1440.png` })

  await page.getByLabel('Store name').fill('Riverside General Store')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible()
  await page.screenshot({ path: `${output}step-2-terminal-1440.png` })

  await page.getByLabel('Terminal name').fill('Front Counter 1')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Staff' })).toBeVisible()
  await page.screenshot({ path: `${output}step-3-staff-1440.png` })

  await page.getByLabel('Cashier name').fill('Cashier One')
  await page.getByLabel('PIN').fill('1234')
  await page.getByRole('button', { name: 'Finish setup' }).click()

  await page.waitForURL('**/dashboard')
  // Regression guard for the redirect-loop bug caught in code review: must stay on /dashboard.
  await page.waitForTimeout(500)
  assert.equal(new URL(page.url()).pathname, '/dashboard', 'must not bounce back to /onboarding after finishing')
  await page.screenshot({ path: `${output}dashboard-after-onboarding-1440.png` })

  assert.deepEqual(errors, [], `Unexpected page errors: ${errors.join(', ')}`)
  console.log('owner-onboarding browser-check passed')
} finally {
  await browser.close()
  await server.close()
}
