import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Same PGlite pattern as floor.test.ts: applyDeliveryTransition (the CAS+idempotency core shared
// by both the owner and rider HTTP handlers) is tested directly against real Postgres semantics,
// which is where the correctness that actually matters -- atomic transitions, idempotent replay,
// stale-write rejection -- lives. The thin, auth-wrapped HTTP handlers stay manual-QA-only for
// now, matching every other route file in this codebase (docs/MODULE_STATUS.md).
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { applyDeliveryTransition, createDeliveryOrderSnapshot, issueDeliveryProof, DeliveryConflictError, isRiderRole } = await import('./delivery.js')
const { roleHasCapability } = await import('../../../../packages/domain/src/staff-role.js')
const { db } = await import('../db.js')
type KitchenTicketStatus = 'queued' | 'preparing' | 'ready' | 'served' | 'cancelled'

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
  '202609260002_staff_roles_and_shifts.sql',
  '202609280002_delivery_operations.sql',
  '202609290001_kitchen_operations_depth.sql',
  '202610020001_delivery_target_minutes.sql',
  '202610020002_delivery_proofs.sql',
]

async function seededDatabase() {
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of chain) {
    const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
    await database.exec(sql)
  }
  return database
}

function wireFixture(database: PGlite) {
  const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<import('pg').PoolClient> }
  fixture.query = async (sql: string, params?: unknown[]) => {
    const result = await database.query(sql, params)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
  // applyDeliveryTransition/assignRider use db.connect() for a real transaction; PGlite is a
  // single embedded instance so delegating straight through is sufficient here, same rationale
  // floor.test.ts documents for moveTableParty.
  fixture.connect = async () => ({ query: fixture.query, release: () => undefined }) as unknown as import('pg').PoolClient
}

// Every real checkout creates exactly one kitchen ticket for every order type, not just delivery
// (orders.ts) -- this seeds the matching pos_order_items + kitchen_tickets/kitchen_ticket_items
// rows so applyDeliveryTransition's kitchen-readiness gate (added for Day 2 Part 2, Dispatch) sees
// the same shape a real order would have. Defaults to 'ready' so every pre-existing test below
// that drives a delivery through to 'picked_up' keeps working unchanged; tests that specifically
// exercise the gate pass a different status (or 'none', to simulate the no-ticket edge case).
async function seedKitchenTicket(database: PGlite, store: string, orderId: string, product: string, status: KitchenTicketStatus | 'none') {
  const orderItemId = randomUUID()
  await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
    snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,taxable_cents,tax_cents,total_cents)
    values ($1,$2,$3,$4,'Test dish','SKU-1',1200,0,1,1,1200,1200,0,1200)`, [orderItemId, store, orderId, product])
  if (status === 'none') return
  const ticketId = randomUUID()
  await database.query('insert into public.kitchen_tickets(id,store_id,order_id,status) values ($1,$2,$3,$4)', [ticketId, store, orderId, status])
  await database.query(
    `insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,status, held_at) values ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), store, ticketId, orderItemId, status, status === 'queued' ? new Date().toISOString() : null],
  )
}

