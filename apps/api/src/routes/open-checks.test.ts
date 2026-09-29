import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Same pattern as floor.test.ts/kitchen.test.ts: the core create/edit/void/close functions are
// exported specifically so they can be tested directly against real Postgres semantics (PGlite)
// rather than only through the thin, auth-wrapped HTTP handlers, which stay manual-QA-only for
// now (docs/MODULE_STATUS.md).
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { parseCheckItems, serviceChargeBpsValue, versionValue, createOpenCheckCore, editOpenCheckCore, voidOpenCheckCore, closeOpenCheckCore, loadCheckDetail } = await import('./open-checks.js')
const { applyTableStatusTransition } = await import('./floor.js')
const { db } = await import('../db.js')
const { refundOrderCore } = await import('./orders.js')

test('parseCheckItems rejects an empty or oversized item list', () => {
  assert.throws(() => parseCheckItems([]), /1 to 100 items/)
  assert.throws(() => parseCheckItems(new Array(101).fill({})), /1 to 100 items/)
})
test('parseCheckItems computes line totals from calculateDiscountedLine, not from client-claimed values', () => {
  const [item] = parseCheckItems([{ product_id: randomUUID(), snapshot_name: 'Burger', snapshot_sku: 'B1',
    snapshot_price_cents: 1000, snapshot_tax_bps: 1000, catalog_version: 1, quantity: 2 }])
  // 2 x $10.00, 10% tax: subtotal 2000, tax 200, total 2200 -- computed server-side regardless of
  // whatever the client did or didn't also send for these fields.
  assert.equal(item.line.subtotalCents, 2000)
  assert.equal(item.line.taxCents, 200)
  assert.equal(item.line.totalCents, 2200)
})
test('parseCheckItems rejects duplicate item IDs within one check', () => {
  const sharedId = randomUUID()
  assert.throws(() => parseCheckItems([
    { id: sharedId, product_id: randomUUID(), snapshot_name: 'A', snapshot_sku: 'A1', snapshot_price_cents: 100, snapshot_tax_bps: 0, catalog_version: 1, quantity: 1 },
    { id: sharedId, product_id: randomUUID(), snapshot_name: 'B', snapshot_sku: 'B1', snapshot_price_cents: 100, snapshot_tax_bps: 0, catalog_version: 1, quantity: 1 },
  ]), /Item IDs must be unique/)
})
test('serviceChargeBpsValue and versionValue reject out-of-range input', () => {
  assert.throws(() => serviceChargeBpsValue(-1), /service_charge_bps/)
  assert.throws(() => serviceChargeBpsValue(10_001), /service_charge_bps/)
  assert.equal(serviceChargeBpsValue(500), 500)
  assert.throws(() => versionValue(0), /positive integer/)
  assert.throws(() => versionValue('1'), /positive integer/)
  assert.equal(versionValue(3), 3)
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
  '202609240001_units_and_recipes.sql',
  '202609240002_ingredient_inventory.sql',
  '202609240003_inventory_audit_columns.sql',
  '202609240004_inventory_terminal_audit.sql',
  '202609250002_inventory_batch_tracking.sql',
  '202609260001_unit_conversion.sql',
  '202609260003_service_charge.sql',
  '202609270001_modifiers.sql',
  '202609280002_open_checks.sql',
  '202609280003_split_settlement.sql',
  '202609280004_refund_settlement_integrity.sql',
]

test('open checks: full lifecycle against real Postgres semantics (PGlite)', async () => {
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
    const owner = randomUUID(), store = randomUUID(), otherStore = randomUUID(), area = randomUUID()
    const table = randomUUID(), product = randomUUID(), manager = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','open-checks-test',$2,'UTC')", [store, owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Two','open-checks-test-2',$2,'UTC')", [otherStore, owner])
    await database.query('insert into public.floor_areas(id,store_id,name) values ($1,$2,$3)', [area, store, 'Main Hall'])
    await database.query('insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats) values ($1,$2,$3,$4,4)', [table, store, area, 'T1'])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-1','Burger',1000)`, [product, store])
    await database.query(`insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,10)`, [store, product])
    await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values
      ($1,$2,'Manager One','manager',repeat('a',32),repeat('b',64))`, [manager, store])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<import('pg').PoolClient> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.connect = async () => ({ query: fixture.query, release: () => undefined }) as unknown as import('pg').PoolClient

    // --- create: a check can only be opened against an already-seated table ---
    await assert.rejects(createOpenCheckCore(store, { orderType: 'dine_in', tableId: table, customerId: null, employeeId: null }), /must be seated/)
    await applyTableStatusTransition(store, table, 'available', 'seated')

    const created = await createOpenCheckCore(store, { orderType: 'dine_in', tableId: table, customerId: null, employeeId: null })
    assert.equal(created.check.status, 'open')
    assert.equal(created.check.version, 1)
    assert.equal(created.check.total_cents, 0)
    const tableAfterCreate = await database.query('select status from public.restaurant_tables where id=$1', [table])
    assert.equal(tableAfterCreate.rows[0].status, 'ordering', 'opening a dine-in check moves the table to ordering')

    // A second check cannot be opened against the same table while one is already open -- the
    // table is already 'ordering' (accepted as-is, see createOpenCheckCore's comment), so this
    // is rejected by the partial unique index, not the status check.
    await assert.rejects(createOpenCheckCore(store, { orderType: 'dine_in', tableId: table, customerId: null, employeeId: null }), /already has an open check/)

    const checkId = created.check.id as string

    // --- edit: add a line, verify totals, then reject a stale version ---
    const itemInput = [{ product_id: product, snapshot_name: 'Burger', snapshot_sku: 'SKU-1', snapshot_price_cents: 1000, snapshot_tax_bps: 1000, catalog_version: 1, quantity: 2 }]
    const edited = await editOpenCheckCore(store, checkId, {
      expectedVersion: 1, items: parseCheckItems(itemInput), serviceChargeBps: 0, notes: null, customerId: null, managerId: null, managerApprovedAt: null,
    })
    assert.equal(edited.check.version, 2)
    assert.equal(edited.check.subtotal_cents, 2000)
    assert.equal(edited.check.tax_cents, 200)
    assert.equal(edited.check.total_cents, 2200)
    assert.equal(edited.items.length, 1)

    await assert.rejects(
      editOpenCheckCore(store, checkId, { expectedVersion: 1, items: parseCheckItems(itemInput), serviceChargeBps: 0, notes: null, customerId: null, managerId: null, managerApprovedAt: null }),
      /changed since it was last loaded/,
    )

    // A discount above cashier authority (>20%) requires manager approval before it can be saved.
    const bigDiscountItems = [{ product_id: product, snapshot_name: 'Burger', snapshot_sku: 'SKU-1', snapshot_price_cents: 1000, snapshot_tax_bps: 1000,
      catalog_version: 1, quantity: 2, discount_kind: 'percent', discount_value: 5000 }]
    await assert.rejects(
      editOpenCheckCore(store, checkId, { expectedVersion: 2, items: parseCheckItems(bigDiscountItems), serviceChargeBps: 0, notes: null, customerId: null, managerId: null, managerApprovedAt: null }),
      /requires manager approval/,
    )
    const approved = await editOpenCheckCore(store, checkId, {
      expectedVersion: 2, items: parseCheckItems(bigDiscountItems), serviceChargeBps: 0, notes: null, customerId: null,
      managerId: manager, managerApprovedAt: new Date().toISOString(),
    })
    assert.equal(approved.check.version, 3)
    assert.equal(approved.check.discount_cents, 1000, '50% off a 2000 subtotal')

    // Revert to a plain, approval-free line for the close below.
    const plain = await editOpenCheckCore(store, checkId, {
      expectedVersion: 3, items: parseCheckItems(itemInput), serviceChargeBps: 0, notes: null, customerId: null, managerId: null, managerApprovedAt: null,
    })
    assert.equal(plain.check.version, 4)
    assert.equal(plain.check.total_cents, 2200)

    // --- close: turns the check into a real paid order via the exact same path push() uses ---
    const operationId = randomUUID()
    const closeParams = {
      operationId, expectedVersion: 4, receiptNumber: `OC-${checkId.slice(0, 8)}`, catalogVersion: 1,
      clientGeneratedAt: new Date().toISOString(), serviceChargeBps: 0,
      payments: [{ id: randomUUID(), method: 'cash' as const, amountCents: 2200, tenderedCents: 2500, changeCents: 300, tipCents: 0, reference: null }],
      employeeIdOverride: null, loyaltyRedemptionRewardRuleId: null,
    }
    const hash = 'test-hash-1'
    const closed = await closeOpenCheckCore(store, checkId, closeParams, hash) as { status: string; operation_id: string }
    assert.equal(closed.status, 'accepted')
    assert.equal(closed.operation_id, operationId)

    const order = await database.query('select id, total_cents, table_id from public.pos_orders where store_id=$1 and id=$2', [store, operationId])
    assert.equal(order.rows[0].total_cents, 2200)
    const ticket = await database.query("select status from public.kitchen_tickets where store_id=$1 and order_id=$2", [store, operationId])
    assert.equal(ticket.rows[0].status, 'preparing', 'closing fires the kitchen ticket, same as a normal register sale')
    const stock = await database.query('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, product])
    assert.equal(stock.rows[0].current_stock, 8, '10 - 2 sold')
    const checkRow = await database.query('select status, closed_order_id from public.open_checks where store_id=$1 and id=$2', [store, checkId])
    assert.equal(checkRow.rows[0].status, 'closed')
    assert.equal(checkRow.rows[0].closed_order_id, operationId)

    // Replay with the identical operation_id + payload hash: idempotent, no second order.
    const replayed = await closeOpenCheckCore(store, checkId, closeParams, hash)
    assert.deepEqual(replayed, closed)

    // A second close attempt with a *different* client-generated operation_id (simulating a
    // concurrent tap from another device after the first already committed) must not create a
    // second order -- it sees the check already closed and returns the sale that actually happened.
    const secondAttempt = await closeOpenCheckCore(store, checkId, { ...closeParams, operationId: randomUUID() }, 'different-hash') as { status: string; operation_id: string }
    assert.equal(secondAttempt.status, 'already_closed')
    assert.equal(secondAttempt.operation_id, operationId)
    const orderCount = await database.query('select count(*)::int as n from public.pos_orders where store_id=$1', [store])
    assert.equal(orderCount.rows[0].n, 1, 'exactly one paid order exists no matter how many close attempts were made')
    const paymentCount = await database.query('select count(*)::int as n from public.pos_payments where store_id=$1', [store])
    assert.equal(paymentCount.rows[0].n, 1)

    // The table is released once the sale settles.
    const tableAfterClose = await database.query('select status from public.restaurant_tables where id=$1', [table])
    assert.equal(tableAfterClose.rows[0].status, 'dirty')

    // A closed check can no longer be edited or re-closed with a fresh operation as if still open.
    await assert.rejects(
      editOpenCheckCore(store, checkId, { expectedVersion: 4, items: parseCheckItems(itemInput), serviceChargeBps: 0, notes: null, customerId: null, managerId: null, managerApprovedAt: null }),
      /can no longer be edited/,
    )

    // --- void: an open check can be abandoned without ever becoming a sale ---
    await applyTableStatusTransition(store, table, 'dirty', 'available')
    await applyTableStatusTransition(store, table, 'available', 'seated')
    const secondCheck = await createOpenCheckCore(store, { orderType: 'dine_in', tableId: table, customerId: null, employeeId: null })
    const voided = await voidOpenCheckCore(store, secondCheck.check.id as string, 1, null)
    assert.equal(voided.status, 'voided')
    const tableAfterVoid = await database.query('select status from public.restaurant_tables where id=$1', [table])
    assert.equal(tableAfterVoid.rows[0].status, 'available', 'voiding releases the table')
    const secondVoid = await voidOpenCheckCore(store, secondCheck.check.id as string, 2, null)
    assert.equal(secondVoid.status, 'already_voided', 'voiding an already-voided check is idempotent')
    await assert.rejects(closeOpenCheckCore(store, secondCheck.check.id as string, { ...closeParams, operationId: randomUUID() }, 'yet-another-hash'), /voided and cannot be closed/)

    // --- create against a table the Floor screen already moved to 'ordering' itself ---
    // (web's handleAddOrder runs its own seated->ordering transition before Register is ever
    // reached; createOpenCheckCore must accept an already-'ordering' table as-is, not re-require
    // 'seated', or every real hold-from-Floor flow would fail this check.)
    await applyTableStatusTransition(store, table, 'available', 'seated')
    await applyTableStatusTransition(store, table, 'seated', 'ordering')
    const thirdCheck = await createOpenCheckCore(store, { orderType: 'dine_in', tableId: table, customerId: null, employeeId: null })
    assert.equal(thirdCheck.check.status, 'open')
    const tableStillOrdering = await database.query('select status from public.restaurant_tables where id=$1', [table])
    assert.equal(tableStillOrdering.rows[0].status, 'ordering')
    await voidOpenCheckCore(store, thirdCheck.check.id as string, 1, null)

    // --- split settlement: closing a check with multiple tenders (cash + card) and tips ---
    const splitTable = randomUUID()
    await database.query('insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats) values ($1,$2,$3,$4,4)', [splitTable, store, area, 'T2'])
    await applyTableStatusTransition(store, splitTable, 'available', 'seated')
    const splitCheck = await createOpenCheckCore(store, { orderType: 'dine_in', tableId: splitTable, customerId: null, employeeId: null })
    const splitEdit = await editOpenCheckCore(store, splitCheck.check.id as string, {
      expectedVersion: 1, items: parseCheckItems(itemInput), serviceChargeBps: 0, notes: null, customerId: null, managerId: null, managerApprovedAt: null,
    })
    assert.equal(splitEdit.check.total_cents, 2200) // same $22.00 two-burger line as the main flow above
    const splitOperationId = randomUUID()
    const cashTenderId = randomUUID(), cardTenderId = randomUUID()
    const splitResult = await closeOpenCheckCore(store, splitCheck.check.id as string, {
      operationId: splitOperationId, expectedVersion: splitEdit.check.version, receiptNumber: `SPLIT-${splitOperationId.slice(0, 8)}`,
      catalogVersion: 1, clientGeneratedAt: new Date().toISOString(), serviceChargeBps: 0,
      payments: [
        { id: cashTenderId, method: 'cash', amountCents: 1200, tenderedCents: 1700, changeCents: 300, tipCents: 200, reference: null },
        { id: cardTenderId, method: 'card', amountCents: 1000, tenderedCents: 1150, changeCents: 0, tipCents: 150, reference: 'AUTH-1' },
      ],
      employeeIdOverride: null, loyaltyRedemptionRewardRuleId: null,
    }, 'split-hash-1') as { status: string; operation_id: string }
    assert.equal(splitResult.status, 'accepted')
    const splitPayments = await database.query(
      'select method, amount_cents, tip_cents, change_cents, reference from public.pos_payments where store_id=$1 and order_id=$2 order by method',
      [store, splitOperationId],
    )
    assert.equal(splitPayments.rowCount, 2, 'both tenders were recorded as separate rows')
    const cardRow = splitPayments.rows.find((row: { method: string }) => row.method === 'card')
    const cashRow = splitPayments.rows.find((row: { method: string }) => row.method === 'cash')
    assert.equal(Number(cardRow.amount_cents), 1000)
    assert.equal(Number(cardRow.tip_cents), 150)
    assert.equal(cardRow.reference, 'AUTH-1')
    assert.equal(Number(cashRow.amount_cents), 1200)
    assert.equal(Number(cashRow.tip_cents), 200)
    assert.equal(Number(cashRow.change_cents), 300)
    // amount_cents alone (excluding tips) must sum to exactly the check's total -- tips are
    // additional money collected on top, never counted toward the bill itself.
    const amountSum = splitPayments.rows.reduce((sum: number, row: { amount_cents: string }) => sum + Number(row.amount_cents), 0)
    assert.equal(amountSum, 2200)

    const splitItemId = (await database.query<{ id: string }>('select id from public.pos_order_items where order_id=$1', [splitOperationId])).rows[0].id
    const refundOperationId = randomUUID()
    const partialRequest = { operation_id: refundOperationId, items: [{ order_item_id: splitItemId, quantity: 1 }], tenders: [{ payment_id: cashTenderId, amount_cents: 1100 }] }
    const partial = await refundOrderCore(store, splitOperationId, owner, partialRequest)
    assert.equal(Number(partial.refund.amount_cents), 1100)
    const replayRefund = await refundOrderCore(store, splitOperationId, owner, partialRequest)
    assert.equal(replayRefund.refund.id, partial.refund.id, 'lost-response retry does not refund twice')
    await assert.rejects(refundOrderCore(store, splitOperationId, owner, { ...partialRequest, reason: 'changed' }), /another request/)
    await assert.rejects(refundOrderCore(store, splitOperationId, owner, { items: partialRequest.items, tenders: [{ payment_id: cashTenderId, amount_cents: 1100 }] }), /100 cents remain/)
    const remainderRefund = await refundOrderCore(store, splitOperationId, owner, { operation_id: randomUUID() })
    assert.equal(Number(remainderRefund.refund.amount_cents), 1100)
    const allocated = await database.query<{ amount: string }>('select sum(amount_cents)::text as amount from public.pos_refund_tenders where payment_id=$1', [cashTenderId])
    assert.equal(Number(allocated.rows[0].amount), 1200)
    const refundedTips = await database.query<{ tips: string }>('select sum(tip_cents)::text as tips from public.pos_refund_tenders where payment_id=any($1::uuid[])', [[cashTenderId, cardTenderId]])
    assert.equal(Number(refundedTips.rows[0].tips), 350, 'full refunds return every original tip cent')
    await assert.rejects(refundOrderCore(store, splitOperationId, owner, {}), /fully refunded/)
    await assert.rejects(refundOrderCore(otherStore, splitOperationId, owner, {}), /not found/)

    const serviceCheck = await createOpenCheckCore(store, { orderType: 'takeaway', tableId: null, customerId: null, employeeId: null })
    const serviceEdit = await editOpenCheckCore(store, serviceCheck.check.id as string, {
      expectedVersion: 1, items: parseCheckItems(itemInput), serviceChargeBps: 1000, notes: null, customerId: null, managerId: null, managerApprovedAt: null,
    })
    const serviceOrder = randomUUID()
    await closeOpenCheckCore(store, serviceCheck.check.id as string, {
      operationId: serviceOrder, expectedVersion: serviceEdit.check.version, receiptNumber: 'SERVICE-REFUND', catalogVersion: 1,
      clientGeneratedAt: new Date().toISOString(), serviceChargeBps: 1000,
      payments: [{ id: randomUUID(), method: 'cash', amountCents: 2400, tenderedCents: 2400, changeCents: 0, tipCents: 0, reference: null }],
      employeeIdOverride: null, loyaltyRedemptionRewardRuleId: null,
    }, 'service-refund-hash')
    const serviceItem = (await database.query<{ id: string }>('select id from public.pos_order_items where order_id=$1', [serviceOrder])).rows[0].id
    const halfRefund = await refundOrderCore(store, serviceOrder, owner, { items: [{ order_item_id: serviceItem, quantity: 1 }] })
    assert.equal(Number(halfRefund.refund.amount_cents), 1200, 'partial refund includes the proportional service charge')
    const components = (await database.query<{ tax_cents: string; merchandise_cents: string; service_charge_cents: string }>('select tax_cents,merchandise_cents,service_charge_cents from public.pos_refunds where id=$1', [halfRefund.refund.id])).rows[0]
    assert.equal(Number(components.tax_cents), 100)
    assert.equal(Number(components.merchandise_cents), 1000)
    assert.equal(Number(components.service_charge_cents), 100)
    assert.equal(Number((await refundOrderCore(store, serviceOrder, owner, {})).refund.amount_cents), 1200)

    // A split close that doesn't balance (amounts don't sum to the check total) is rejected.
    await applyTableStatusTransition(store, splitTable, 'dirty', 'available')
    await applyTableStatusTransition(store, splitTable, 'available', 'seated')
    const unbalancedCheck = await createOpenCheckCore(store, { orderType: 'dine_in', tableId: splitTable, customerId: null, employeeId: null })
    const unbalancedEdit = await editOpenCheckCore(store, unbalancedCheck.check.id as string, {
      expectedVersion: 1, items: parseCheckItems(itemInput), serviceChargeBps: 0, notes: null, customerId: null, managerId: null, managerApprovedAt: null,
    })
    await assert.rejects(closeOpenCheckCore(store, unbalancedCheck.check.id as string, {
      operationId: randomUUID(), expectedVersion: unbalancedEdit.check.version, receiptNumber: 'UNBALANCED-1',
      catalogVersion: 1, clientGeneratedAt: new Date().toISOString(), serviceChargeBps: 0,
      payments: [{ id: randomUUID(), method: 'cash', amountCents: 1000, tenderedCents: 1000, changeCents: 0, tipCents: 0, reference: null }],
      employeeIdOverride: null, loyaltyRedemptionRewardRuleId: null,
    }, 'unbalanced-hash'), /do not balance/)

    // --- tenant isolation: a check cannot be read, edited or closed from a different store ---
    assert.equal(await loadCheckDetail(otherStore, checkId), null)
    await assert.rejects(editOpenCheckCore(otherStore, checkId, { expectedVersion: 4, items: parseCheckItems(itemInput), serviceChargeBps: 0, notes: null, customerId: null, managerId: null, managerApprovedAt: null }), /not found/)
    await assert.rejects(voidOpenCheckCore(otherStore, checkId, 4, null), /not found/)
  } finally {
    await database.close()
  }
})
