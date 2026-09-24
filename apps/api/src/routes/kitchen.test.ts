import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Same pattern as floor.test.ts: consumeRecipeIngredients is exported specifically so it can be
// tested directly against real Postgres semantics (PGlite) rather than only through the thin,
// auth-wrapped HTTP handler, which stays manual-QA-only for now (docs/MODULE_STATUS.md).
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { consumeRecipeIngredients } = await import('./kitchen.js')

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

// Shared fixture: a store, a 'kg' unit, an ingredient priced/stocked in kg, a product with a
// recipe that uses 2kg of that ingredient per 1-unit batch, and one paid order line for that
// product so a kitchen_ticket_item exists to serve.
async function seedRecipeFixture(database: PGlite, options: { currentStock: number; quantitySold: number; mismatchUnit?: boolean }) {
  const owner = randomUUID(), store = randomUUID(), product = randomUUID()
  const kg = randomUUID(), litre = randomUUID(), ingredient = randomUUID(), recipe = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','kitchen-test',$2,'UTC')", [store, owner])
  await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-1','Test dish',1200)`, [product, store])
  await database.query(`insert into public.units(id,store_id,name,abbreviation,kind) values ($1,$2,'Kilogram','kg','mass')`, [kg, store])
  await database.query(`insert into public.units(id,store_id,name,abbreviation,kind) values ($1,$2,'Litre','L','volume')`, [litre, store])
  await database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Flour',$3,50,$4)`, [ingredient, store, kg, options.currentStock])
  await database.query(`insert into public.recipes(id,store_id,product_id,yield_quantity,yield_unit_id) values ($1,$2,$3,1,$4)`, [recipe, store, product, kg])
  await database.query(`insert into public.recipe_ingredients(id,store_id,recipe_id,ingredient_id,quantity,unit_id) values ($1,$2,$3,$4,2,$5)`,
    [randomUUID(), store, recipe, ingredient, options.mismatchUnit ? litre : kg])

  const orderId = randomUUID()
  await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
    subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,order_type)
    values ($1,$2,$3,'USD','One','UTC',1200,0,0,1200,1,now(),'dine_in')`, [orderId, store, `KTN-${orderId.slice(0, 8)}`])
  const orderItemId = randomUUID()
  await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
    snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
    values ($1,$2,$3,$4,'Test dish','SKU-1',1200,0,1,$5,1200,0,1200,0,1200)`, [orderItemId, store, orderId, product, options.quantitySold])
  const ticketId = randomUUID()
  await database.query(`insert into public.kitchen_tickets(id,store_id,order_id,status) values ($1,$2,$3,'preparing')`, [ticketId, store, orderId])
  const itemId = randomUUID()
  await database.query(`insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,status) values ($1,$2,$3,$4,'preparing')`, [itemId, store, ticketId, orderItemId])

  return { store, product, ingredient, itemId }
}

test('consumeRecipeIngredients decrements stock by (line quantity / yield) * quantity sold', async () => {
  const database = await seededDatabase()
  try {
    const { store, product, ingredient, itemId } = await seedRecipeFixture(database, { currentStock: 10, quantitySold: 3 })
    const client = clientFor(database)
    await consumeRecipeIngredients(client, store, itemId, product, 3)

    const movement = await database.query<{ delta: string; reason: string; kitchen_ticket_item_id: string }>(
      'select delta, reason, kitchen_ticket_item_id from public.stock_movements where ingredient_id=$1', [ingredient],
    )
    assert.equal(movement.rows.length, 1)
    assert.equal(movement.rows[0].reason, 'consumption')
    assert.equal(Number(movement.rows[0].delta), -6) // (2kg / 1 yield) * 3 sold
    assert.equal(movement.rows[0].kitchen_ticket_item_id, itemId)

    const stock = await database.query<{ current_stock: string }>('select current_stock from public.ingredients where id=$1', [ingredient])
    assert.equal(Number(stock.rows[0].current_stock), 4) // 10 - 6
  } finally {
    await database.close()
  }
})

test('consumeRecipeIngredients allows stock to go negative rather than blocking service', async () => {
  const database = await seededDatabase()
  try {
    const { store, product, ingredient, itemId } = await seedRecipeFixture(database, { currentStock: 2, quantitySold: 3 })
    const client = clientFor(database)
    await assert.doesNotReject(consumeRecipeIngredients(client, store, itemId, product, 3))

    const stock = await database.query<{ current_stock: string }>('select current_stock from public.ingredients where id=$1', [ingredient])
    assert.equal(Number(stock.rows[0].current_stock), -4) // 2 - 6, never blocked or clamped
  } finally {
    await database.close()
  }
})

test('consumeRecipeIngredients is idempotent for the same kitchen ticket item', async () => {
  const database = await seededDatabase()
  try {
    const { store, product, ingredient, itemId } = await seedRecipeFixture(database, { currentStock: 10, quantitySold: 3 })
    const client = clientFor(database)
    await consumeRecipeIngredients(client, store, itemId, product, 3)
    await consumeRecipeIngredients(client, store, itemId, product, 3) // simulated retry/duplicate call

    const movements = await database.query('select 1 from public.stock_movements where ingredient_id=$1', [ingredient])
    assert.equal(movements.rows.length, 1, 'a second call for the same item must not double-consume')
    const stock = await database.query<{ current_stock: string }>('select current_stock from public.ingredients where id=$1', [ingredient])
    assert.equal(Number(stock.rows[0].current_stock), 4)
  } finally {
    await database.close()
  }
})

test('consumeRecipeIngredients skips a line whose unit does not match its ingredient\'s stored unit', async () => {
  const database = await seededDatabase()
  try {
    const { store, product, ingredient, itemId } = await seedRecipeFixture(database, { currentStock: 10, quantitySold: 3, mismatchUnit: true })
    const client = clientFor(database)
    await consumeRecipeIngredients(client, store, itemId, product, 3)

    const movements = await database.query('select 1 from public.stock_movements where ingredient_id=$1', [ingredient])
    assert.equal(movements.rows.length, 0, 'a unit mismatch must be skipped, never guessed at')
    const stock = await database.query<{ current_stock: string }>('select current_stock from public.ingredients where id=$1', [ingredient])
    assert.equal(Number(stock.rows[0].current_stock), 10, 'stock is untouched when the line is skipped')
  } finally {
    await database.close()
  }
})

test('consumeRecipeIngredients is a no-op for a product with no recipe', async () => {
  const database = await seededDatabase()
  try {
    const owner = randomUUID(), store = randomUUID(), product = randomUUID(), ticket = randomUUID(), orderId = randomUUID(), orderItemId = randomUUID(), itemId = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','kitchen-norecipe-test',$2,'UTC')", [store, owner])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-2','No recipe dish',900)`, [product, store])
    await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,order_type)
      values ($1,$2,$3,'USD','One','UTC',900,0,0,900,1,now(),'dine_in')`, [orderId, store, `KTN2-${orderId.slice(0, 8)}`])
    await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
      snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
      values ($1,$2,$3,$4,'No recipe dish','SKU-2',900,0,1,1,900,0,900,0,900)`, [orderItemId, store, orderId, product])
    await database.query(`insert into public.kitchen_tickets(id,store_id,order_id,status) values ($1,$2,$3,'preparing')`, [ticket, store, orderId])
    await database.query(`insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,status) values ($1,$2,$3,$4,'preparing')`, [itemId, store, ticket, orderItemId])

    const client = clientFor(database)
    await assert.doesNotReject(consumeRecipeIngredients(client, store, itemId, product, 1))
  } finally {
    await database.close()
  }
})