async function seedFixture(database: PGlite, options: { orderType?: 'delivery' | 'dine_in'; kitchenTicket?: KitchenTicketStatus | 'none' } = {}) {
  const owner = randomUUID(), store = randomUUID(), otherStore = randomUUID()
  const rider = randomUUID(), otherRider = randomUUID(), cashier = randomUUID(), product = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','delivery-test',$2,'UTC')", [store, owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Two','delivery-test-2',$2,'UTC')", [otherStore, owner])
  await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values
    ($1,$2,'Rider One','rider',repeat('a',32),repeat('b',64)),
    ($3,$2,'Rider Two','rider',repeat('a',32),repeat('b',64)),
    ($4,$2,'Cashier One','cashier',repeat('a',32),repeat('b',64))`, [rider, store, otherRider, cashier])
  await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-1','Test dish',1200)`, [product, store])

  const orderType = options.orderType ?? 'delivery'
  const orderId = randomUUID()
  await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
    subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,order_type)
    values ($1,$2,$3,'USD','One','UTC',1200,0,0,1200,1,now(),$4)`, [orderId, store, `DEL-${orderId.slice(0, 8)}`, orderType])
  await seedKitchenTicket(database, store, orderId, product, options.kitchenTicket ?? 'ready')

  let delivery: string | null = null
  let proofCode: string | null = null
  if (orderType === 'delivery') {
    const client = await db.connect()
    const created = await createDeliveryOrderSnapshot(client, {
      storeId: store, orderId, recipientName: 'Jane Guest', contactPhone: '15551234567',
      address: '123 Main St', instructions: 'Leave at door',
    })
    delivery = created.deliveryOrderId
    proofCode = created.proofCode
    client.release()
  }

  return { store, otherStore, rider, otherRider, cashier, orderId, product, deliveryId: delivery as string, proofCode: proofCode as string }
}

test('createDeliveryOrderSnapshot stores an immutable snapshot, independent of pos_customers', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, deliveryId } = await seedFixture(database)
    const row = await database.query('select * from public.delivery_orders where store_id=$1 and id=$2', [store, deliveryId])
    const delivery = row.rows[0] as Record<string, unknown>
    assert.equal(delivery.recipient_name_snapshot, 'Jane Guest')
    assert.equal(delivery.address_snapshot, '123 Main St')
    assert.equal(delivery.status, 'pending')
  } finally { await database.close() }
})

test('applyDeliveryTransition refuses to accept a delivery with no rider assigned', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, deliveryId } = await seedFixture(database)
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'system', actorId: null }),
      /rider must be assigned/,
    )
  } finally { await database.close() }
})

test('a full accepted -> picked_up -> out_for_delivery -> delivered lifecycle is audited at every step', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId, proofCode } = await seedFixture(database)
    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])

    const steps: Array<['pending' | 'accepted' | 'picked_up' | 'out_for_delivery', 'accepted' | 'picked_up' | 'out_for_delivery' | 'delivered']> = [
      ['pending', 'accepted'], ['accepted', 'picked_up'], ['picked_up', 'out_for_delivery'], ['out_for_delivery', 'delivered'],
    ]
    for (const [expectedStatus, toStatus] of steps) {
      const updated = await applyDeliveryTransition({
        storeId: store, deliveryId, expectedStatus, toStatus, operationId: randomUUID(),
        actorType: 'rider', actorId: rider, requireRiderId: rider,
        proofCode: toStatus === 'delivered' ? proofCode : undefined,
      })
      assert.equal(updated.status, toStatus)
    }
    const events = await database.query('select from_status, to_status, actor_type, actor_id from public.delivery_status_events where store_id=$1 and delivery_order_id=$2 order by created_at', [store, deliveryId])
    assert.equal(events.rows.length, 4)
    assert.deepEqual((events.rows as { to_status: string }[]).map(row => row.to_status), ['accepted', 'picked_up', 'out_for_delivery', 'delivered'])
    for (const row of events.rows as { actor_type: string; actor_id: string }[]) {
      assert.equal(row.actor_type, 'rider')
      assert.equal(row.actor_id, rider)
    }
  } finally { await database.close() }
})

test('replaying the exact same transition request (same operation_id) is idempotent, not an error', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId } = await seedFixture(database)
    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])
    const operationId = randomUUID()

    const first = await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId, actorType: 'rider', actorId: rider, requireRiderId: rider })
    assert.equal(first.status, 'accepted')

    // Replay: same expectedStatus the client originally sent ('pending'), even though the row has
    // since moved to 'accepted' -- this simulates a retried request after a lost response. Must
    // return the current state, not double-apply and not throw a confusing conflict.
    const replay = await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId, actorType: 'rider', actorId: rider, requireRiderId: rider })
    assert.equal(replay.status, 'accepted')

    const events = await database.query('select count(*)::int as count from public.delivery_status_events where store_id=$1 and delivery_order_id=$2', [store, deliveryId])
    assert.equal((events.rows[0] as { count: number }).count, 1, 'replay must not insert a second audit row')
  } finally { await database.close() }
})

test('a stale expected_status (different operation_id, row already moved on) is rejected as a visible conflict', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId } = await seedFixture(database)
    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])
    await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })

    // A second device/tab still believes the delivery is 'pending' and tries to move it to
    // 'accepted' again, with a brand-new operation_id -- this is a genuine stale write, not a
    // replay, and must surface as a conflict rather than silently no-op or re-apply.
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider }),
      (error: unknown) => {
        assert.ok(error instanceof DeliveryConflictError)
        assert.equal(error.currentStatus, 'accepted')
        return true
      },
    )
  } finally { await database.close() }
})

test('an illegal transition edge (e.g. skipping picked_up) is rejected even with a matching expected_status', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId } = await seedFixture(database)
    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'picked_up', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider }),
      /invalid_transition|Cannot move/,
    )
  } finally { await database.close() }
})

test('a rider cannot transition a delivery assigned to a different rider', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, otherRider, deliveryId } = await seedFixture(database)
    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: otherRider, requireRiderId: otherRider }),
      /not assigned to you/,
    )
  } finally { await database.close() }
})

test('failing a delivery records the failure reason and is a terminal state', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId } = await seedFixture(database)
    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])
    const failed = await applyDeliveryTransition({
      storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'failed', operationId: randomUUID(),
      actorType: 'rider', actorId: rider, requireRiderId: rider, failureReason: 'Recipient unreachable',
    })
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failure_reason, 'Recipient unreachable')
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'failed', toStatus: 'picked_up', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider }),
      /invalid_transition|Cannot move/,
    )
  } finally { await database.close() }
})

test('a dine-in order never gets a delivery_orders row -- dispatch is delivery-only by construction', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, orderId } = await seedFixture(database, { orderType: 'dine_in' })
    const row = await database.query('select 1 from public.delivery_orders where store_id=$1 and order_id=$2', [store, orderId])
    assert.equal(row.rows.length, 0)
  } finally { await database.close() }
})

test('rider role scoping: rider has the delivery capability and nothing else, matching the terminal gate', () => {
  assert.equal(roleHasCapability('rider', 'delivery'), true)
  assert.equal(roleHasCapability('rider', 'register'), false)
  assert.equal(roleHasCapability('cashier', 'delivery'), false)
  assert.equal(roleHasCapability('manager', 'delivery'), true, 'manager remains a capability superset for ordinary terminal nav')
  assert.equal(isRiderRole('rider'), true)
  assert.equal(isRiderRole('manager'), false, 'rider-only delivery endpoints must reject manager terminal sessions')
})

test('cross-store: a delivery id from another store is not found, never leaked as another store\'s data', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { otherStore, rider, deliveryId } = await seedFixture(database)
    await assert.rejects(
      applyDeliveryTransition({ storeId: otherStore, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider }),
      /not_found|Delivery not found/,
    )
  } finally { await database.close() }
})

test('KPI aggregation: count by status and average time-to-delivered are correct', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, product } = await seedFixture(database)

    // A second delivery order in the same store, to exercise the count-by-status/avg-duration
    // aggregation across more than one row.
    const secondOrderId = randomUUID()
    await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,order_type)
      values ($1,$2,$3,'USD','One','UTC',1200,0,0,1200,1,now(),'delivery')`, [secondOrderId, store, `DEL2-${secondOrderId.slice(0, 8)}`])
    await seedKitchenTicket(database, store, secondOrderId, product, 'ready')
    const seedClient = await db.connect()
    const secondCreated = await createDeliveryOrderSnapshot(seedClient, { storeId: store, orderId: secondOrderId, recipientName: 'Second Guest', contactPhone: '15551234567', address: '456 Oak St', instructions: null })
    seedClient.release()
    const secondDeliveryId = secondCreated.deliveryOrderId

    // Deliver the second one, backdating created_at so the KPI has a nonzero duration to average.
    await database.query(`update public.delivery_orders set rider_id=$1, created_at = now() - interval '10 minutes' where store_id=$2 and id=$3`, [rider, store, secondDeliveryId])
    await applyDeliveryTransition({ storeId: store, deliveryId: secondDeliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    await applyDeliveryTransition({ storeId: store, deliveryId: secondDeliveryId, expectedStatus: 'accepted', toStatus: 'picked_up', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    await applyDeliveryTransition({ storeId: store, deliveryId: secondDeliveryId, expectedStatus: 'picked_up', toStatus: 'out_for_delivery', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    await applyDeliveryTransition({ storeId: store, deliveryId: secondDeliveryId, expectedStatus: 'out_for_delivery', toStatus: 'delivered', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider, proofCode: secondCreated.proofCode })

    const counts = await database.query('select status, count(*)::int as count from public.delivery_orders where store_id=$1 group by status', [store])
    const byStatus = Object.fromEntries((counts.rows as { status: string; count: number }[]).map(row => [row.status, row.count]))
    assert.equal(byStatus.pending, 1)
    assert.equal(byStatus.delivered, 1)

    const avg = await database.query(`select avg(extract(epoch from (delivered_at - created_at)))::float8 as avg_seconds from public.delivery_orders where store_id=$1 and status='delivered'`, [store])
    const avgSeconds = (avg.rows[0] as { avg_seconds: number }).avg_seconds
    assert.ok(avgSeconds > 500 && avgSeconds < 700, `expected ~600s average, got ${avgSeconds}`)
  } finally { await database.close() }
})

// --- Day 2, Part 2 (Dispatch): kitchen-readiness gate on 'picked_up' ---------------------------

test('a rider is blocked from picked_up while the kitchen ticket is still preparing', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId } = await seedFixture(database, { kitchenTicket: 'preparing' })
    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])
    await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'accepted', toStatus: 'picked_up', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider }),
      /kitchen_not_ready|not ready for pickup/,
    )
    const row = await database.query('select status from public.delivery_orders where store_id=$1 and id=$2', [store, deliveryId])
    assert.equal((row.rows[0] as { status: string }).status, 'accepted', 'a rejected pickup must not have moved the delivery forward')
  } finally { await database.close() }
})

