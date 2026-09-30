import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Day 1 (API security): the server-verified manager-approval token that replaces trusting a
// client-supplied manager_id + manager_approved_at timestamp for online privileged actions
// (inventory writes, open-check discount approval). Real HTTP requests against POST
// /pos/manager-approvals for issuance, and direct calls to consumeManagerApproval for redemption
// (mirrors how the routes that consume it actually call it).
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
const { db } = await import('../db.js')
const { createApp } = await import('../app.js')
const { consumeManagerApproval, hashApprovalPayload } = await import('./manager-approval.js')

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const chain = [
  '202609130001_auth_and_stores.sql',
  '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql',
  '202609150002_terminal_device_sessions.sql',
  '202609150003_team_profile_visibility.sql',
  '202609160001_customers_and_sale_attachment.sql',
  '202609170001_change_feed_product_entity.sql',
  '202609170002_cart_discounts.sql',
  '202609180001_terminal_name_uniqueness.sql',
  '202609180002_pos_orders_report_read_access.sql',
  '202609180005_refunds.sql',
  '202609210001_restaurant_foundation.sql',
  '202609230001_kitchen_display_system.sql',
  '202609260002_staff_roles_and_shifts.sql',
  '202609270001_modifiers.sql',
  '202610010001_terminal_manager_approvals.sql',
]

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const hexToken = () => randomBytes(32).toString('hex') // 64 lowercase hex chars, the exact cookie format requireCashierTerminal's regex requires
const PORT = 3196

// One shared pool teardown: every test below monkey-patches the same module-level `db` Pool onto
// its own PGlite instance; calling `db.end()` from more than one test's finally throws, so it
// happens exactly once here instead.
after(async () => { await db.end() })

async function setup() {
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of chain) {
    await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
  }
  const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; release: () => void }> }
  const query = async (sql: string, params?: unknown[]) => {
    const result = await database.query(sql, params)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
  fixture.query = query
  fixture.connect = async () => ({ query, release: () => undefined })

  const owner = randomUUID(), store = randomUUID(), device = randomUUID(), manager = randomUUID(), cashier = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by) values ($1,'One','mgr-approval-test',$2)", [store, owner])
  const deviceAccess = 'a'.repeat(64)
  await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
    values ($1,$2,'Counter','MGR-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
    [device, store, owner, digest('refresh'), digest(deviceAccess)])
  await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
    values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(deviceAccess), digest('refresh-session')])
  const pin = '1234'
  // Real PBKDF2 verifier for the manager's PIN (same primitive as /auth/login), so
  // requestManagerApproval's own verify() call is exercised for real, not stubbed.
  const { verifier } = await import('./security.js')
  const managerCred = await verifier(pin)
  await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,'Manager One','manager',$3,$4)`,
    [manager, store, managerCred.salt, managerCred.hash])
  const cashierCred = await verifier('4321')
  await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,'Cashier One','cashier',$3,$4)`,
    [cashier, store, cashierCred.salt, cashierCred.hash])
  const cashierSessionToken = hexToken()
  await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
    values ($1,$2,$3,$4,1,now()+interval '1 day')`, [store, device, cashier, digest(cashierSessionToken)])

  return { database, store, device, manager, pin, deviceAccess, cashierToken: cashierSessionToken }
}

test('POST /pos/manager-approvals issues a token on a correct PIN, and consumeManagerApproval redeems it exactly once for the exact action/payload it was issued for', async () => {
  const { database, store, device, manager, pin, deviceAccess, cashierToken } = await setup()
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
  try {
    server = createApp({ pool: db, origin: `http://127.0.0.1:${PORT}`, supabaseUrl: 'http://127.0.0.1:3197', supabaseKey: 'fixture', secureCookies: false }).listen(PORT, '127.0.0.1')
    const base = `http://127.0.0.1:${PORT}`
    const cookie = `terminal_access=${deviceAccess}; terminal_cashier=${cashierToken}`
    const payload = { ingredient_id: randomUUID(), quantity: 5, cost_per_unit_cents: 250 }

    const request = await fetch(`${base}/pos/manager-approvals`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ manager_id: manager, pin, action: 'inventory.batch.receive', payload }),
    })
    assert.equal(request.status, 201)
    const { approval_token: approvalToken } = await request.json() as { approval_token: string; expires_at: string }
    assert.match(approvalToken, /^[a-f0-9]{64}$/)

    // Redeeming with the exact same action/payload/store/device succeeds and returns the real
    // approving manager's id.
    const redeemedManagerId = await consumeManagerApproval(db, { storeId: store, deviceId: device, action: 'inventory.batch.receive', payload, token: approvalToken })
    assert.equal(redeemedManagerId, manager)

    // Single-use: redeeming the same token again fails even with the identical action/payload.
    await assert.rejects(
      consumeManagerApproval(db, { storeId: store, deviceId: device, action: 'inventory.batch.receive', payload, token: approvalToken }),
      /invalid, expired, already used/,
    )
  } finally { server?.closeAllConnections(); server?.close(); await database.close() }
})

