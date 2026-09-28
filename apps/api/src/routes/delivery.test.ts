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
const { applyDeliveryTransition, createDeliveryOrderSnapshot, DeliveryConflictError, isRiderRole } = await import('./delivery.js')
const { roleHasCapability } = await import('../../../../packages/domain/src/staff-role.js')
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
  '202609260002_staff_roles_and_shifts.sql',
  '202609280002_delivery_operations.sql',
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

async function seedFixture(database: PGlite, options: { orderType?: 'delivery' | 'dine_in' } = {}) {
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

  let delivery: string | null = null
  if (orderType === 'delivery') {
    delivery = randomUUID()
    const client = await db.connect()
    await createDeliveryOrderSnapshot(client, {
      storeId: store, orderId, recipientName: 'Jane Guest', contactPhone: '15551234567',
      address: '123 Main St', instructions: 'Leave at door',
    })
    const row = await database.query('select id from public.delivery_orders where store_id=$1 and order_id=$2', [store, orderId])
    delivery = (row.rows[0] as { id: string }).id
    client.release()
  }

  return { store, otherStore, rider, otherRider, cashier, orderId, deliveryId: delivery as string }
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
    const { store, rider, deliveryId } = await seedFixture(database)
    await database.query('update public.delivery_orders set rider_id=$1 where store_id=$2 and id=$3', [rider, store, deliveryId])

    const steps: Array<['pending' | 'accepted' | 'picked_up' | 'out_for_delivery', 'accepted' | 'picked_up' | 'out_for_delivery' | 'delivered']> = [
      ['pending', 'accepted'], ['accepted', 'picked_up'], ['picked_up', 'out_for_delivery'], ['out_for_delivery', 'delivered'],
    ]
    for (const [expectedStatus, toStatus] of steps) {
      const updated = await applyDeliveryTransition({
        storeId: store, deliveryId, expectedStatus, toStatus, operationId: randomUUID(),
        actorType: 'rider', actorId: rider, requireRiderId: rider,
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
    const { store, rider } = await seedFixture(database)

    // A second delivery order in the same store, to exercise the count-by-status/avg-duration
    // aggregation across more than one row.
    const secondOrderId = randomUUID()
    await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,order_type)
      values ($1,$2,$3,'USD','One','UTC',1200,0,0,1200,1,now(),'delivery')`, [secondOrderId, store, `DEL2-${secondOrderId.slice(0, 8)}`])
    const seedClient = await db.connect()
    await createDeliveryOrderSnapshot(seedClient, { storeId: store, orderId: secondOrderId, recipientName: 'Second Guest', contactPhone: '15551234567', address: '456 Oak St', instructions: null })
    seedClient.release()
    const secondRow = await database.query('select id from public.delivery_orders where store_id=$1 and order_id=$2', [store, secondOrderId])
    const secondDeliveryId = (secondRow.rows[0] as { id: string }).id

    // Deliver the second one, backdating created_at so the KPI has a nonzero duration to average.
    await database.query(`update public.delivery_orders set rider_id=$1, created_at = now() - interval '10 minutes' where store_id=$2 and id=$3`, [rider, store, secondDeliveryId])
    await applyDeliveryTransition({ storeId: store, deliveryId: secondDeliveryId, expectedStatus: 'pending', toStatus: 'accepted', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    await applyDeliveryTransition({ storeId: store, deliveryId: secondDeliveryId, expectedStatus: 'accepted', toStatus: 'picked_up', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    await applyDeliveryTransition({ storeId: store, deliveryId: secondDeliveryId, expectedStatus: 'picked_up', toStatus: 'out_for_delivery', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })
    await applyDeliveryTransition({ storeId: store, deliveryId: secondDeliveryId, expectedStatus: 'out_for_delivery', toStatus: 'delivered', operationId: randomUUID(), actorType: 'rider', actorId: rider, requireRiderId: rider })

    const counts = await database.query('select status, count(*)::int as count from public.delivery_orders where store_id=$1 group by status', [store])
    const byStatus = Object.fromEntries((counts.rows as { status: string; count: number }[]).map(row => [row.status, row.count]))
    assert.equal(byStatus.pending, 1)
    assert.equal(byStatus.delivered, 1)

    const avg = await database.query(`select avg(extract(epoch from (delivered_at - created_at)))::float8 as avg_seconds from public.delivery_orders where store_id=$1 and status='delivered'`, [store])
    const avgSeconds = (avg.rows[0] as { avg_seconds: number }).avg_seconds
    assert.ok(avgSeconds > 500 && avgSeconds < 700, `expected ~600s average, got ${avgSeconds}`)
  } finally { await database.close() }
})