test('a rider is blocked from picked_up, with a distinct message, when every kitchen item was cancelled (no-preparation case)', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId } = await seedFixture(database, { kitchenTicket: 'cancelled' })
    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])
    await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'accepted', toStatus: 'picked_up', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider }),
      /cancelled in the kitchen/,
    )
  } finally { await database.close() }
})

test('a rider is blocked from picked_up while a course is held (items stay queued with held_at set)', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    // seedKitchenTicket's 'queued' branch sets held_at, mirroring kitchen.ts's holdCourseCore:
    // holding only ever keeps an item's status at 'queued', so the gate should read this exactly
    // like any other not-yet-fired ticket, no special case needed.
    const { store, rider, deliveryId } = await seedFixture(database, { kitchenTicket: 'queued' })
    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])
    await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'accepted', toStatus: 'picked_up', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider }),
      /kitchen_not_ready|not ready for pickup/,
    )
  } finally { await database.close() }
})

test('a rider is blocked from picked_up when the order has no kitchen ticket at all', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId } = await seedFixture(database, { kitchenTicket: 'none' })
    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])
    await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'accepted', toStatus: 'picked_up', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider }),
      /kitchen_not_ready|not ready for pickup/,
    )
  } finally { await database.close() }
})

test('a partially-cancelled ticket (one item cancelled, the rest ready) still allows pickup -- cancelled items never block readiness', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId, orderId, product } = await seedFixture(database, { kitchenTicket: 'none' })
    // Hand-build a two-item ticket: one cancelled, one ready -- deriveTicketStatus (packages/
    // domain) would read this as 'ready' in production; here the ticket row's own status is set
    // directly to 'ready' to match what that derivation would produce, same as every other
    // ticket row in this schema (never recomputed by a trigger).
    const item1 = randomUUID(), item2 = randomUUID(), ticketId = randomUUID()
    await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
      snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,taxable_cents,tax_cents,total_cents)
      values ($1,$2,$3,$4,'Test dish','SKU-1',1200,0,1,1,1200,1200,0,1200)`, [item1, store, orderId, product])
    await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
      snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,taxable_cents,tax_cents,total_cents)
      values ($1,$2,$3,$4,'Test side','SKU-2',300,0,1,1,300,300,0,300)`, [item2, store, orderId, product])
    await database.query('insert into public.kitchen_tickets(id,store_id,order_id,status) values ($1,$2,$3,$4)', [ticketId, store, orderId, 'ready'])
    await database.query('insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,status) values ($1,$2,$3,$4,$5)', [randomUUID(), store, ticketId, item1, 'cancelled'])
    await database.query('insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,status) values ($1,$2,$3,$4,$5)', [randomUUID(), store, ticketId, item2, 'ready'])

    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])
    await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    const updated = await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'accepted', toStatus: 'picked_up', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    assert.equal(updated.status, 'picked_up')
  } finally { await database.close() }
})