test('a token is rejected if redeemed for a different payload, a different action, a different device, or a forged value', async () => {
  const { database, store, device, manager, pin, deviceAccess, cashierToken } = await setup()
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
  try {
    server = createApp({ pool: db, origin: `http://127.0.0.1:${PORT + 1}`, supabaseUrl: 'http://127.0.0.1:3197', supabaseKey: 'fixture', secureCookies: false }).listen(PORT + 1, '127.0.0.1')
    const base = `http://127.0.0.1:${PORT + 1}`
    const cookie = `terminal_access=${deviceAccess}; terminal_cashier=${cashierToken}`
    const payload = { ingredient_id: randomUUID(), quantity: 5, cost_per_unit_cents: 250 }
    const issue = async () => {
      const response = await fetch(`${base}/pos/manager-approvals`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ manager_id: manager, pin, action: 'inventory.batch.receive', payload }),
      })
      return (await response.json() as { approval_token: string }).approval_token
    }

    // Payload mismatch: the quantity changed between approval and redemption.
    const tokenA = await issue()
    await assert.rejects(consumeManagerApproval(db, { storeId: store, deviceId: device, action: 'inventory.batch.receive', payload: { ...payload, quantity: 6 }, token: tokenA }), /invalid, expired, already used/)

    // Action mismatch.
    const tokenB = await issue()
    await assert.rejects(consumeManagerApproval(db, { storeId: store, deviceId: device, action: 'inventory.wastage.record', payload, token: tokenB }), /invalid, expired, already used/)

    // Device mismatch -- a token approved on one terminal cannot be redeemed as if presented by another.
    const tokenC = await issue()
    await assert.rejects(consumeManagerApproval(db, { storeId: store, deviceId: randomUUID(), action: 'inventory.batch.receive', payload, token: tokenC }), /invalid, expired, already used/)

    // A forged token (never issued) is rejected outright.
    await assert.rejects(consumeManagerApproval(db, { storeId: store, deviceId: device, action: 'inventory.batch.receive', payload, token: 'f'.repeat(64) }), /invalid, expired, already used/)

    // A correctly-issued token for the unmodified payload/action/device still redeems fine --
    // proves the rejections above are genuinely about the mismatch, not a broken issuance.
    const redeemedManagerId = await consumeManagerApproval(db, { storeId: store, deviceId: device, action: 'inventory.batch.receive', payload, token: tokenC })
    assert.equal(redeemedManagerId, manager)
  } finally { server?.closeAllConnections(); server?.close(); await database.close() }
})

