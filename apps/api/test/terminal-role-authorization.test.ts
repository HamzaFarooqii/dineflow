import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Day 1 (API security): real HTTP-boundary proof of the server-side role enforcement added to
// floor.ts/kitchen.ts/inventory.ts/open-checks.ts/orders.ts/customers.ts/customer-profile.ts/
// loyalty.ts/promotions.ts/reservations.ts (requireCashierCapability, packages/domain/src/
// staff-role.ts's roleHasCapability) -- every assertion here goes through the real Express app and
// real HTTP cookies, deliberately not just the exported core functions, so a "UI bypass through a
// direct API call" (a role whose screen the frontend nav hides, but who calls the endpoint anyway)
// is the actual scenario under test, not an assumption.
process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
const { db } = await import('../src/db.js')
const { createApp } = await import('../src/app.js')

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
  '202609280002_delivery_operations.sql',
  '202609280002_reservations_waitlist.sql',
  '202609280003_split_settlement.sql',
  '202609280004_refund_settlement_integrity.sql',
  '202609290001_kitchen_operations_depth.sql',
  '202609290002_sellable_combos.sql',
  '202610010001_terminal_manager_approvals.sql',
  '202610010002_public_rate_limits.sql',
]

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const hexToken = () => randomBytes(32).toString('hex') // 64 lowercase hex chars -- the exact
  // cookie format requireCashierTerminal's own regex requires; a plain randomUUID() (36 chars,
  // with dashes) fails that check and produces a misleading 401 rather than a capability 403.
const PORT = 3187

// One shared pool teardown for the whole file -- both tests below monkey-patch the same
// module-level `db` Pool's query/connect methods onto their own PGlite instance; calling
// `db.end()` from more than one test's own finally block throws ("Called end on pool more than
// once"), so it happens exactly once here instead.
after(async () => { await db.end() })

