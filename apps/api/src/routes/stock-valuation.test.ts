import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  addBatch, addKitchenItem, clientFor, inTransaction, remainingOf, seededInventoryDatabase, seedInventoryFixture, stockOf,
} from './inventory-test-support.js'

// Day 2 batch valuation, exercised against real Postgres semantics (PGlite) through the same
// exported core the KDS "served" transition calls. Valuation rule under test: each unit is costed
// at the purchase cost of the batch it was physically allocated from (earliest expiry first, then
// oldest received, then id), snapshotted at movement time -- NOT FIFO/LIFO/weighted average.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { consumeRecipeIngredients } = await import('./kitchen.js')
const { receivePurchaseOrderCore } = await import('./purchasing.js')

interface AllocationRow { batch_id: string | null; quantity: string; unit_cost_cents: number; cost_cents: string; cost_basis: string }

async function allocationsFor(database: import('@electric-sql/pglite').PGlite, ingredient: string): Promise<AllocationRow[]> {
  const rows = await database.query<AllocationRow>(
    `select a.batch_id, a.quantity::text as quantity, a.unit_cost_cents, a.cost_cents::text as cost_cents, a.cost_basis
     from public.stock_movement_allocations a where a.ingredient_id=$1 order by a.created_at, a.sequence`, [ingredient])
  return rows.rows
}

async function costLine(database: import('@electric-sql/pglite').PGlite, ingredient: string) {
  const rows = await database.query<{ known: string; estimated: string; has_estimate: boolean; unknown_cost: boolean; cost_source: string }>(
    `select known_cost_cents::text as known, estimated_cost_cents::text as estimated, has_estimate, unknown_cost, cost_source
     from public.stock_movement_cost_lines where ingredient_id=$1 and reason='consumption'`, [ingredient])
  return rows.rows
}

test('a single batch covering the quantity is recorded on the movement and snapshots its own cost', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 10 })
    const batch = await addBatch(database, f, f.ingredient, { quantity: 10, costCents: 120 })
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 2)
    await consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 1)

    const movement = await database.query<{ batch_id: string | null; delta: string }>('select batch_id, delta::text as delta from public.stock_movements where ingredient_id=$1', [f.ingredient])
    assert.equal(movement.rows[0].batch_id, batch, 'one batch covered it all, so the legacy column still names it')
    assert.equal(Number(movement.rows[0].delta), -2)
    assert.deepEqual((await allocationsFor(database, f.ingredient)).map(a => [a.batch_id, Number(a.quantity), a.unit_cost_cents, Number(a.cost_cents), a.cost_basis]), [[batch, 2, 120, 240, 'batch']])
    assert.equal(await remainingOf(database, batch), 8)
    assert.equal(await stockOf(database, f.ingredient), 8)
  } finally { await database.close() }
})

test('multiple batches with different costs: each unit is costed at the batch it came from', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 14 })
    const soon = await addBatch(database, f, f.ingredient, { quantity: 4, costCents: 50, expiresAt: '2026-10-05T00:00:00Z' })
    const later = await addBatch(database, f, f.ingredient, { quantity: 10, costCents: 80, expiresAt: '2026-11-05T00:00:00Z' })
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 6)
    await consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 1)

    assert.deepEqual((await allocationsFor(database, f.ingredient)).map(a => [a.batch_id, Number(a.quantity), a.unit_cost_cents, Number(a.cost_cents)]),
      [[soon, 4, 50, 200], [later, 2, 80, 160]])
    assert.equal(await remainingOf(database, soon), 0)
    assert.equal(await remainingOf(database, later), 8)
    assert.equal(await stockOf(database, f.ingredient), 8, 'aggregate stock and batches move together')
    const [line] = await costLine(database, f.ingredient)
    assert.equal(Number(line.known), 360)
    assert.equal(Number(line.estimated), 0)
    assert.equal(line.cost_source, 'allocation_snapshot')
    const batchId = await database.query('select batch_id from public.stock_movements where ingredient_id=$1', [f.ingredient])
    assert.equal(batchId.rows[0].batch_id, null, 'a spanning movement names no single batch')
  } finally { await database.close() }
})

