import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Integration fix: qr-ordering.ts's public/staff routes shipped with qr-security-hooks.ts's
// allow-all defaults by design (feature/bisma/day1-qr-ordering's own PR explicitly left this for
// "whoever wires the QR routes" -- see rate-limit.ts's header comment). This proves
// qr-security-integration.ts's real hooks -- built from the Day 1 security branch's own
// requireCashierCapability and checkRateLimit, not a parallel QR-specific copy -- actually gate
// the public surface once installed, by real HTTP request against the real Express app, the same
// standard terminal-role-authorization.test.ts holds the rest of the capability matrix to.
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
process.env.QR_ORDERING_ENABLED = 'true'
const { db } = await import('../src/db.js')
const { createApp } = await import('../src/app.js')
const { buildQrSecurityHooks } = await import('../src/routes/qr-security-integration.js')
const { setQrSecurityHooks, resetQrSecurityHooks } = await import('../src/routes/qr-security-hooks.js')
const { rotateQrCode, issueQrSession } = await import('../src/routes/qr-ordering.js')

const root = fileURLToPath(new URL('../../../', import.meta.url))
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
  '202609230002_table_waiter_assignment.sql',
  '202609240001_units_and_recipes.sql',
  '202609240002_ingredient_inventory.sql',
  '202609240003_inventory_audit_columns.sql',
  '202609240004_inventory_terminal_audit.sql',
  '202609250001_loyalty_foundation.sql',
  '202609250002_inventory_batch_tracking.sql',
  '202609250003_promotions.sql',
  '202609260001_unit_conversion.sql',
  '202609260002_staff_roles_and_shifts.sql',
  '202609260003_service_charge.sql',
  '202609270001_modifiers.sql',
  '202609280001_inventory_terminal_tenant_fks.sql',
  '202609280002_open_checks.sql',
  '202609280003_split_settlement.sql',
  '202609280004_refund_settlement_integrity.sql',
  '202609290001_kitchen_operations_depth.sql',
  '202609290002_sellable_combos.sql',
  '202609300001_qr_table_ordering.sql',
  '202610010001_terminal_manager_approvals.sql',
  '202610010002_public_rate_limits.sql',
]

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const hexToken = () => randomBytes(32).toString('hex')
const PORT = 3188

after(async () => { await db.end() })

test('QR security integration: staff role enforcement and public rate limiting are real once wired, by HTTP request', async () => {
  const database = new PGlite()
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
    for (const name of chain) {
      await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
    }

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; release: () => void }> }
    let gate: Promise<void> = Promise.resolve()
    const query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.query = query
    // One PGlite connection serializes transactions; a gate matches the real row-lock ordering
    // every QR write path already relies on (same technique qr-ordering.test.ts uses).
    fixture.connect = async () => {
      const previous = gate
      let release!: () => void
      gate = new Promise<void>(resolve => { release = resolve })
      await previous
      return { query, release }
    }

    const owner = randomUUID(), store = randomUUID(), area = randomUUID(), table = randomUUID(), device = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','qr-sec-test',$2,'UTC')", [store, owner])
    await database.query('insert into public.floor_areas(id,store_id,name) values ($1,$2,$3)', [area, store, 'Main Hall'])
    await database.query("insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats,status) values ($1,$2,$3,'T1',4,'seated')", [table, store, area])

    const deviceAccess = 'a'.repeat(64)
    await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
      values ($1,$2,'Counter','QR-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
      [device, store, owner, digest('refresh-token'), digest(deviceAccess)])
    await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
      values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(deviceAccess), digest('refresh-session')])

    const roles = ['cashier', 'chef', 'rider'] as const
    const employeeId: Record<typeof roles[number], string> = Object.fromEntries(roles.map(role => [role, randomUUID()])) as never
    for (const role of roles) {
      await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,$3,$4,$5,$6)`,
        [employeeId[role], store, `${role} one`, role, '1'.repeat(32), '2'.repeat(64)])
    }
    const cookies: Record<string, string> = {}
    for (const role of roles) {
      const rawToken = hexToken()
      await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
        values ($1,$2,$3,$4,1,now()+interval '1 day')`, [store, device, employeeId[role], digest(rawToken)])
      cookies[role] = `terminal_access=${deviceAccess}; terminal_cashier=${rawToken}`
    }

    // Install the real wiring under test -- this is the exact call server.ts makes before listening.
    setQrSecurityHooks(buildQrSecurityHooks(db as never))

    server = createApp({ pool: db, origin: `http://127.0.0.1:${PORT}`, supabaseUrl: 'http://127.0.0.1:3189', supabaseKey: 'fixture', secureCookies: false }).listen(PORT, '127.0.0.1')
    const base = `http://127.0.0.1:${PORT}`
    const get = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } })

    // --- staff role enforcement: terminal confirm/reject/list needs 'register' (cashier/waiter/
    // manager), not just any logged-in terminal employee -- a chef or rider has no business
    // accepting a guest's QR order onto the table's check. ------------------------------------
    assert.equal((await get(`/pos/qr/submissions?store_id=${store}`, cookies.cashier)).status, 200, 'cashier (register capability) may list QR submissions')
    for (const role of ['chef', 'rider'] as const) {
      const res = await get(`/pos/qr/submissions?store_id=${store}`, cookies[role])
      assert.equal(res.status, 403, `${role} must not list QR submissions`)
      assert.equal((await res.json() as { code: string }).code, 'authorization_failed')
    }
    const confirmAsChef = await fetch(`${base}/pos/qr/submissions/${randomUUID()}/confirm?store_id=${store}`, { method: 'POST', headers: { Cookie: cookies.chef, Origin: base, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(confirmAsChef.status, 403, 'chef must not confirm a QR submission, even one that does not exist -- the role gate runs first')

    // --- public rate limiting: real budgets, real 429s, before any QR work happens. -----------
    // Sequential, not concurrent: what's under test is that the budget is enforced at all, not a
    // race -- concurrent writers to the single PGlite fixture connection are exercised plenty
    // elsewhere (qr-ordering.test.ts's own concurrent-submission tests, through inTransaction's
    // gated connect()); checkRateLimit calls pool.query() directly, outside that gate.
    const { RATE_LIMIT_BUDGETS } = await import('../src/lib/rate-limit.js')
    const { code } = await rotateQrCode(store, table)
    const sessionStatuses: number[] = []
    for (let i = 0; i < RATE_LIMIT_BUDGETS.qrSessionCreate.max + 3; i++) {
      const response = await fetch(`${base}/public/qr/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ code }) })
      sessionStatuses.push(response.status)
      if (response.status === 429) assert.equal((await response.json() as { code: string }).code, 'rate_limited')
    }
    assert.ok(sessionStatuses.includes(429), 'session creation is rate limited once the shared budget is exceeded')

    const issued = await issueQrSession(code)
    const orderStatuses: number[] = []
    for (let i = 0; i < RATE_LIMIT_BUDGETS.qrOrderSubmit.max + 3; i++) {
      const response = await fetch(`${base}/public/qr/orders`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base, authorization: `Bearer ${issued.session_token}` },
        body: JSON.stringify({ operation_id: randomUUID(), items: [{ product_id: randomUUID(), quantity: 1, modifier_option_ids: [] }] }),
      })
      orderStatuses.push(response.status)
    }
    assert.ok(orderStatuses.includes(429), 'order submission is rate limited once the session budget is exceeded')
  } finally {
    resetQrSecurityHooks()
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  }
})