test('server-side role enforcement: every capability-gated route across floor/kitchen/inventory/open-checks/orders/customers/loyalty/promotions/reservations denies a role that lacks the capability and allows one that has it, by real HTTP request', async () => {
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
    const query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.query = query
    fixture.connect = async () => ({ query, release: () => undefined })

    // --- Seed: one store, one other store (cross-store), a device, six employees (one per role),
    // an area/table (for floor/reservations), a product (for orders/open-checks).
    const owner = randomUUID(), store = randomUUID(), otherStore = randomUUID(), device = randomUUID()
    const area = randomUUID(), table = randomUUID(), product = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','role-auth-test',$2,'UTC')", [store, owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Two','role-auth-test-2',$2,'UTC')", [otherStore, owner])
    await database.query('insert into public.floor_areas(id,store_id,name) values ($1,$2,$3)', [area, store, 'Main Hall'])
    await database.query('insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats) values ($1,$2,$3,$4,4)', [table, store, area, 'T1'])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-1','Burger',1000)`, [product, store])
    await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,10)', [store, product])

    const deviceAccess = 'a'.repeat(64)
    await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
      values ($1,$2,'Counter','ROLE-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
      [device, store, owner, digest('refresh-token'), digest(deviceAccess)])
    await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
      values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(deviceAccess), digest('refresh-session')])

    const roles = ['cashier', 'manager', 'waiter', 'chef', 'inventory_manager', 'rider'] as const
    const employeeId: Record<typeof roles[number], string> = Object.fromEntries(roles.map(role => [role, randomUUID()])) as never
    for (const role of roles) {
      await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,$3,$4,$5,$6)`,
        [employeeId[role], store, `${role} one`, role, '1'.repeat(32), '2'.repeat(64)])
    }
    // An inactive employee (revoked), for the "inactive/revoked employee" requirement.
    const revokedCashier = randomUUID()
    await database.query(`insert into public.terminal_employees(id,store_id,name,role,active,pin_salt,pin_hash) values ($1,$2,'Revoked','cashier',false,$3,$4)`,
      [revokedCashier, store, '1'.repeat(32), '2'.repeat(64)])
    // Another store's employee, for cross-store checks.
    const otherStoreEmployee = randomUUID()
    await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,'Other Store Cashier','cashier',$3,$4)`,
      [otherStoreEmployee, otherStore, '1'.repeat(32), '2'.repeat(64)])

    // A cashier session per role, inserted directly (same convention orders-employee-attribution
    // .test.ts uses) rather than performing a real PIN login -- what's under test is the
    // capability gate, not the login flow itself (already covered by terminal-auth/security.test.ts).
    const cashierToken: Record<string, string> = {}
    async function loginAs(id: string, storeIdForSession = store) {
      const rawToken = hexToken()
      cashierToken[id] = rawToken
      await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
        values ($1,$2,$3,$4,1,now()+interval '1 day')`, [storeIdForSession, device, id, digest(rawToken)])
      return `terminal_access=${deviceAccess}; terminal_cashier=${rawToken}`
    }
    const cookies: Record<string, string> = {}
    for (const role of roles) cookies[role] = await loginAs(employeeId[role])
    cookies.revoked = await loginAs(revokedCashier)

    server = createApp({ pool: db, origin: `http://127.0.0.1:${PORT}`, supabaseUrl: 'http://127.0.0.1:3188', supabaseKey: 'fixture', secureCookies: false }).listen(PORT, '127.0.0.1')
    const base = `http://127.0.0.1:${PORT}`
    const get = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } })
    const post = (path: string, cookie: string, body: unknown) => fetch(`${base}${path}`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body),
    })

    // --- Floor: gated to 'floor' capability (waiter, manager) --------------------------------
    assert.equal((await get(`/pos/floor?store_id=${store}`, cookies.waiter)).status, 200, 'waiter has floor capability')
    assert.equal((await get(`/pos/floor?store_id=${store}`, cookies.manager)).status, 200, 'manager has every capability')
    for (const role of ['cashier', 'chef', 'inventory_manager', 'rider'] as const) {
      const res = await get(`/pos/floor?store_id=${store}`, cookies[role])
      assert.equal(res.status, 403, `${role} must not read floor data`)
      assert.equal((await res.json() as { code: string }).code, 'authorization_failed')
    }

    // --- Kitchen: gated to 'kitchen' capability (chef, manager) -------------------------------
    assert.equal((await get(`/pos/kitchen/tickets?store_id=${store}`, cookies.chef)).status, 200, 'chef has kitchen capability')
    for (const role of ['cashier', 'waiter', 'inventory_manager', 'rider'] as const) {
      assert.equal((await get(`/pos/kitchen/tickets?store_id=${store}`, cookies[role])).status, 403, `${role} must not read kitchen tickets`)
    }

    // --- Inventory: gated to 'inventory' capability (inventory_manager, manager) --------------
    assert.equal((await get(`/pos/inventory/ingredients?store_id=${store}`, cookies.inventory_manager)).status, 200, 'inventory_manager has inventory capability')
    for (const role of ['cashier', 'waiter', 'chef', 'rider'] as const) {
      assert.equal((await get(`/pos/inventory/ingredients?store_id=${store}`, cookies[role])).status, 403, `${role} must not read inventory`)
    }

    // --- Open checks: gated to 'register' capability (cashier, waiter, manager) ---------------
    assert.equal((await get(`/pos/open-checks?store_id=${store}`, cookies.cashier)).status, 200, 'cashier has register capability')
    assert.equal((await get(`/pos/open-checks?store_id=${store}`, cookies.waiter)).status, 200, 'waiter has register capability')
    for (const role of ['chef', 'inventory_manager', 'rider'] as const) {
      assert.equal((await get(`/pos/open-checks?store_id=${store}`, cookies[role])).status, 403, `${role} must not read open checks`)
    }

    // --- Customers/loyalty/promotions (checkout-adjacent reads): gated to 'register' ---------
    assert.equal((await get(`/pos/customers?store_id=${store}&name=Test`, cookies.cashier)).status, 200)
    for (const role of ['chef', 'inventory_manager', 'rider'] as const) {
      assert.equal((await get(`/pos/customers?store_id=${store}&name=Test`, cookies[role])).status, 403, `${role} must not search customers`)
    }
    assert.equal((await get(`/pos/loyalty/tiers?store_id=${store}`, cookies.cashier)).status, 200)
    assert.equal((await get(`/pos/loyalty/tiers?store_id=${store}`, cookies.chef)).status, 403)
    assert.equal((await get(`/pos/promotions?store_id=${store}`, cookies.cashier)).status, 200)
    assert.equal((await get(`/pos/promotions?store_id=${store}`, cookies.rider)).status, 403)

    // --- Reservations/waitlist: gated to 'register' capability (cashier/waiter/manager) -- a
    // plain cashier seating a waiting guest is established, tested behavior (reservations-seat
    // .test.ts), so this must allow cashier, not just waiter.
    assert.equal((await get(`/pos/reservations?store_id=${store}`, cookies.cashier)).status, 200, 'cashier has register capability')
    assert.equal((await get(`/pos/reservations?store_id=${store}`, cookies.waiter)).status, 200, 'waiter has register capability too')
    assert.equal((await get(`/pos/reservations?store_id=${store}`, cookies.chef)).status, 403, 'chef has neither register nor floor')

    // --- Rider: the existing delivery exception -- only rider (and manager) pass its own gate -
    assert.equal((await get(`/pos/delivery/mine`, cookies.rider)).status, 200)
    assert.equal((await get(`/pos/delivery/mine`, cookies.cashier)).status, 403, 'a cashier is not a rider')

    // --- Clock-in/out: deliberately UNGATED -- every terminal role can clock in/out -----------
    for (const role of roles) {
      const res = await post(`/pos/shifts/clock-in?store_id=${store}`, cookies[role], {})
      assert.equal(res.status, 201, `${role} must be able to clock in -- shifts/timekeeping have no capability gate by design`)
    }

    // --- Cross-store: a session from `store` must not read `otherStore`'s data ----------------
    const crossStore = await get(`/pos/floor?store_id=${otherStore}`, cookies.waiter)
    assert.equal(crossStore.status, 403)
    assert.equal((await crossStore.json() as { code: string }).code, 'cross_store_reference')

    // --- Inactive/revoked employee: a deactivated employee's own session cannot authenticate at
    // all (requireCashierTerminal's own join already excludes inactive employees; this proves the
    // capability-gated path inherits that, not just the plain one).
    const revokedRes = await get(`/pos/floor?store_id=${store}`, cookies.revoked)
    assert.equal(revokedRes.status, 401, 'a revoked employee cannot use a capability-gated route either')

    // --- UI bypass: even though the web nav hides Floor/Kitchen/Inventory from roles that lack
    // the capability (CashierPosLayout.tsx), a direct API call from a role that knows the URL is
    // still rejected -- the assertions above already prove this for every gated surface; this one
    // specifically re-confirms it for a write, not just a read, since a read-only bypass and a
    // write bypass are different risks.
    const chefTriesToVoidACheck = await post(`/pos/open-checks/${randomUUID()}/void`, cookies.chef, { store_id: store, expected_version: 1 })
    assert.equal(chefTriesToVoidACheck.status, 403, 'a chef must not be able to void a check merely by calling the endpoint directly')
  } finally { server?.closeAllConnections(); server?.close(); await database.close() }
})