test('physical picking order is earliest expiry, then oldest received, then id; no-expiry batches come last', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 4 })
    const noExpiryOld = await addBatch(database, f, f.ingredient, { quantity: 1, costCents: 10, receivedAt: '2026-09-01T00:00:00Z' })
    const laterExpiry = await addBatch(database, f, f.ingredient, { quantity: 1, costCents: 20, expiresAt: '2026-12-01T00:00:00Z', receivedAt: '2026-09-02T00:00:00Z' })
    const sameExpiryNewer = await addBatch(database, f, f.ingredient, { quantity: 1, costCents: 30, expiresAt: '2026-11-01T00:00:00Z', receivedAt: '2026-09-20T00:00:00Z' })
    const sameExpiryOlder = await addBatch(database, f, f.ingredient, { quantity: 1, costCents: 40, expiresAt: '2026-11-01T00:00:00Z', receivedAt: '2026-09-10T00:00:00Z' })
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 4)
    await consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 1)
    assert.deepEqual((await allocationsFor(database, f.ingredient)).map(a => a.batch_id), [sameExpiryOlder, sameExpiryNewer, laterExpiry, noExpiryOld])
  } finally { await database.close() }
})

test('equal expiry and received time fall back to id so the order is total', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 2 })
    const first = await addBatch(database, f, f.ingredient, { quantity: 1, costCents: 10, expiresAt: '2026-11-01T00:00:00Z', receivedAt: '2026-09-10T00:00:00Z' })
    const second = await addBatch(database, f, f.ingredient, { quantity: 1, costCents: 20, expiresAt: '2026-11-01T00:00:00Z', receivedAt: '2026-09-10T00:00:00Z' })
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 2)
    await consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 1)
    assert.deepEqual((await allocationsFor(database, f.ingredient)).map(a => a.batch_id), [first, second].sort())
  } finally { await database.close() }
})

test('fractional quantities and unit conversion: 250 g per sale against an ingredient stocked in kg', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 2 })
    const small = await addBatch(database, f, f.ingredient, { quantity: 0.5, costCents: 100, expiresAt: '2026-10-05T00:00:00Z' })
    const big = await addBatch(database, f, f.ingredient, { quantity: 1.5, costCents: 200, expiresAt: '2026-11-05T00:00:00Z' })
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.gram, 250, 3)
    await consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 3) // 3 sold x 250 g = 0.75 kg

    const movement = await database.query<{ delta: string }>('select delta::text as delta from public.stock_movements where ingredient_id=$1', [f.ingredient])
    assert.equal(movement.rows[0].delta, '-0.75', 'grams were converted to kg exactly once, with no float noise')
    assert.deepEqual((await allocationsFor(database, f.ingredient)).map(a => [a.batch_id, a.quantity, Number(a.cost_cents)]), [[small, '0.5', 50], [big, '0.25', 50]])
    assert.equal(await remainingOf(database, big), 1.25)
    assert.equal(await stockOf(database, f.ingredient), 1.25)
  } finally { await database.close() }
})

test('an incompatible unit is skipped, never guessed at 1:1', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 5 })
    await addBatch(database, f, f.ingredient, { quantity: 5, costCents: 100 })
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.litre, 1)
    await consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 1)
    assert.equal((await database.query('select 1 from public.stock_movements where ingredient_id=$1', [f.ingredient])).rows.length, 0)
    assert.equal(await stockOf(database, f.ingredient), 5)
  } finally { await database.close() }
})

test('missing batch coverage is labelled as an estimate at the ingredient cost and never attributed to a batch', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 6, ingredientCostCents: 70 })
    const batch = await addBatch(database, f, f.ingredient, { quantity: 1, costCents: 50 })
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 3)
    await consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 1)

    assert.deepEqual((await allocationsFor(database, f.ingredient)).map(a => [a.batch_id, Number(a.quantity), a.unit_cost_cents, a.cost_basis]),
      [[batch, 1, 50, 'batch'], [null, 2, 70, 'estimated_ingredient_cost']])
    const [line] = await costLine(database, f.ingredient)
    assert.equal(Number(line.known), 50)
    assert.equal(Number(line.estimated), 140)
    assert.equal(line.has_estimate, true)
    assert.equal(line.unknown_cost, false)
    assert.equal(await remainingOf(database, batch), 0)
  } finally { await database.close() }
})

