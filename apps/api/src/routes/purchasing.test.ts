import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Same reasoning as inventory.test.ts: the thin, auth-wrapped HTTP handlers stay manual-QA-only.
// receivePurchaseOrderCore is exported specifically so its real Postgres transaction semantics
// (idempotency, over-receipt gating, cost reconciliation) can be exercised directly against PGlite.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { receivePurchaseOrderCore } = await import('./purchasing.js')

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
  '202609280001_inventory_terminal_tenant_fks.sql',
  '202609280003_purchasing_vendors.sql',
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

function clientFor(database: PGlite): import('pg').PoolClient {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    },
  } as unknown as import('pg').PoolClient
}

async function seedStoreWithVendorAndIngredient(database: PGlite) {
  const owner = randomUUID(), store = randomUUID(), kg = randomUUID(), ingredient = randomUUID(), vendor = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','purchasing-test',$2,'UTC')", [store, owner])
  await database.query(`insert into public.units(id,store_id,name,abbreviation,kind) values ($1,$2,'Kilogram','kg','mass')`, [kg, store])
  await database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Flour',$3,50,20)`, [ingredient, store, kg])
  await database.query(`insert into public.vendors(id,store_id,name) values ($1,$2,'Acme Supplies')`, [vendor, store])
  return { store, ingredient, vendor }
}

async function seedPo(database: PGlite, store: string, vendor: string, ingredient: string, orderedQuantity: number, unitCostCents: number) {
  const po = randomUUID(), line = randomUUID()
  await database.query(`insert into public.purchase_orders(id,store_id,vendor_id,status) values ($1,$2,$3,'sent')`, [po, store, vendor])
  await database.query(
    `insert into public.purchase_order_lines(id,store_id,purchase_order_id,ingredient_id,ordered_quantity,unit_cost_cents) values ($1,$2,$3,$4,$5,$6)`,
    [line, store, po, ingredient, orderedQuantity, unitCostCents],
  )
  return { po, line }
}

test('vendors: unique name per store, tenant isolation', async () => {
  const database = await seededDatabase()
  try {
    const owner = randomUUID(), storeA = randomUUID(), storeB = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Store A','store-a',$2,'UTC')", [storeA, owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Store B','store-b',$2,'UTC')", [storeB, owner])
    await database.query(`insert into public.vendors(id,store_id,name) values ($1,$2,'Acme')`, [randomUUID(), storeA])
    // Same name, different store: allowed.
    await database.query(`insert into public.vendors(id,store_id,name) values ($1,$2,'Acme')`, [randomUUID(), storeB])
    // Same name, same store: rejected.
    await assert.rejects(database.query(`insert into public.vendors(id,store_id,name) values ($1,$2,'Acme')`, [randomUUID(), storeA]))

    const rows = await database.query('select store_id from public.vendors where store_id=$1', [storeA])
    assert.equal(rows.rows.length, 1)
  } finally {
    await database.close()
  }
})

test('purchase order create with lines, send, cancel transitions', async () => {
  const database = await seededDatabase()
  try {
    const { store, vendor, ingredient } = await seedStoreWithVendorAndIngredient(database)
    const po = randomUUID()
    await database.query(`insert into public.purchase_orders(id,store_id,vendor_id) values ($1,$2,$3)`, [po, store, vendor])
    await database.query(
      `insert into public.purchase_order_lines(store_id,purchase_order_id,ingredient_id,ordered_quantity,unit_cost_cents) values ($1,$2,$3,10,100)`,
      [store, po, ingredient],
    )
    let row = await database.query('select status from public.purchase_orders where id=$1', [po])
    assert.equal(row.rows[0].status, 'draft')

    await database.query(`update public.purchase_orders set status='sent', sent_at=now() where id=$1 and status='draft'`, [po])
    row = await database.query('select status from public.purchase_orders where id=$1', [po])
    assert.equal(row.rows[0].status, 'sent')

    await database.query(`update public.purchase_orders set status='cancelled', cancelled_at=now() where id=$1`, [po])
    row = await database.query('select status from public.purchase_orders where id=$1', [po])
    assert.equal(row.rows[0].status, 'cancelled')
  } finally {
    await database.close()
  }
})

