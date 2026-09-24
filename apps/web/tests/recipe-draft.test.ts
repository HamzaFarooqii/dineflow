import test from 'node:test'
import assert from 'node:assert/strict'
import { costDraft, draftFromRecipe, isDraftBlank, newDraftLine, validateDraft, type RecipeDraft, type RecipeIngredientOption } from '../src/screens/menu/recipe-draft'

const kg = 'unit-kg', each = 'unit-each', portion = 'unit-portion'
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
  const result = validateDraft(draft, ingredients)
  assert.ok(result.ok)
  assert.deepEqual(result.payload, {
    yield_quantity: 4,
    yield_unit_id: portion,
    lines: [{ ingredient_id: 'rice', quantity: 0.5, unit_id: kg }, { ingredient_id: 'egg', quantity: 2, unit_id: each }],
  })
})

test('validation flags yield, duplicates, bad quantities and unit mismatches per line', () => {
  const dupA = line('rice', '1', kg), dupB = line('rice', '1', kg), badQty = line('egg', '0', each), wrongUnit = line('rice', '1', each)
  const result = validateDraft({ yieldQuantity: '0', yieldUnitId: '', lines: [dupA, dupB] }, ingredients)
  assert.ok(!result.ok)
  assert.match(result.errors.yieldQuantity ?? '', /greater than 0/)
  assert.match(result.errors.yieldUnitId ?? '', /yield unit/)
  assert.equal(result.errors.lines?.[dupA.key], undefined)
  assert.match(result.errors.lines?.[dupB.key] ?? '', /already on the recipe/)

  const second = validateDraft({ yieldQuantity: '1', yieldUnitId: portion, lines: [badQty, wrongUnit] }, ingredients)
  assert.ok(!second.ok)
  assert.match(second.errors.lines?.[badQty.key] ?? '', /quantity/)
  assert.match(second.errors.lines?.[wrongUnit.key] ?? '', /own unit/)
})

test('costDraft costs complete lines live and skips ones still being typed', () => {
  const rice = line('rice', '0.5', kg), typing = line('egg', '', each)
  const cost = costDraft({ yieldQuantity: '2', yieldUnitId: portion, lines: [rice, typing] }, ingredients)
  assert.equal(cost.batchCostCents, 200)
  assert.equal(cost.portionCostCents, 100)
  assert.deepEqual(cost.lineCosts[rice.key], { status: 'costed', costCents: 200 })
  assert.equal(cost.lineCosts[typing.key], undefined)
})
