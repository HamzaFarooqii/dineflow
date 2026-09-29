import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Same pattern as kitchen.test.ts/floor.test.ts: the course-firing/hold/history/station-summary
// core functions are exported specifically so they can be tested directly against real Postgres
// semantics (PGlite) rather than only through the thin, auth-wrapped HTTP handlers, which stay
// manual-QA-only for now (docs/MODULE_STATUS.md) -- same reason kitchen.test.ts itself only ever
// tests the exported consumeRecipeIngredients, never getTickets/patchItem directly.
//
// orders.ts's push() has no extracted, directly-callable core (unlike open-checks.ts's
// createPaidOrder on the sibling feat/open-checks branch, not present here) -- it's a thin,
// auth-wrapped HTTP handler end to end, so the fixture below seeds a ticket/items directly via SQL
// using push()'s own documented course-firing rule (packages/domain/src/course.ts's
// firesImmediately, verified separately by course.test.ts) rather than invoking push() itself.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { fireCourseCore, holdCourseCore, getStationSummaryCore, getTicketHistoryCore } = await import('./kitchen.js')
const { firesImmediately } = await import('../../../../packages/domain/src/course.js')
const { db } = await import('../db.js')

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
  '202609240001_units_and_recipes.sql',
  '202609240002_ingredient_inventory.sql',
  '202609240003_inventory_audit_columns.sql',
  '202609240004_inventory_terminal_audit.sql',
  '202609250002_inventory_batch_tracking.sql',
  '202609260001_unit_conversion.sql',
  '202609260003_service_charge.sql',
  '202609270001_modifiers.sql',
  '202609290001_kitchen_operations_depth.sql',
]