test('an expired token is rejected even though it was never consumed', async () => {
  const { database, store, device, manager, pin, deviceAccess, cashierToken } = await setup()
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
  try {
    server = createApp({ pool: db, origin: `http://127.0.0.1:${PORT + 2}`, supabaseUrl: 'http://127.0.0.1:3197', supabaseKey: 'fixture', secureCookies: false }).listen(PORT + 2, '127.0.0.1')
    const base = `http://127.0.0.1:${PORT + 2}`
    const cookie = `terminal_access=${deviceAccess}; terminal_cashier=${cashierToken}`
    const payload = { ingredient_id: randomUUID(), quantity: 1 }
    const response = await fetch(`${base}/pos/manager-approvals`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ manager_id: manager, pin, action: 'inventory.wastage.record', payload }),
    })
    const { approval_token: approvalToken } = await response.json() as { approval_token: string }
    // Directly backdate the row's expiry -- simulates real elapsed time without a real sleep or
    // needing an injectable clock on a short-lived (2 minute) token's own issuance path.
    await database.query(`update public.terminal_manager_approvals set expires_at = now() - interval '1 second' where token_hash = $1`, [digest(approvalToken)])
    await assert.rejects(
      consumeManagerApproval(db, { storeId: store, deviceId: device, action: 'inventory.wastage.record', payload, token: approvalToken }),
      /invalid, expired, already used/,
    )
  } finally { server?.closeAllConnections(); server?.close(); await database.close() }
})

test('a wrong PIN is rejected and locks out after five attempts, same lockout behavior as cashier login', async () => {
  const { database, manager, deviceAccess, cashierToken } = await setup()
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
  try {
    server = createApp({ pool: db, origin: `http://127.0.0.1:${PORT + 3}`, supabaseUrl: 'http://127.0.0.1:3197', supabaseKey: 'fixture', secureCookies: false }).listen(PORT + 3, '127.0.0.1')
    const base = `http://127.0.0.1:${PORT + 3}`
    const cookie = `terminal_access=${deviceAccess}; terminal_cashier=${cashierToken}`
    const attempt = () => fetch(`${base}/pos/manager-approvals`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ manager_id: manager, pin: '0000', action: 'inventory.wastage.record', payload: { x: 1 } }),
    })
    for (let i = 0; i < 4; i++) {
      const response = await attempt()
      assert.equal(response.status, 401)
      assert.equal((await response.json() as { code: string }).code, 'pin_invalid')
    }
    // The 5th attempt is the one that TRIGGERS the lock -- same convention as /auth/login, it
    // still reports 'pin_invalid' (just at 429 instead of 401). Only a 6th attempt, arriving
    // while already locked, gets the distinct 'pin_locked' code.
    const fifth = await attempt()
    assert.equal(fifth.status, 429)
    assert.equal(fifth.headers.get('retry-after'), '60')
    assert.equal((await fifth.json() as { code: string }).code, 'pin_invalid')

    const sixth = await attempt()
    assert.equal(sixth.status, 429)
    assert.equal(sixth.headers.get('retry-after'), '60')
    assert.equal((await sixth.json() as { code: string }).code, 'pin_locked')
  } finally { server?.closeAllConnections(); server?.close(); await database.close() }
})

test('a non-manager employee id is rejected even with the correct PIN for that employee', async () => {
  const { database, deviceAccess, cashierToken } = await setup()
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
  try {
    server = createApp({ pool: db, origin: `http://127.0.0.1:${PORT + 4}`, supabaseUrl: 'http://127.0.0.1:3197', supabaseKey: 'fixture', secureCookies: false }).listen(PORT + 4, '127.0.0.1')
    const base = `http://127.0.0.1:${PORT + 4}`
    const cookie = `terminal_access=${deviceAccess}; terminal_cashier=${cashierToken}`
    const cashierRow = await database.query<{ id: string }>("select id from public.terminal_employees where role='cashier'")
    const response = await fetch(`${base}/pos/manager-approvals`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ manager_id: cashierRow.rows[0].id, pin: '4321', action: 'inventory.wastage.record', payload: { x: 1 } }),
    })
    assert.equal(response.status, 422)
    assert.equal((await response.json() as { code: string }).code, 'validation_failed')
  } finally { server?.closeAllConnections(); server?.close(); await database.close() }
})

test('hashApprovalPayload is a pure, deterministic function of its input', () => {
  assert.equal(hashApprovalPayload({ a: 1, b: 2 }), hashApprovalPayload({ a: 1, b: 2 }))
  assert.notEqual(hashApprovalPayload({ a: 1, b: 2 }), hashApprovalPayload({ a: 1, b: 3 }))
})
