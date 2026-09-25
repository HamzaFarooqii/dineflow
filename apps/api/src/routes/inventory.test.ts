import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Import the route module after setting a harmless pool URL; the pure validation tests below
// never open a connection. selectWastageBatch is exported specifically so its real Postgres
// semantics can be tested directly (PGlite), same reasoning as kitchen.ts's
// consumeRecipeIngredients -- the thin, auth-wrapped HTTP handler stays manual-QA-only for now.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { assertWastageWithinStock, selectWastageBatch, countExpiringBatches } = await import('./inventory.js')
const { db } = await import('../db.js')

test('rejects wastage that would take stock below zero', () => {
  assert.throws(() => assertWastageWithinStock(5, 10), /only 5 in stock/)
})

test('allows wastage that leaves stock at exactly zero', () => {
  assert.doesNotThrow(() => assertWastageWithinStock(5, 5))
})

test('allows wastage smaller than current stock', () => {
  assert.doesNotThrow(() => assertWastageWithinStock(10, 5))
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

async function seedIngredientWithBatches(database: PGlite) {
  const owner = randomUUID(), store = randomUUID(), kg = randomUUID(), ingredient = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','wastage-test',$2,'UTC')", [store, owner])
  await database.query(`insert into public.units(id,store_id,name,abbreviation,kind) values ($1,$2,'Kilogram','kg','mass')`, [kg, store])
  await database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Flour',$3,50,20)`, [ingredient, store, kg])
  return { store, ingredient }
}

test('selectWastageBatch auto-selects the soonest-expiring batch (FEFO) when it fully covers the quantity', async () => {
  const database = await seededDatabase()
  try {
    const { store, ingredient } = await seedIngredientWithBatches(database)
    const soonBatch = randomUUID(), laterBatch = randomUUID()
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents,expires_at)
      values ($1,$2,$3,10,10,50,'2026-10-01T00:00:00Z')`, [soonBatch, store, ingredient])
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents,expires_at)
      values ($1,$2,$3,10,10,50,'2026-11-01T00:00:00Z')`, [laterBatch, store, ingredient])

    const client = clientFor(database)
    const chosen = await client.query('begin').then(() => selectWastageBatch(client, store, ingredient, 3, null))
    assert.equal(chosen, soonBatch)
  } finally {
    await database.close()
  }
})

test('selectWastageBatch falls back to ingredient-level tracking when no single batch covers the quantity', async () => {
  const database = await seededDatabase()
  try {
    const { store, ingredient } = await seedIngredientWithBatches(database)
    const batchA = randomUUID(), batchB = randomUUID()
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents)
      values ($1,$2,$3,5,5,50)`, [batchA, store, ingredient])
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents)
      values ($1,$2,$3,5,5,50)`, [batchB, store, ingredient])

    const client = clientFor(database)
    await client.query('begin')
    const chosen = await selectWastageBatch(client, store, ingredient, 8, null) // exceeds either batch alone
    assert.equal(chosen, null)
  } finally {
    await database.close()
  }
})

test('selectWastageBatch accepts an explicit batch that covers the quantity', async () => {
  const database = await seededDatabase()
  try {
    const { store, ingredient } = await seedIngredientWithBatches(database)
    const batch = randomUUID()
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents)
      values ($1,$2,$3,5,5,50)`, [batch, store, ingredient])

    const client = clientFor(database)
    await client.query('begin')
    assert.equal(await selectWastageBatch(client, store, ingredient, 3, batch), batch)
  } finally {
    await database.close()
  }
})

test('selectWastageBatch rejects an explicit batch that cannot cover the quantity', async () => {
  const database = await seededDatabase()
  try {
    const { store, ingredient } = await seedIngredientWithBatches(database)
    const batch = randomUUID()
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents)
      values ($1,$2,$3,5,5,50)`, [batch, store, ingredient])

    const client = clientFor(database)
    await client.query('begin')
    await assert.rejects(selectWastageBatch(client, store, ingredient, 8, batch), /only 5 remaining in it/)
  } finally {
    await database.close()
  }
})

test('selectWastageBatch rejects an explicit batch that belongs to a different ingredient', async () => {
  const database = await seededDatabase()
  try {
    const { store, ingredient } = await seedIngredientWithBatches(database)
    const otherIngredient = randomUUID(), kg = randomUUID(), otherBatch = randomUUID()
    await database.query(`insert into public.units(id,store_id,name,abbreviation,kind) values ($1,$2,'Kilogram 2','kg2','mass')`, [kg, store])
    await database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Sugar',$3,50,20)`, [otherIngredient, store, kg])
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents)
      values ($1,$2,$3,5,5,50)`, [otherBatch, store, otherIngredient])

    const client = clientFor(database)
    await client.query('begin')
    await assert.rejects(selectWastageBatch(client, store, ingredient, 1, otherBatch), /does not belong to this ingredient/)
  } finally {
    await database.close()
  }
})

test('countExpiringBatches counts batches expiring within 3 days or already expired, excluding depleted or far-off ones', async () => {
  const database = await seededDatabase()
  try {
    const { store, ingredient } = await seedIngredientWithBatches(database)
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents,expires_at)
      values ($1,$2,$3,5,5,50,now() + interval '1 day')`, [randomUUID(), store, ingredient]) // expiring soon
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents,expires_at)
      values ($1,$2,$3,5,5,50,now() - interval '1 day')`, [randomUUID(), store, ingredient]) // already expired
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents,expires_at)
      values ($1,$2,$3,5,0,50,now() - interval '1 day')`, [randomUUID(), store, ingredient]) // expired but depleted -- doesn't count
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents,expires_at)
      values ($1,$2,$3,5,5,50,now() + interval '30 days')`, [randomUUID(), store, ingredient]) // far off -- doesn't count
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents)
      values ($1,$2,$3,5,5,50)`, [randomUUID(), store, ingredient]) // no expiry at all -- doesn't count

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }

    assert.equal(await countExpiringBatches(store), 2)
  } finally {
    await database.close()
  }
})