test('kitchen operations depth: course-based firing, hold, SLA station summary and history against real Postgres semantics (PGlite)', async () => {
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
    const owner = randomUUID(), store = randomUUID(), station = randomUUID()
    const appetizerProduct = randomUUID(), mainProduct = randomUUID(), plainProduct = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','kitchen-ops-test',$2,'UTC')", [store, owner])
    await database.query('insert into public.kitchen_stations(id,store_id,name) values ($1,$2,$3)', [station, store, 'Grill'])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents,station_id,course,prep_time_seconds) values
      ($1,$2,'APP-1','Soup',500,$3,'appetizer',120)`, [appetizerProduct, store, station])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents,station_id,course,prep_time_seconds) values
      ($1,$2,'MAIN-1','Steak',2000,$3,'main',600)`, [mainProduct, store, station])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values
      ($1,$2,'PLAIN-1','Fries',300)`, [plainProduct, store])
    await database.query(`insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,50),($1,$3,50),($1,$4,50)`, [store, appetizerProduct, mainProduct, plainProduct])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<import('pg').PoolClient> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.connect = async () => ({ query: fixture.query, release: () => undefined }) as unknown as import('pg').PoolClient

// --- ticket creation snapshots course/prep-time and holds main while firing appetizer/plain immediately ---
    // Mirrors orders.ts's push() exactly: an order is inserted (pos_orders/pos_order_items/
    // pos_payments -- same columns push() itself writes), then one kitchen ticket with one item
    // per line, each snapshotting its product's course/prep_time_seconds and firing immediately
    // unless firesImmediately(course) says otherwise (main/dessert only).
    const orderId = randomUUID()
    const appetizerItemId = randomUUID(), mainItemId = randomUUID(), plainItemId = randomUUID()
    await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,order_type,table_id)
      values ($1,$2,$3,'USD','One','UTC',2800,0,0,2800,1,now(),'dine_in',null)`, [orderId, store, `KOT-${orderId.slice(0, 8)}`])
    const appetizerTicketItemId = randomUUID(), mainTicketItemId = randomUUID(), plainTicketItemId = randomUUID()
    const lineItems = [
      { id: appetizerItemId, ticketItemId: appetizerTicketItemId, productId: appetizerProduct, name: 'Soup', sku: 'APP-1', price: 500, course: 'appetizer' as const, prepTime: 120, stationId: station as string | null },
      { id: mainItemId, ticketItemId: mainTicketItemId, productId: mainProduct, name: 'Steak', sku: 'MAIN-1', price: 2000, course: 'main' as const, prepTime: 600, stationId: station as string | null },
      { id: plainItemId, ticketItemId: plainTicketItemId, productId: plainProduct, name: 'Fries', sku: 'PLAIN-1', price: 300, course: null, prepTime: null, stationId: null as string | null },
    ]
    for (const line of lineItems) {
      await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
        snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
        values ($1,$2,$3,$4,$5,$6,$7,0,1,1,$7,0,$7,0,$7)`, [line.id, store, orderId, line.productId, line.name, line.sku, line.price])
    }
    const ticketId = randomUUID()
    const ticketStatus = lineItems.some(line => firesImmediately(line.course)) ? 'preparing' : 'queued'
    await database.query(`insert into public.kitchen_tickets(id,store_id,order_id,table_id,status) values ($1,$2,$3,null,$4)`, [ticketId, store, orderId, ticketStatus])
    for (const line of lineItems) {
      const immediate = firesImmediately(line.course)
      await database.query(
        `insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,station_id,status,fired_at,course,prep_time_target_seconds)
         values ($1,$2,$3,$4,$5,$6,${immediate ? 'now()' : 'null'},$7,$8)`,
        [line.ticketItemId, store, ticketId, line.id, line.stationId, immediate ? 'preparing' : 'queued', line.course, line.prepTime ?? 600],
      )
    }

    const items = await database.query(
      'select id, course, status, fired_at, prep_time_target_seconds from public.kitchen_ticket_items where store_id=$1 order by course nulls last',
      [store],
    )
    const byId = new Map(items.rows.map((row: { id: string }) => [row.id, row]))
    assert.equal(byId.get(appetizerTicketItemId).status, 'preparing', 'appetizer fires immediately')
    assert.ok(byId.get(appetizerTicketItemId).fired_at, 'appetizer has a fired_at timestamp')
    assert.equal(byId.get(appetizerTicketItemId).prep_time_target_seconds, 120)
    assert.equal(byId.get(mainTicketItemId).status, 'queued', 'main is held for explicit firing')
    assert.equal(byId.get(mainTicketItemId).fired_at, null)
    assert.equal(byId.get(mainTicketItemId).prep_time_target_seconds, 600)
    assert.equal(byId.get(plainTicketItemId).status, 'preparing', 'a product with no course fires immediately, same as before course-firing existed')
    assert.equal(byId.get(plainTicketItemId).course, null)

    const ticket = await database.query('select status from public.kitchen_tickets where store_id=$1 and id=$2', [store, ticketId])
    assert.equal(ticket.rows[0].status, 'preparing', 'the ticket as a whole is preparing while at least one course is already firing')

    // --- hold main, then fire it: idempotent both ways ---
    const held = await holdCourseCore(store, ticketId, 'main')
    assert.equal(held.held_item_count, 1)
    const heldAgain = await holdCourseCore(store, ticketId, 'main')
    assert.equal(heldAgain.held_item_count, 0, 'holding an already-held course is a no-op')

    const fired = await fireCourseCore(store, ticketId, 'main', { employeeId: null, userId: owner })
    assert.equal(fired.fired_item_count, 1)
    assert.equal(fired.ticket_status, 'preparing')
    const firedAgain = await fireCourseCore(store, ticketId, 'main', { employeeId: null, userId: owner })
    assert.equal(firedAgain.fired_item_count, 0, 'firing an already-fired course is idempotent, not an error')
    const mainAfterFire = await database.query('select status, fired_at, held_at from public.kitchen_ticket_items where id=$1', [mainTicketItemId])
    assert.equal(mainAfterFire.rows[0].status, 'preparing')
    assert.ok(mainAfterFire.rows[0].fired_at)
    assert.equal(mainAfterFire.rows[0].held_at, null, 'firing clears any prior hold marker')
    const fireLog = await database.query('select fired_by_user_id, fired_item_count from public.kitchen_course_fire_log where store_id=$1 and ticket_id=$2 and course=$3', [store, ticketId, 'main'])
    assert.equal(fireLog.rowCount, 1, 'exactly one audit row -- the idempotent replay above did not log a second fire')
    assert.equal(fireLog.rows[0].fired_by_user_id, owner)

    // --- station summary: SLA boundary states among preparing items ---
    const nowPlus = (seconds: number) => new Date(Date.now() + seconds * 1000)
    // Appetizer fired ~immediately with a 120s target: well within target -> calm right now.
    const summaryNow = await getStationSummaryCore(store, new Date())
    const grill = summaryNow.find((row: { station_id: string | null }) => row.station_id === station)!
    assert.ok(grill, 'the grill station appears in the summary')
    assert.equal(grill.calm + grill.warning + grill.late, 2, 'appetizer and main are both preparing; plain has no station')
    // Evaluated far in the future, both preparing items must have crossed into 'late'.
    const summaryLate = await getStationSummaryCore(store, nowPlus(10_000))
    const grillLate = summaryLate.find((row: { station_id: string | null }) => row.station_id === station)!
    assert.equal(grillLate.late, 2)
    assert.equal(grillLate.calm, 0)
    assert.equal(grillLate.warning, 0)

    // --- serving every item moves the ticket to served and it disappears from the active board,
    // then appears in history ---
    for (const itemId of [appetizerTicketItemId, mainTicketItemId, plainTicketItemId]) {
      await database.query(`update public.kitchen_ticket_items set status='served', served_at=now() where id=$1`, [itemId])
    }
    await database.query(`update public.kitchen_tickets set status='served' where id=$1`, [ticketId])

    const activeHistory = await getTicketHistoryCore(store, { status: null, date: null, stationId: null, limit: 50, cursor: null })
    assert.equal(activeHistory.tickets.length, 1)
    assert.equal(activeHistory.tickets[0].id, ticketId)
    assert.equal(activeHistory.tickets[0].status, 'served')
    // Every item in the served ticket keeps its course snapshot even after history-read time.
    const historyItem = activeHistory.tickets[0].items.find((item: { id: string }) => item.id === mainTicketItemId)!
    assert.equal(historyItem.course, 'main')

    const filteredByStation = await getTicketHistoryCore(store, { status: 'served', date: null, stationId: station, limit: 50, cursor: null })
    assert.equal(filteredByStation.tickets.length, 1)
    const filteredByWrongStatus = await getTicketHistoryCore(store, { status: 'cancelled', date: null, stationId: null, limit: 50, cursor: null })
    assert.equal(filteredByWrongStatus.tickets.length, 0, 'a served ticket never pollutes a cancelled-only history filter')

    // --- tenant isolation: a course cannot be fired/held on a ticket from a different store ---
    const otherStore = randomUUID()
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Two','kitchen-ops-test-2',$2,'UTC')", [otherStore, owner])
    await assert.rejects(fireCourseCore(otherStore, ticketId, 'main', { employeeId: null, userId: owner }), /not_found|not found/i)
    const crossStoreHold = await holdCourseCore(otherStore, ticketId, 'main')
    assert.equal(crossStoreHold.held_item_count, 0, 'holdCourseCore is a plain UPDATE with no rows-found check, so a wrong-store id just matches nothing')
  } finally {
    await database.close()
  }
})
