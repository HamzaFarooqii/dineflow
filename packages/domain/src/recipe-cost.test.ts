import test from 'node:test'
import assert from 'node:assert/strict'
import { costRecipe, foodCostBps, formatFoodCostPercent } from './recipe-cost.ts'

const kg = 'unit-kg', g = 'unit-g', each = 'unit-each'

test('sums quantity × cost per unit and divides by yield for the per-sale cost', () => {
  const cost = costRecipe([
    { quantity: 0.25, unitId: kg, ingredient: { unitId: kg, costPerUnitCents: 1_200 } }, // 300
    { quantity: 2, unitId: each, ingredient: { unitId: each, costPerUnitCents: 45 } }, // 90
  ], 2)
  assert.deepEqual(cost.lines, [{ status: 'costed', costCents: 300 }, { status: 'costed', costCents: 90 }])
  assert.equal(cost.batchCostCents, 390)
  assert.equal(cost.portionCostCents, 195)
  assert.equal(cost.complete, true)
})

test('rounds once on the exact total, not per line', () => {
  // Three lines of 0.5¢ each: per-line rounding would give 3¢ (or 0¢); the exact total is 1.5¢ → 2¢.
  const line = { quantity: 0.5, unitId: g, ingredient: { unitId: g, costPerUnitCents: 1 } }
  assert.equal(costRecipe([line, line, line], 1).batchCostCents, 2)
})

test('a line whose unit differs from the ingredient unit is flagged, not converted', () => {
  const cost = costRecipe([
    { quantity: 250, unitId: g, ingredient: { unitId: kg, costPerUnitCents: 1_200 } },
    { quantity: 1, unitId: each, ingredient: { unitId: each, costPerUnitCents: 100 } },
  ], 1)
  assert.deepEqual(cost.lines[0], { status: 'unit_mismatch' })
  assert.equal(cost.batchCostCents, 100)
  assert.equal(cost.complete, false)
})

test('a line with an unknown ingredient is flagged and costs nothing', () => {
  const cost = costRecipe([{ quantity: 1, unitId: each, ingredient: null }], 1)
  assert.deepEqual(cost.lines, [{ status: 'missing_ingredient' }])
  assert.equal(cost.portionCostCents, 0)
  assert.equal(cost.complete, false)
})

test('an empty recipe costs zero and is complete', () => {
  assert.deepEqual(costRecipe([], 1), { lines: [], batchCostCents: 0, portionCostCents: 0, complete: true })
})

test('rejects non-positive yields/quantities and non-integer costs', () => {
  assert.throws(() => costRecipe([], 0), /yield/)
  assert.throws(() => costRecipe([{ quantity: -1, unitId: kg, ingredient: null }], 1), /quantity/)
  assert.throws(() => costRecipe([{ quantity: 1, unitId: kg, ingredient: { unitId: kg, costPerUnitCents: 1.5 } }], 1), /cents/)
})

test('food cost % is portion cost ÷ menu price in basis points, undefined for a free item', () => {
  assert.equal(foodCostBps(195, 650), 3000)
  assert.equal(foodCostBps(0, 650), 0)
  assert.equal(foodCostBps(100, 0), null)
  assert.equal(formatFoodCostPercent(2840), '28.4%')
  assert.equal(formatFoodCostPercent(null), '—')
})