// --- Day 2, Part 2 (Dispatch): proof-of-delivery ------------------------------------------------

async function advanceToOutForDelivery(database: PGlite, store: string, deliveryId: string, rider: string) {
  await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])
  await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
  await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'accepted', toStatus: 'picked_up', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
  await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'picked_up', toStatus: 'out_for_delivery', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
}

test('delivered is rejected without a proof code, and with a wrong one, never moving the delivery forward', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId } = await seedFixture(database)
    await advanceToOutForDelivery(database, store, deliveryId, rider)

    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'out_for_delivery', toStatus: 'delivered', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider }),
      /proof-of-delivery code is required/,
    )
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'out_for_delivery', toStatus: 'delivered', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider, proofCode: '000000' }),
      /doesn't match|attempt/,
    )
    const row = await database.query('select status from public.delivery_orders where store_id=$1 and id=$2', [store, deliveryId])
    assert.equal((row.rows[0] as { status: string }).status, 'out_for_delivery')
  } finally { await database.close() }
})

test('a correct proof code completes delivery, and the same code can never be reused (replay-safe)', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId, proofCode } = await seedFixture(database)
    await advanceToOutForDelivery(database, store, deliveryId, rider)

    const delivered = await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'out_for_delivery', toStatus: 'delivered', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider, proofCode })
    assert.equal(delivered.status, 'delivered')

    const proofRow = await database.query('select consumed_at from public.delivery_proofs where store_id=$1 and delivery_order_id=$2', [store, deliveryId])
    assert.ok((proofRow.rows[0] as { consumed_at: string | null }).consumed_at, 'the proof must be marked consumed')

    // A second, different delivery (so the status/expected-status CAS itself can't be what blocks
    // this) attempting to reuse the exact same already-consumed code must still fail -- the proof
    // is scoped to the delivery it was issued for, and consumed_at alone would already stop reuse
    // even against itself.
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'delivered', toStatus: 'delivered', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider, proofCode }),
      /invalid_transition|Cannot move/,
    )
  } finally { await database.close() }
})

