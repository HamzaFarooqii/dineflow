import test from 'node:test'
import assert from 'node:assert/strict'
import { costDraft, draftFromRecipe, isDraftBlank, newDraftLine, validateDraft, type RecipeDraft, type RecipeIngredientOption, type RecipeUnit } from '../src/screens/menu/recipe-draft'

const kg = 'unit-kg', gram = 'unit-g', each = 'unit-each', portion = 'unit-portion'
const units: RecipeUnit[] = [
  { id: kg, name: 'Kilogram', abbreviation: 'kg', kind: 'mass', factor_to_base: 1_000 },
  { id: gram, name: 'Gram', abbreviation: 'g', kind: 'mass', factor_to_base: 1 },
  { id: each, name: 'Each', abbreviation: 'ea', kind: 'count', factor_to_base: null },
  { id: portion, name: 'Portion', abbreviation: 'ptn', kind: 'count', factor_to_base: null },
]
const ingredients: RecipeIngredientOption[] = [
  { id: 'rice', name: 'Rice', unit_id: kg, cost_per_unit_cents: 400, active: true },
  { id: 'egg', name: 'Egg', unit_id: each, cost_per_unit_cents: 30, active: true },
]
const line = (ingredientId: string, quantity: string, unitId: string) => ({ ...newDraftLine(), ingredientId, quantity, unitId })

test('an untouched recipe section is blank and skipped; choosing a yield unit starts one', () => {
  assert.equal(isDraftBlank(draftFromRecipe(undefined)), true)
  assert.equal(isDraftBlank({ ...draftFromRecipe(undefined), yieldUnitId: portion }), false)
})

test('a valid draft becomes the PUT body with numeric quantities', () => {
  const draft: RecipeDraft = { yieldQuantity: '4', yieldUnitId: portion, lines: [line('rice', '0.5', kg), line('egg', '2', each)] }
  const result = validateDraft(draft, ingredients, units)
  assert.ok(result.ok)
  assert.deepEqual(result.payload, {
    yield_quantity: 4,
    yield_unit_id: portion,
    lines: [{ ingredient_id: 'rice', quantity: 0.5, unit_id: kg }, { ingredient_id: 'egg', quantity: 2, unit_id: each }],
  })
})

test('a line in a convertible unit (same kind, both have a factor) also becomes a valid PUT body', () => {
  const draft: RecipeDraft = { yieldQuantity: '4', yieldUnitId: portion, lines: [line('rice', '500', gram)] }
  const result = validateDraft(draft, ingredients, units)
  assert.ok(result.ok)
  assert.deepEqual(result.payload.lines, [{ ingredient_id: 'rice', quantity: 500, unit_id: gram }])
})

test('validation flags yield, duplicates, bad quantities and unconvertible units per line', () => {
  const dupA = line('rice', '1', kg), dupB = line('rice', '1', kg), badQty = line('egg', '0', each), wrongUnit = line('rice', '1', each)
  const result = validateDraft({ yieldQuantity: '0', yieldUnitId: '', lines: [dupA, dupB] }, ingredients, units)
  assert.ok(!result.ok)
  assert.match(result.errors.yieldQuantity ?? '', /greater than 0/)
  assert.match(result.errors.yieldUnitId ?? '', /yield unit/)
  assert.equal(result.errors.lines?.[dupA.key], undefined)
  assert.match(result.errors.lines?.[dupB.key] ?? '', /already on the recipe/)

  const second = validateDraft({ yieldQuantity: '1', yieldUnitId: portion, lines: [badQty, wrongUnit] }, ingredients, units)
  assert.ok(!second.ok)
  assert.match(second.errors.lines?.[badQty.key] ?? '', /quantity/)
  assert.match(second.errors.lines?.[wrongUnit.key] ?? '', /no known conversion/)
})

test('costDraft costs complete lines live and skips ones still being typed', () => {
  const rice = line('rice', '0.5', kg), typing = line('egg', '', each)
  const cost = costDraft({ yieldQuantity: '2', yieldUnitId: portion, lines: [rice, typing] }, ingredients, units)
  assert.equal(cost.batchCostCents, 200)
  assert.equal(cost.portionCostCents, 100)
  assert.deepEqual(cost.lineCosts[rice.key], { status: 'costed', costCents: 200 })
  assert.equal(cost.lineCosts[typing.key], undefined)
})

test('costDraft converts a gram line against a kilogram-stocked ingredient', () => {
  const riceInGrams = line('rice', '500', gram)
  const cost = costDraft({ yieldQuantity: '1', yieldUnitId: portion, lines: [riceInGrams] }, ingredients, units)
  // 500g == 0.5kg, at 400¢/kg == 200¢, same as the kg-native test above.
  assert.deepEqual(cost.lineCosts[riceInGrams.key], { status: 'costed', costCents: 200 })
})