test('no batches at all: consumption still records, fully estimated, and aggregate stock may go negative', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 1, ingredientCostCents: 70 })
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 3)
    await assert.doesNotReject(consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 1))
    assert.equal(await stockOf(database, f.ingredient), -2, 'served-item consumption is never blocked or clamped')
    assert.deepEqual((await allocationsFor(database, f.ingredient)).map(a => [a.batch_id, Number(a.quantity), a.cost_basis]), [[null, 3, 'estimated_ingredient_cost']])
  } finally { await database.close() }
})

test('consumption is idempotent per kitchen item: a retry changes nothing, and the database backstops it', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 10 })
    const batch = await addBatch(database, f, f.ingredient, { quantity: 10, costCents: 100 })
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 2)
    const client = clientFor(database)
    await consumeRecipeIngredients(client, f.store, itemId, product, 1)
    await consumeRecipeIngredients(client, f.store, itemId, product, 1)
    assert.equal((await database.query('select 1 from public.stock_movements where ingredient_id=$1', [f.ingredient])).rows.length, 1)
    assert.equal((await allocationsFor(database, f.ingredient)).length, 1)
    assert.equal(await remainingOf(database, batch), 8)
    assert.equal(await stockOf(database, f.ingredient), 8)
    await assert.rejects(
      database.query(`insert into public.stock_movements(store_id,ingredient_id,delta,reason,kitchen_ticket_item_id) values ($1,$2,-1,'consumption',$3)`, [f.store, f.ingredient, itemId]),
      /stock_movements_one_consumption_per_item_ingredient/)
  } finally { await database.close() }
})

test('two recipe lines for the same ingredient consume their sum once', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 10 })
    await addBatch(database, f, f.ingredient, { quantity: 10, costCents: 100 })
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 1)
    const recipe = await database.query<{ id: string }>('select id from public.recipes where product_id=$1', [product])
    await database.query(`insert into public.recipe_ingredients(id,store_id,recipe_id,ingredient_id,quantity,unit_id) values ($1,$2,$3,$4,500,$5)`, [randomUUID(), f.store, recipe.rows[0].id, f.ingredient, f.gram])
    await consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 1)
    assert.equal(await stockOf(database, f.ingredient), 8.5, '1 kg + 500 g')
  } finally { await database.close() }
})

