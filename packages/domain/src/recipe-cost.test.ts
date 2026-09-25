import test from 'node:test'
import assert from 'node:assert/strict'
import { convertQuantity, costRecipe, foodCostBps, formatFoodCostPercent, type RecipeCostUnit } from './recipe-cost.ts'

const kg: RecipeCostUnit = { id: 'unit-kg', kind: 'mass', factorToBase: 1_000 }
const g: RecipeCostUnit = { id: 'unit-g', kind: 'mass', factorToBase: 1 }
const mystery: RecipeCostUnit = { id: 'unit-mystery-mass', kind: 'mass', factorToBase: null }
const each: RecipeCostUnit = { id: 'unit-each', kind: 'count', factorToBase: null }
const box: RecipeCostUnit = { id: 'unit-box', kind: 'count', factorToBase: null }

test('sums quantity × cost per unit and divides by yield for the per-sale cost', () => {
  const cost = costRecipe([
    { quantity: 0.25, unit: kg, ingredient: { unit: kg, costPerUnitCents: 1_200 } }, // 300
    { quantity: 2, unit: each, ingredient: { unit: each, costPerUnitCents: 45 } }, // 90
  ], 2)
  assert.deepEqual(cost.lines, [{ status: 'costed', costCents: 300 }, { status: 'costed', costCents: 90 }])
  assert.equal(cost.batchCostCents, 390)
  assert.equal(cost.portionCostCents, 195)
  assert.equal(cost.complete, true)
})

test('rounds once on the exact total, not per line', () => {
  // Three lines of 0.5¢ each: per-line rounding would give 3¢ (or 0¢); the exact total is 1.5¢ → 2¢.
  const line = { quantity: 0.5, unit: g, ingredient: { unit: g, costPerUnitCents: 1 } }
  assert.equal(costRecipe([line, line, line], 1).batchCostCents, 2)
})

test('a line in grams costs correctly against an ingredient stocked in kilograms', () => {
  // 250 g of an ingredient priced at 1200¢/kg = 0.25kg × 1200¢ = 300¢.
  const cost = costRecipe([{ quantity: 250, unit: g, ingredient: { unit: kg, costPerUnitCents: 1_200 } }], 1)
  assert.deepEqual(cost.lines[0], { status: 'costed', costCents: 300 })
  assert.equal(cost.complete, true)
})

test('two same-kind units with no known conversion factor are flagged, not guessed at', () => {
  const cost = costRecipe([
    { quantity: 250, unit: mystery, ingredient: { unit: kg, costPerUnitCents: 1_200 } },
    { quantity: 3, unit: box, ingredient: { unit: each, costPerUnitCents: 100 } },
  ], 1)
  assert.deepEqual(cost.lines[0], { status: 'unit_mismatch' })
  assert.deepEqual(cost.lines[1], { status: 'unit_mismatch' })
  assert.equal(cost.complete, false)
})

test('two different kinds never convert even if factors happen to be set', () => {
  const volumeWithFactor: RecipeCostUnit = { id: 'unit-ml', kind: 'volume', factorToBase: 1 }
  assert.equal(convertQuantity(1, kg, volumeWithFactor), null)
})

test('the identical unit always costs directly, even with no factor set on it', () => {
  const cost = costRecipe([{ quantity: 3, unit: each, ingredient: { unit: each, costPerUnitCents: 45 } }], 1)
  assert.deepEqual(cost.lines[0], { status: 'costed', costCents: 135 })
})

test('a line with an unknown ingredient is flagged and costs nothing', () => {
  const cost = costRecipe([{ quantity: 1, unit: each, ingredient: null }], 1)
  assert.deepEqual(cost.lines, [{ status: 'missing_ingredient' }])
  assert.equal(cost.portionCostCents, 0)
  assert.equal(cost.complete, false)
})

test('an empty recipe costs zero and is complete', () => {
  assert.deepEqual(costRecipe([], 1), { lines: [], batchCostCents: 0, portionCostCents: 0, complete: true })
})

test('rejects non-positive yields/quantities and non-integer costs', () => {
  assert.throws(() => costRecipe([], 0), /yield/)
  assert.throws(() => costRecipe([{ quantity: -1, unit: kg, ingredient: null }], 1), /quantity/)
  assert.throws(() => costRecipe([{ quantity: 1, unit: kg, ingredient: { unit: kg, costPerUnitCents: 1.5 } }], 1), /cents/)
})

test('food cost % is portion cost ÷ menu price in basis points, undefined for a free item', () => {
  assert.equal(foodCostBps(195, 650), 3000)
  assert.equal(foodCostBps(0, 650), 0)
  assert.equal(foodCostBps(100, 0), null)
  assert.equal(formatFoodCostPercent(2840), '28.4%')
  assert.equal(formatFoodCostPercent(null), '—')
})