test('receive: partial receive updates status to partially_received and posts batch/movement/stock', async () => {
  const database = await seededDatabase()
  try {
    const { store, vendor, ingredient } = await seedStoreWithVendorAndIngredient(database)
    const { po, line } = await seedPo(database, store, vendor, ingredient, 10, 100)
    const client = clientFor(database)
    await client.query('begin')
    await receivePurchaseOrderCore(client, store, po, {
      lines: [{ purchase_order_line_id: line, received_quantity: 4 }],
    })
    await client.query('commit')

    const poRow = await database.query('select status from public.purchase_orders where id=$1', [po])
    assert.equal(poRow.rows[0].status, 'partially_received')

    const batches = await database.query('select quantity, remaining_quantity from public.ingredient_batches where store_id=$1 and ingredient_id=$2', [store, ingredient])
    assert.equal(batches.rows.length, 1)
    assert.equal(Number(batches.rows[0].quantity), 4)

    const movements = await database.query('select delta, reason from public.stock_movements where store_id=$1 and ingredient_id=$2', [store, ingredient])
    assert.equal(movements.rows.length, 1)
    assert.equal(movements.rows[0].reason, 'purchase')
    assert.equal(Number(movements.rows[0].delta), 4)

    const ingredientRow = await database.query('select current_stock from public.ingredients where id=$1', [ingredient])
    assert.equal(Number(ingredientRow.rows[0].current_stock), 24) // seeded at 20 + 4
  } finally {
    await database.close()
  }
})

test('receive: same operation_id replays without duplicating batch/movement rows', async () => {
  const database = await seededDatabase()
  try {
    const { store, vendor, ingredient } = await seedStoreWithVendorAndIngredient(database)
    const { po, line } = await seedPo(database, store, vendor, ingredient, 10, 100)
    const client = clientFor(database)
    const operationId = randomUUID()

    await client.query('begin')
    const first = await receivePurchaseOrderCore(client, store, po, {
      operation_id: operationId,
      lines: [{ purchase_order_line_id: line, received_quantity: 4 }],
    })
    await client.query('commit')
    assert.equal(first.replayed, false)

    await client.query('begin')
    const second = await receivePurchaseOrderCore(client, store, po, {
      operation_id: operationId,
      lines: [{ purchase_order_line_id: line, received_quantity: 4 }],
    })
    await client.query('commit')
    assert.equal(second.replayed, true)
    assert.equal(second.receiptId, first.receiptId)

    const batches = await database.query('select count(*)::int as c from public.ingredient_batches where store_id=$1 and ingredient_id=$2', [store, ingredient])
    assert.equal(batches.rows[0].c, 1)
    const movements = await database.query('select count(*)::int as c from public.stock_movements where store_id=$1 and ingredient_id=$2', [store, ingredient])
    assert.equal(movements.rows[0].c, 1)
    const ingredientRow = await database.query('select current_stock from public.ingredients where id=$1', [ingredient])
    assert.equal(Number(ingredientRow.rows[0].current_stock), 24)
  } finally {
    await database.close()
  }
})