test('ingredients are locked in ascending id order whatever order the recipe lists them', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 5 })
    const second = randomUUID(), third = randomUUID()
    for (const id of [second, third]) {
      await database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,$3,$4,10,5)`, [id, f.store, `Item ${id.slice(0, 4)}`, f.kg])
    }
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 1)
    const recipe = await database.query<{ id: string }>('select id from public.recipes where product_id=$1', [product])
    for (const id of [third, second]) {
      await database.query(`insert into public.recipe_ingredients(id,store_id,recipe_id,ingredient_id,quantity,unit_id) values ($1,$2,$3,$4,1,$5)`, [randomUUID(), f.store, recipe.rows[0].id, id, f.kg])
    }
    const locked: string[] = []
    const base = clientFor(database)
    const spy = { query: async (sql: string, params?: unknown[]) => {
      if (/from public\.ingredients where store_id = \$1 and id = \$2 for update/.test(sql)) locked.push(String(params?.[1]))
      return base.query(sql, params)
    } } as unknown as import('pg').PoolClient
    await consumeRecipeIngredients(spy, f.store, itemId, product, 1)
    assert.deepEqual(locked, [f.ingredient, second, third].sort())
  } finally { await database.close() }
})

test('concurrent consumption of the same ingredient never double-allocates a batch', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 5 })
    const batch = await addBatch(database, f, f.ingredient, { quantity: 5, costCents: 100, expiresAt: '2026-10-05T00:00:00Z' })
    const next = await addBatch(database, f, f.ingredient, { quantity: 5, costCents: 300, expiresAt: '2026-11-05T00:00:00Z' })
    const one = await addKitchenItem(database, f, f.ingredient, f.kg, 4)
    const two = await addKitchenItem(database, f, f.ingredient, f.kg, 4)
    await Promise.all([
      inTransaction(database, client => consumeRecipeIngredients(client, f.store, one.itemId, one.product, 1)),
      inTransaction(database, client => consumeRecipeIngredients(client, f.store, two.itemId, two.product, 1)),
    ])
    assert.equal(await remainingOf(database, batch), 0)
    assert.equal(await remainingOf(database, next), 2)
    assert.equal(await stockOf(database, f.ingredient), -3, 'aggregate started at 5 and 8 were consumed')
    const total = await database.query<{ cost: string }>('select sum(cost_cents)::text as cost from public.stock_movement_allocations where ingredient_id=$1', [f.ingredient])
    assert.equal(Number(total.rows[0].cost), 5 * 100 + 3 * 300, 'every unit costed exactly once')
  } finally { await database.close() }
})

test('later ingredient and batch price edits never change historical valuation; allocations are append-only', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 10, ingredientCostCents: 70 })
    await addBatch(database, f, f.ingredient, { quantity: 1, costCents: 100 })
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 3)
    await consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 1) // 1 kg @100 + 2 kg estimated @70
    const before = await costLine(database, f.ingredient)

    await database.query('update public.ingredients set cost_per_unit_cents = 9999 where id=$1', [f.ingredient])
    await assert.rejects(database.query('update public.ingredient_batches set cost_per_unit_cents = 8888 where ingredient_id=$1', [f.ingredient]), /cannot be changed/)
    assert.deepEqual(await costLine(database, f.ingredient), before)
    assert.deepEqual((await allocationsFor(database, f.ingredient)).map(a => a.unit_cost_cents), [100, 70])
    await assert.rejects(database.query('update public.stock_movement_allocations set unit_cost_cents = 1 where ingredient_id=$1', [f.ingredient]), /append-only/)
  } finally { await database.close() }
})

test('receiving replay: the same operation id posts one batch, and consumption is then costed at that batch price even after a cost reconciliation', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 0, ingredientCostCents: 70 })
    const vendor = randomUUID(), po = randomUUID(), line = randomUUID(), operation = randomUUID()
    await database.query(`insert into public.vendors(id,store_id,name) values ($1,$2,'Acme')`, [vendor, f.store])
    await database.query(`insert into public.purchase_orders(id,store_id,vendor_id,status) values ($1,$2,$3,'sent')`, [po, f.store, vendor])
    await database.query(`insert into public.purchase_order_lines(id,store_id,purchase_order_id,ingredient_id,ordered_quantity,unit_cost_cents) values ($1,$2,$3,$4,10,110)`, [line, f.store, po, f.ingredient])
    const receive = (extra: Record<string, unknown> = {}) => inTransaction(database, client =>
      receivePurchaseOrderCore(client, f.store, po, { operation_id: operation, lines: [{ purchase_order_line_id: line, received_quantity: 10 }], ...extra }))
    const first = await receive()
    const replay = await receive()
    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal((await database.query('select 1 from public.ingredient_batches where ingredient_id=$1', [f.ingredient])).rows.length, 1)
    assert.equal(await stockOf(database, f.ingredient), 10)

    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 2)
    await consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 1)

    // A later, approved cost reconciliation moves the ingredient's current price (and writes
    // ingredient_cost_history) but must not touch what was already consumed.
    await inTransaction(database, client => receivePurchaseOrderCore(client, f.store, po, {
      operation_id: randomUUID(), lines: [{ purchase_order_line_id: line, received_quantity: 1, unit_cost_cents: 500 }],
      manager_approved: true, manager_approval_reason: 'supplier price rise', update_ingredient_costs: true,
    }))
    assert.equal((await database.query('select cost_per_unit_cents from public.ingredients where id=$1', [f.ingredient])).rows[0].cost_per_unit_cents, 500)
    assert.equal((await database.query('select 1 from public.ingredient_cost_history where ingredient_id=$1', [f.ingredient])).rows.length, 1)
    const [row] = await costLine(database, f.ingredient)
    assert.equal(Number(row.known), 220, '2 kg at the 110c batch cost, unaffected by the later 500c price')
  } finally { await database.close() }
})

test('the database rejects an allocation naming a batch from another ingredient or another store', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 10 })
    const other = randomUUID()
    await database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Sugar',$3,10,10)`, [other, f.store, f.kg])
    const otherIngredientBatch = await addBatch(database, f, other, { quantity: 5, costCents: 10 })
    const otherStoreUnit = await database.query<{ id: string }>('select id from public.units where store_id=$1 limit 1', [f.otherStore])
    const foreignIngredient = randomUUID(), foreignBatch = randomUUID()
    await database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Salt',$3,10,10)`, [foreignIngredient, f.otherStore, otherStoreUnit.rows[0].id])
    await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents) values ($1,$2,$3,5,5,10)`, [foreignBatch, f.otherStore, foreignIngredient])
    const movement = await database.query<{ id: string }>(
      `insert into public.stock_movements(store_id,ingredient_id,delta,reason) values ($1,$2,-1,'consumption') returning id`, [f.store, f.ingredient])
    const insert = (batch: string) => database.query(
      `insert into public.stock_movement_allocations(store_id,stock_movement_id,ingredient_id,batch_id,sequence,quantity,unit_cost_cents,cost_cents,cost_basis)
       values ($1,$2,$3,$4,1,1,10,10,'batch')`, [f.store, movement.rows[0].id, f.ingredient, batch])
    await assert.rejects(insert(otherIngredientBatch), /violates foreign key/)
    await assert.rejects(insert(foreignBatch), /violates foreign key/)
  } finally { await database.close() }
})

test('a legacy consumption movement with no allocation rows is valued from its own batch, or reported unknown -- never priced today', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 10, ingredientCostCents: 999 })
    const batch = await addBatch(database, f, f.ingredient, { quantity: 10, costCents: 40 })
    await database.query(`insert into public.stock_movements(store_id,ingredient_id,batch_id,delta,reason) values ($1,$2,$3,-3,'consumption')`, [f.store, f.ingredient, batch])
    await database.query(`insert into public.stock_movements(store_id,ingredient_id,delta,reason) values ($1,$2,-2,'consumption')`, [f.store, f.ingredient])
    const rows = await database.query<{ cost_source: string; known: string; unknown_cost: boolean }>(
      `select cost_source, known_cost_cents::text as known, unknown_cost from public.stock_movement_cost_lines where ingredient_id=$1 order by cost_source`, [f.ingredient])
    assert.deepEqual(rows.rows.map(r => [r.cost_source, Number(r.known), r.unknown_cost]), [['legacy_batch_derived', 120, false], ['unknown', 0, true]])
  } finally { await database.close() }
})

test('legacy float-dust batch remainders are truncated, so draining a batch can never push it below zero', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 10 })
    // What pre-Day-2 float consumption left behind: 5 - 0.30000000000000004 = 4.69999999999999996
    const batch = await addBatch(database, f, f.ingredient, { quantity: 5, remaining: 4.69999999999999996, costCents: 100 })
    await database.query('update public.ingredient_batches set remaining_quantity = 4.69999999999999996 where id=$1', [batch])
    const { product, itemId } = await addKitchenItem(database, f, f.ingredient, f.kg, 6)
    await assert.doesNotReject(consumeRecipeIngredients(clientFor(database), f.store, itemId, product, 1))
    assert.ok(await remainingOf(database, batch) >= 0, 'the batch is drained, not driven negative')
    const allocations = await allocationsFor(database, f.ingredient)
    assert.deepEqual(allocations.map(a => [a.batch_id, a.quantity, a.cost_basis]), [[batch, '4.699999', 'batch'], [null, '1.300001', 'estimated_ingredient_cost']])
  } finally { await database.close() }
})
