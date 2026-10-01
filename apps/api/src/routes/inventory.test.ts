import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { seededInventoryDatabase } from './inventory-test-support.js'

// Import the route module after setting a harmless pool URL; the pure validation tests below
// never open a connection. The wastage write path (recordWastageCore) and batch allocation are
// covered in inventory-wastage.test.ts and stock-valuation.test.ts.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { assertWastageWithinStock, countExpiringBatches } = await import('./inventory.js')
const { db } = await import('../db.js')

test('rejects wastage that would take stock below zero', () => {
  assert.throws(() => assertWastageWithinStock(5_000_000n, 10_000_000n), /only 5 in stock/)
})

test('allows wastage that leaves stock at exactly zero', () => {
  assert.doesNotThrow(() => assertWastageWithinStock(5_000_000n, 5_000_000n))
})

test('allows wastage smaller than current stock', () => {
  assert.doesNotThrow(() => assertWastageWithinStock(10_000_000n, 5_000_000n))
})

async function seedIngredient(database: PGlite) {
  const owner = randomUUID(), store = randomUUID(), kg = randomUUID(), ingredient = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','wastage-test',$2,'UTC')", [store, owner])
  await database.query(`insert into public.units(id,store_id,name,abbreviation,kind) values ($1,$2,'Kilogram','kg','mass')`, [kg, store])
  await database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Flour',$3,50,20)`, [ingredient, store, kg])
  return { store, ingredient }
}

test('countExpiringBatches counts batches expiring within 3 days or already expired, excluding depleted or far-off ones', async () => {
  const database = await seededInventoryDatabase()
  try {
    const { store, ingredient } = await seedIngredient(database)
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
