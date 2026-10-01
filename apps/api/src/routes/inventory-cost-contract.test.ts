import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { summarizeInventoryCost } from '../../../../packages/domain/src/inventory-cost-summary.js'
import {
  COST_CONTRACT_EXAMPLE_EXPECTED, COST_CONTRACT_EXAMPLE_GROUPS, COST_CONTRACT_EXAMPLE_PERIOD,
} from '../../../../packages/domain/src/inventory-cost-summary.fixtures.js'
import {
  addBatch, addKitchenItem, clientFor, INVENTORY_MIGRATION_CHAIN, inTransaction, repoRoot, seededInventoryDatabase, seedCostContractScenario,
  seedInventoryFixture, type InventoryFixture,
} from './inventory-test-support.js'

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { consumeRecipeIngredients } = await import('./kitchen.js')
const { parseWastageInput, recordWastageCore } = await import('./inventory.js')
const { loadInventoryCostSummary } = await import('../lib/inventory-cost-contract.js')

const { startUtc, endUtc } = COST_CONTRACT_EXAMPLE_PERIOD

function waste(f: InventoryFixture, body: Record<string, unknown>) {
  const input = parseWastageInput({ operation_id: randomUUID(), ...body })
  return inTransaction(f.database, client => recordWastageCore({ client, approvalPool: client }, f.store, f.ingredient, input, { kind: 'web', userId: f.owner }))
}

function assertMatchesExample(summary: ReturnType<typeof summarizeInventoryCost>) {
  const expected = COST_CONTRACT_EXAMPLE_EXPECTED
  assert.deepEqual(
    [summary.consumption.knownCents, summary.consumption.estimatedCents, summary.consumption.totalCents, summary.consumption.movementCount, summary.consumption.estimatedMovementCount, summary.consumption.unknownMovementCount],
    [expected.consumption.knownCents, expected.consumption.estimatedCents, expected.consumption.totalCents, expected.consumption.movementCount, expected.consumption.estimatedMovementCount, expected.consumption.unknownMovementCount])
  assert.deepEqual([summary.wastage.knownCents, summary.wastage.estimatedCents, summary.wastage.totalCents, summary.wastage.movementCount, summary.wastage.includedInConsumption.totalCents, summary.wastage.incrementalCostCents],
    [expected.wastage.knownCents, expected.wastage.estimatedCents, expected.wastage.totalCents, expected.wastage.movementCount, expected.wastage.includedInConsumptionCents, expected.wastage.incrementalCostCents])
  assert.equal(summary.completeness.status, expected.completenessStatus)
  assert.equal(summary.consumption.totalCents + summary.wastage.incrementalCostCents, expected.totalInventoryOutflowCents)
  assert.deepEqual([summary.variance.theoreticalUsageCostCents, summary.variance.recordedWastageCostCents, summary.variance.knownAdjustments.movementCount],
    [expected.variance.theoreticalUsageCostCents, expected.variance.recordedWastageCostCents, expected.variance.adjustmentMovementCount])
}

test('the pure fixture produces the documented example', () => {
  assertMatchesExample(summarizeInventoryCost({ ...COST_CONTRACT_EXAMPLE_PERIOD, groups: COST_CONTRACT_EXAMPLE_GROUPS }))
})

test('real rows produce exactly the documented example through the SQL view and the contract loader', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedCostContractScenario(database, { consume: consumeRecipeIngredients, waste })
    const summary = await loadInventoryCostSummary(clientFor(database), f.store, startUtc, endUtc)
    assertMatchesExample(summary)
    assert.equal(summary.valuation.method, 'batch_pick_order')
    assert.equal(summary.valuation.effectiveFrom, '2026-10-02T08:00:00.000Z', 'first allocation snapshot recorded for this store')
    assert.deepEqual(summary.wastage.byCategory.map(row => [row.label, row.amounts.totalCents]), [['spoiled', 240], ['returned_order', 100]])
    assert.deepEqual(JSON.parse(JSON.stringify(summary.period)), { startUtc, endUtc, endExclusive: true })
  } finally { await database.close() }
})

test('period bounds are [start, end), another store is invisible, and an empty period is no_data', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedCostContractScenario(database, { consume: consumeRecipeIngredients, waste })
    const client = clientFor(database)
    const before = await loadInventoryCostSummary(client, f.store, '2026-10-01T00:00:00.000Z', startUtc)
    assert.equal(before.completeness.status, 'no_data')
    assert.equal(before.valuation.effectiveFrom, '2026-10-02T08:00:00.000Z', 'effectiveFrom is a property of the store, not of the period asked about')
    // A movement exactly at `end` belongs to the next period; exactly at `start` to this one.
    await database.query(`insert into public.stock_movements(store_id,ingredient_id,delta,reason,created_at) values ($1,$2,-1,'consumption',$3)`, [f.store, f.ingredient, endUtc])
    await database.query(`insert into public.stock_movements(store_id,ingredient_id,delta,reason,created_at) values ($1,$2,-1,'consumption',$3)`, [f.store, f.ingredient, startUtc])
    const inPeriod = await loadInventoryCostSummary(client, f.store, startUtc, endUtc)
    assert.equal(inPeriod.consumption.movementCount, COST_CONTRACT_EXAMPLE_EXPECTED.consumption.movementCount + 1)
    const otherStore = await loadInventoryCostSummary(client, f.otherStore, startUtc, endUtc)
    assert.equal(otherStore.completeness.status, 'no_data')
    assert.equal(otherStore.valuation.effectiveFrom, null)
  } finally { await database.close() }
})

