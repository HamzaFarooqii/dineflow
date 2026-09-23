import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Same pattern as reports.test.ts: pure validation never opens a connection; the PGlite-backed
// test below monkey-patches db.query before use.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { storeIdParam, parseStatusUpdateBody, applyTableStatusTransition } = await import('./floor.js')
const { db } = await import('../db.js')

function reqWith(query: Record<string, unknown>) {
  return { query } as unknown as Parameters<typeof storeIdParam>[0]
}

function reqWithBody(body: Record<string, unknown>) {
  return { body } as unknown as Parameters<typeof parseStatusUpdateBody>[0]
}

test('storeIdParam rejects malformed input', () => {
  assert.throws(() => storeIdParam(reqWith({ store_id: 'not-a-uuid' })), /valid store_id/)
  assert.throws(() => storeIdParam(reqWith({})), /valid store_id/)
})

test('a manager can mark a table served by hand; a cashier terminal cannot', () => {
  const body = { expected_status: 'ordering', status: 'served' }
  const managerResult = parseStatusUpdateBody(reqWithBody(body), true)
  assert.equal(managerResult.status, 'served')

  assert.throws(() => parseStatusUpdateBody(reqWithBody(body), false), /Cannot move a table from ordering to served/)
})

test('ordinary transitions still work identically for both manager and terminal callers', () => {
  const body = { expected_status: 'available', status: 'seated' }
  assert.equal(parseStatusUpdateBody(reqWithBody(body), true).status, 'seated')
  assert.equal(parseStatusUpdateBody(reqWithBody(body), false).status, 'seated')
})

test('the manager-only edge does not leak into unrelated statuses', () => {
  // Only ordering -> served is manager-only; a manager still can't skip straight from
  // 'available' to 'served', for example.
  assert.throws(() => parseStatusUpdateBody(reqWithBody({ expected_status: 'available', status: 'served' }), true), /Cannot move a table from available to served/)
})

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
  '202609230002_table_waiter_assignment.sql',
]

// applyTableStatusTransition is the one shared primitive both the HTTP status-update endpoint
// and kitchen.ts's item-served hook call — worth testing directly against real Postgres
// semantics (PGlite) rather than only through the thin, auth-wrapped HTTP handlers, which stay
// manual-QA-only for now (docs/MODULE_STATUS.md).
test('applyTableStatusTransition is an atomic compare-and-swap that also manages waiter assignment', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
    for (const name of chain) {
      const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
      await database.exec(sql)
    }
    const owner = randomUUID(), store = randomUUID(), area = randomUUID(), table = randomUUID(), waiter = randomUUID(), otherStore = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','floor-test',$2,'UTC')", [store, owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Two','floor-test-2',$2,'UTC')", [otherStore, owner])
    await database.query('insert into public.floor_areas(id,store_id,name) values ($1,$2,$3)', [area, store, 'Main Hall'])
    await database.query('insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats) values ($1,$2,$3,$4,4)', [table, store, area, 'T1'])
    await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values
      ($1,$2,'Waiter One','cashier',repeat('a',32),repeat('b',64))`, [waiter, store])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }

    // available -> seated assigns the waiter.
    const seated = await applyTableStatusTransition(store, table, 'available', 'seated', waiter)
    assert.ok(seated)
    assert.equal(seated?.status, 'seated')
    assert.equal(seated?.assigned_waiter_id, waiter)

    // Stale expectedStatus (already moved past 'available') is a no-op, not an error — the atomic
    // compare-and-swap this function exists for. This is exactly the case kitchen.ts's item-served
    // hook relies on: if staff already moved the table on, the hook silently does nothing.
    const stale = await applyTableStatusTransition(store, table, 'available', 'seated', waiter)
    assert.equal(stale, null)

    // seated -> ordering -> served (the kitchen hook's actual path), waiter assignment untouched.
    await applyTableStatusTransition(store, table, 'seated', 'ordering')
    const served = await applyTableStatusTransition(store, table, 'ordering', 'served')
    assert.ok(served)
    assert.equal(served?.status, 'served')
    assert.equal(served?.assigned_waiter_id, waiter, 'waiter stays assigned through the served transition')

    // A wrong-store table id must never match, even with the right expectedStatus (composite
    // tenant-scoped WHERE clause, not just an id lookup).
    const crossTenant = await applyTableStatusTransition(otherStore, table, 'served', 'bill_requested')
    assert.equal(crossTenant, null)

    // -> available clears the waiter.
    await applyTableStatusTransition(store, table, 'served', 'bill_requested')
    await applyTableStatusTransition(store, table, 'bill_requested', 'dirty')
    const cleaned = await applyTableStatusTransition(store, table, 'dirty', 'available')
    assert.equal(cleaned?.assigned_waiter_id, null)
  } finally {
    await database.close()
  }
})