test('receive: over-receipt without manager_approved is rejected; with approval + reason succeeds', async () => {
  const database = await seededDatabase()
  try {
    const { store, vendor, ingredient } = await seedStoreWithVendorAndIngredient(database)
    const { po, line } = await seedPo(database, store, vendor, ingredient, 10, 100)
    const client = clientFor(database)

    await client.query('begin')
    await assert.rejects(
      receivePurchaseOrderCore(client, store, po, { lines: [{ purchase_order_line_id: line, received_quantity: 15 }] }),
      /over_receipt_requires_approval|requires manager approval/,
    )
    await client.query('rollback')

    await client.query('begin')
    const result = await receivePurchaseOrderCore(client, store, po, {
      manager_approved: true,
      manager_approval_reason: 'Vendor shipped extra, keeping it',
      lines: [{ purchase_order_line_id: line, received_quantity: 15 }],
    })
    await client.query('commit')
    assert.equal(result.replayed, false)

    const poLine = await database.query('select received_quantity from public.purchase_order_lines where id=$1', [line])
    assert.equal(Number(poLine.rows[0].received_quantity), 15)
  } finally {
    await database.close()
  }
})

test('cancelling a PO after partial receipt does not reverse stock already received', async () => {
  const database = await seededDatabase()
  try {
    const { store, vendor, ingredient } = await seedStoreWithVendorAndIngredient(database)
    const { po, line } = await seedPo(database, store, vendor, ingredient, 10, 100)
    const client = clientFor(database)

    await client.query('begin')
    await receivePurchaseOrderCore(client, store, po, { lines: [{ purchase_order_line_id: line, received_quantity: 4 }] })
    await client.query('commit')

    await database.query(`update public.purchase_orders set status='cancelled', cancelled_at=now() where id=$1`, [po])

    const batches = await database.query('select count(*)::int as c from public.ingredient_batches where store_id=$1 and ingredient_id=$2', [store, ingredient])
    assert.equal(batches.rows[0].c, 1)
    const movements = await database.query('select count(*)::int as c from public.stock_movements where store_id=$1 and ingredient_id=$2', [store, ingredient])
    assert.equal(movements.rows[0].c, 1)
    const ingredientRow = await database.query('select current_stock from public.ingredients where id=$1', [ingredient])
    assert.equal(Number(ingredientRow.rows[0].current_stock), 24)

    // Receiving against a cancelled PO is rejected.
    await client.query('begin')
    await assert.rejects(
      receivePurchaseOrderCore(client, store, po, { lines: [{ purchase_order_line_id: line, received_quantity: 1 }] }),
      /po_cancelled|cannot receive more stock/,
    )
    await client.query('rollback')
  } finally {
    await database.close()
  }
})

test('cost reconciliation: update_ingredient_costs with approval writes history and updates cost; without approval is rejected', async () => {
  const database = await seededDatabase()
  try {
    const { store, vendor, ingredient } = await seedStoreWithVendorAndIngredient(database)
    const { po, line } = await seedPo(database, store, vendor, ingredient, 10, 100)
    const client = clientFor(database)

    // Without manager approval / reason at all: rejected up front (approval required whenever update_ingredient_costs is set).
    await client.query('begin')
    await assert.rejects(
      receivePurchaseOrderCore(client, store, po, {
        update_ingredient_costs: true,
        lines: [{ purchase_order_line_id: line, received_quantity: 4, unit_cost_cents: 120 }],
      }),
      /validation_failed|requires a reason/,
    )
    await client.query('rollback')

    await client.query('begin')
    await receivePurchaseOrderCore(client, store, po, {
      manager_approved: true,
      manager_approval_reason: 'Vendor price increase',
      update_ingredient_costs: true,
      lines: [{ purchase_order_line_id: line, received_quantity: 4, unit_cost_cents: 120 }],
    })
    await client.query('commit')

    const ingredientRow = await database.query('select cost_per_unit_cents from public.ingredients where id=$1', [ingredient])
    assert.equal(Number(ingredientRow.rows[0].cost_per_unit_cents), 120)

    const history = await database.query('select previous_unit_cost_cents, new_unit_cost_cents, reason from public.ingredient_cost_history where store_id=$1 and ingredient_id=$2', [store, ingredient])
    assert.equal(history.rows.length, 1)
    assert.equal(Number(history.rows[0].previous_unit_cost_cents), 50)
    assert.equal(Number(history.rows[0].new_unit_cost_cents), 120)
  } finally {
    await database.close()
  }
})