test('open-check void attributes the authenticated session, never a client-supplied employee id', async () => {
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
    const query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.query = query
    fixture.connect = async () => ({ query, release: () => undefined })

    const owner = randomUUID(), store = randomUUID(), device = randomUUID()
    const realCashier = randomUUID(), impersonated = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','void-attr-test',$2,'UTC')", [store, owner])
    const deviceAccess = 'a'.repeat(64)
    await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
      values ($1,$2,'Counter','VOID-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
      [device, store, owner, digest('refresh-token'), digest(deviceAccess)])
    await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
      values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(deviceAccess), digest('refresh-session')])
    await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values
      ($1,$2,'Real Cashier','cashier',$4,$5), ($3,$2,'Someone Else','cashier',$4,$5)`,
      [realCashier, store, impersonated, '1'.repeat(32), '2'.repeat(64)])
    const rawToken = hexToken()
    await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
      values ($1,$2,$3,$4,1,now()+interval '1 day')`, [store, device, realCashier, digest(rawToken)])

    server = createApp({ pool: db, origin: `http://127.0.0.1:${PORT + 1}`, supabaseUrl: 'http://127.0.0.1:3188', supabaseKey: 'fixture', secureCookies: false }).listen(PORT + 1, '127.0.0.1')
    const base = `http://127.0.0.1:${PORT + 1}`
    const cookie = `terminal_access=${deviceAccess}; terminal_cashier=${rawToken}`

    const create = await fetch(`${base}/pos/open-checks`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ store_id: store, order_type: 'takeaway' }) })
    assert.equal(create.status, 201)
    const created = await create.json() as { check: { id: string; version: number } }

    // Forge voided_by_employee_id to a DIFFERENT employee than the one actually logged in --
    // the server must ignore this and attribute the void to the real session's employee instead.
    const voidRes = await fetch(`${base}/pos/open-checks/${created.check.id}/void`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ store_id: store, expected_version: created.check.version, voided_by_employee_id: impersonated }),
    })
    assert.equal(voidRes.status, 200)
    const row = await database.query('select voided_by_employee_id from public.open_checks where id=$1', [created.check.id])
    assert.equal(row.rows[0].voided_by_employee_id, realCashier, 'the void must be attributed to the authenticated session, not the forged body field')
  } finally { server?.closeAllConnections(); server?.close(); await database.close() }
})