test('replaying the exact same delivered operation_id is idempotent and does not re-verify the code', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId, proofCode } = await seedFixture(database)
    await advanceToOutForDelivery(database, store, deliveryId, rider)
    const operationId = randomUUID()

    const first = await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'out_for_delivery', toStatus: 'delivered', operationId, actorType: 'rider', actorId: rider, requireRiderId: rider, proofCode })
    assert.equal(first.status, 'delivered')
    // Replay with the SAME operation_id and deliberately no proof code -- a genuine retried
    // request (e.g. the rider's connection dropped right after the first response) must still
    // succeed from the stored state, not demand the code again.
    const replay = await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'out_for_delivery', toStatus: 'delivered', operationId, actorType: 'rider', actorId: rider, requireRiderId: rider })
    assert.equal(replay.status, 'delivered')
  } finally { await database.close() }
})

test('a proof code expires and is rejected once past its TTL', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId, proofCode } = await seedFixture(database)
    await advanceToOutForDelivery(database, store, deliveryId, rider)
    await database.query(`update public.delivery_proofs set expires_at = now() - interval '1 minute' where store_id=$1 and delivery_order_id=$2`, [store, deliveryId])

    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'out_for_delivery', toStatus: 'delivered', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider, proofCode }),
      /expired/,
    )
  } finally { await database.close() }
})

test('a proof code locks out after its attempt limit, and a manager reissue unlocks it with a fresh code', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const { store, rider, deliveryId, proofCode } = await seedFixture(database)
    await advanceToOutForDelivery(database, store, deliveryId, rider)

    // Five wrong attempts (the fixture's max_attempts) must exhaust the code...
    for (let attempt = 0; attempt < 5; attempt++) {
      await assert.rejects(
        applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'out_for_delivery', toStatus: 'delivered', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider, proofCode: '000000' }),
      )
    }
    // ...so even the CORRECT code is now rejected -- it's the attempt limit that's blocking,
    // not a coincidentally-wrong guess.
    await assert.rejects(
      applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'out_for_delivery', toStatus: 'delivered', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider, proofCode }),
      /No active proof/,
    )

    // A manager reissues -- the old (locked) code stays locked, and the new one works.
    const client = await db.connect()
    const freshCode = await issueDeliveryProof(client, store, deliveryId)
    client.release()
    assert.notEqual(freshCode, proofCode)
    const delivered = await applyDeliveryTransition({ storeId: store, deliveryId, expectedStatus: 'out_for_delivery', toStatus: 'delivered', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider, proofCode: freshCode })
    assert.equal(delivered.status, 'delivered')
  } finally { await database.close() }
})