test('price edits after the fact never change a re-run of the same period', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedCostContractScenario(database, { consume: consumeRecipeIngredients, waste })
    const client = clientFor(database)
    const before = await loadInventoryCostSummary(client, f.store, startUtc, endUtc)
    await database.query('update public.ingredients set cost_per_unit_cents = 5000 where store_id=$1', [f.store])
    await assert.rejects(database.query('update public.ingredient_batches set cost_per_unit_cents = 7000 where store_id=$1', [f.store]), /cannot be changed/)
    assert.deepEqual(await loadInventoryCostSummary(client, f.store, startUtc, endUtc), before, 'allocation snapshots and legacy batch derivation are price-edit-proof')
  } finally { await database.close() }
})

test('migration is additive: movements recorded before it keep their note, batch and null category, and are labelled honestly', async () => {
  const beforeChain = INVENTORY_MIGRATION_CHAIN.slice(0, -1)
  const database = await seededInventoryDatabase(beforeChain)
  try {
    const f = await seedInventoryFixture(database, { stock: 20, ingredientCostCents: 999 })
    const batch = await addBatch(database, f, f.ingredient, { quantity: 20, costCents: 40 })
    const legacyWithBatch = randomUUID(), legacyNoBatch = randomUUID(), legacyConsumption = randomUUID()
    await database.query(`insert into public.stock_movements(id,store_id,ingredient_id,batch_id,delta,reason,note,created_at) values ($1,$2,$3,$4,-2,'wastage','Spoilage: fridge off','2026-09-30T10:00:00Z')`, [legacyWithBatch, f.store, f.ingredient, batch])
    await database.query(`insert into public.stock_movements(id,store_id,ingredient_id,delta,reason,note,created_at) values ($1,$2,$3,-1,'wastage','Staff Meal','2026-09-30T11:00:00Z')`, [legacyNoBatch, f.store, f.ingredient])
    await database.query(`insert into public.stock_movements(id,store_id,ingredient_id,batch_id,delta,reason,created_at) values ($1,$2,$3,$4,-3,'consumption','2026-09-30T12:00:00Z')`, [legacyConsumption, f.store, f.ingredient, batch])
    const snapshot = async () => (await database.query(`select id, store_id, ingredient_id, batch_id, delta::text, reason, note, created_at from public.stock_movements order by id`)).rows

    const before = await snapshot()
    await database.exec((await readFile(repoRoot + 'supabase/migrations/202610020001_wastage_categories_batch_valuation.sql', 'utf8')).replace('create extension if not exists pgcrypto;', ''))
    assert.deepEqual(await snapshot(), before, 'no historical row was rewritten')
    const columns = await database.query<{ wastage_category: string | null; stock_effect: string | null; operation_id: string | null }>('select wastage_category, stock_effect, operation_id from public.stock_movements')
    assert.ok(columns.rows.every(row => row.wastage_category === null && row.stock_effect === null && row.operation_id === null))
    assert.equal((await database.query('select 1 from public.stock_movement_allocations')).rows.length, 0, 'nothing was backfilled')

    const summary = await loadInventoryCostSummary(clientFor(database), f.store, '2026-09-30T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    assert.equal(summary.valuation.effectiveFrom, null, 'no allocation snapshots exist yet')
    assert.equal(summary.consumption.knownCents, 120, '3 kg x the 40c batch it already recorded, not today\'s 999c')
    assert.equal(summary.wastage.knownCents, 80, '2 kg x its recorded 40c batch')
    assert.equal(summary.wastage.unknownMovementCount, 1, 'the staff-meal row had no batch: counted, not priced at 999c')
    assert.equal(summary.wastage.byCategory[0].label, 'uncategorised')
    assert.equal(summary.completeness.status, 'incomplete')
    // The structured-wastage rule is enforced for NEW rows only.
    await assert.rejects(database.query(`insert into public.stock_movements(store_id,ingredient_id,delta,reason) values ($1,$2,-1,'wastage')`, [f.store, f.ingredient]), /new_wastage_structured/)
  } finally { await database.close() }
})

test('policy rows and allocations are tenant-composite and RLS-protected like the rest of inventory', async () => {
  const database = await seededInventoryDatabase()
  try {
    const f = await seedInventoryFixture(database, { stock: 5 })
    const tables = await database.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname in ('stock_movement_allocations','inventory_policies')`)
    assert.ok(tables.rows.length === 2 && tables.rows.every(row => row.relrowsecurity))
    const policies = await database.query<{ tablename: string; cmd: string }>(
      `select tablename, cmd from pg_policies where tablename in ('stock_movement_allocations','inventory_policies')`)
    assert.deepEqual(policies.rows.map(row => [row.tablename, row.cmd]).sort(), [['inventory_policies', 'SELECT'], ['stock_movement_allocations', 'SELECT']])
    const grants = await database.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants where grantee='authenticated' and table_name in ('stock_movement_allocations','inventory_policies','stock_movement_cost_lines')`)
    assert.ok(grants.rows.every(row => row.privilege_type === 'SELECT'), 'the migration itself grants read only (live Supabase adds default privileges to every table; RLS is the real gate)')
    assert.equal(grants.rows.length, 3)
    await assert.rejects(database.query(`insert into public.inventory_policies(store_id,wastage_approval_threshold_cents) values ($1,-1)`, [f.store]), /violates check constraint/)
    void addKitchenItem
  } finally { await database.close() }
})
