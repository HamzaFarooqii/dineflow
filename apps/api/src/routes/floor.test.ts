import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Same pattern as reports.test.ts: pure validation never opens a connection; the PGlite-backed
// test below monkey-patches db.query before use.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { storeIdParam, parseStatusUpdateBody, applyTableStatusTransition, moveTableParty } = await import('./floor.js')
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
  '202609230001_kitchen_display_system.sql',
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

test('moveTableParty transfers and merges, moving open kitchen tickets and enforcing preconditions', async () => {
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
    const owner = randomUUID(), store = randomUUID(), area = randomUUID(), product = randomUUID()
    const tableA = randomUUID(), tableB = randomUUID(), tableC = randomUUID(), waiter = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','floor-move-test',$2,'UTC')", [store, owner])
    await database.query('insert into public.floor_areas(id,store_id,name) values ($1,$2,$3)', [area, store, 'Main Hall'])
    await database.query('insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats) values ($1,$2,$3,$4,4)', [tableA, store, area, 'A1'])
    await database.query('insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats) values ($1,$2,$3,$4,4)', [tableB, store, area, 'A2'])
    await database.query('insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats) values ($1,$2,$3,$4,4)', [tableC, store, area, 'A3'])
    await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values
      ($1,$2,'Waiter One','cashier',repeat('a',32),repeat('b',64))`, [waiter, store])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-1','Test item',500)`, [product, store])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<import('pg').PoolClient> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    // moveTableParty uses db.connect() for a real transaction (begin/commit/rollback) — PGlite's
    // query() already runs everything in its own implicit transaction per call, so a fixture
    // "client" whose query() delegates straight to the same database is sufficient here; multiple
    // statements between explicit begin/commit still see each other's effects because PGlite is
    // a single embedded instance, not a real connection pool.
    fixture.connect = async () => ({ query: fixture.query, release: () => undefined }) as unknown as import('pg').PoolClient

    const seatTicket = async (tableId: string) => {
      const orderId = randomUUID()
      await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,order_type,table_id)
        values ($1,$2,$3,'USD','One','UTC',500,0,0,500,1,now(),'dine_in',$4)`, [orderId, store, `MOVE-${orderId.slice(0, 8)}`, tableId])
      const itemId = randomUUID()
      await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
        snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
        values ($1,$2,$3,$4,'Test item','SKU-1',500,0,1,1,500,0,500,0,500)`, [itemId, store, orderId, product])
      const ticketId = randomUUID()
      await database.query(`insert into public.kitchen_tickets(id,store_id,order_id,table_id,status) values ($1,$2,$3,$4,'preparing')`, [ticketId, store, orderId, tableId])
      await database.query(`insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,status) values ($1,$2,$3,$4,'preparing')`, [randomUUID(), store, ticketId, itemId])
      return ticketId
    }

    // --- Transfer: occupied A -> available B ---
    await applyTableStatusTransition(store, tableA, 'available', 'seated', waiter)
    await applyTableStatusTransition(store, tableA, 'seated', 'ordering')
    const ticketA = await seatTicket(tableA)

    const transferred = await moveTableParty(store, tableA, tableB, 'transfer')
    assert.deepEqual(transferred, { freedTableId: tableA, occupiedTableId: tableB })
    const afterTransfer = await database.query('select status, assigned_waiter_id from public.restaurant_tables where id=$1', [tableB])
    assert.equal(afterTransfer.rows[0].status, 'ordering')
    assert.equal(afterTransfer.rows[0].assigned_waiter_id, waiter)
    const sourceAfterTransfer = await database.query('select status, assigned_waiter_id from public.restaurant_tables where id=$1', [tableA])
    assert.equal(sourceAfterTransfer.rows[0].status, 'available')
    assert.equal(sourceAfterTransfer.rows[0].assigned_waiter_id, null)
    const movedTicket = await database.query('select table_id from public.kitchen_tickets where id=$1', [ticketA])
    assert.equal(movedTicket.rows[0].table_id, tableB)

    // Transfer into an occupied table must be rejected — B is now 'ordering', not 'available'.
    await applyTableStatusTransition(store, tableA, 'available', 'seated')
    await assert.rejects(moveTableParty(store, tableA, tableB, 'transfer'), /not available to transfer into/)

    // Transfer from a table with no active party (A is only 'seated', no ticket) must be rejected.
    await applyTableStatusTransition(store, tableA, 'seated', 'available')
    await assert.rejects(moveTableParty(store, tableA, tableC, 'transfer'), /has no active party to transfer/)

    // --- Merge: two occupied tables (B, now C) combine into B ---
    await applyTableStatusTransition(store, tableC, 'available', 'seated')
    await applyTableStatusTransition(store, tableC, 'seated', 'ordering')
    const ticketC = await seatTicket(tableC)

    const merged = await moveTableParty(store, tableC, tableB, 'merge')
    assert.deepEqual(merged, { freedTableId: tableC, occupiedTableId: tableB })
    const bAfterMerge = await database.query('select status from public.restaurant_tables where id=$1', [tableB])
    assert.equal(bAfterMerge.rows[0].status, 'ordering', "the merge target's own status is untouched")
    const cAfterMerge = await database.query('select status from public.restaurant_tables where id=$1', [tableC])
    assert.equal(cAfterMerge.rows[0].status, 'available')
    const mergedTicket = await database.query('select table_id from public.kitchen_tickets where id=$1', [ticketC])
    assert.equal(mergedTicket.rows[0].table_id, tableB)
    // Both tickets — the transferred one and the merged one — now sit on B.
    const ticketsOnB = await database.query('select count(*)::int as n from public.kitchen_tickets where table_id=$1', [tableB])
    assert.equal(ticketsOnB.rows[0].n, 2)

    // Merging into a table with no active party must be rejected — tableA is 'available' here
    // (freed earlier), so seat tableC again to have a genuinely occupied source for this check.
    await applyTableStatusTransition(store, tableC, 'available', 'seated')
    await assert.rejects(moveTableParty(store, tableC, tableA, 'merge'), /has no active party to merge into/)
  } finally {
    await database.close()
  }
})
