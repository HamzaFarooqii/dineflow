import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateComboPriceCents, validateComboSelection } from './combo.ts'

test('validateComboSelection accepts a selection within every group\'s min/max bounds', () => {
  const groups = [{ id: 'side', minSelect: 1, maxSelect: 1 }, { id: 'extra', minSelect: 0, maxSelect: 2 }]
  const selected = new Map([['side', 1], ['extra', 2]])
  assert.deepEqual(validateComboSelection(groups, selected), [])
})
test('validateComboSelection rejects a required group with nothing selected', () => {
  const groups = [{ id: 'side', minSelect: 1, maxSelect: 1 }]
  assert.deepEqual(validateComboSelection(groups, new Map()), ['Choose at least 1 option.'])
})
test('validateComboSelection rejects a group over its max', () => {
  const groups = [{ id: 'side', minSelect: 1, maxSelect: 1 }]
  const selected = new Map([['side', 2]])
  assert.deepEqual(validateComboSelection(groups, selected), ['Choose at most 1 option.'])
})
test('validateComboSelection allows an optional group (minSelect 0) to stay empty', () => {
  const groups = [{ id: 'extra', minSelect: 0, maxSelect: 2 }]
  assert.deepEqual(validateComboSelection(groups, new Map()), [])
})
test('validateComboSelection reports one error per violated group, not just the first', () => {
  const groups = [{ id: 'side', minSelect: 1, maxSelect: 1 }, { id: 'drink', minSelect: 1, maxSelect: 1 }]
  assert.equal(validateComboSelection(groups, new Map()).length, 2)
})

test('calculateComboPriceCents in fixed mode is the base price plus every selected upsell delta', () => {
  const price = calculateComboPriceCents('fixed', 999, [{ priceDeltaCents: 0, componentUnitPriceCents: 250 }, { priceDeltaCents: 150, componentUnitPriceCents: 300 }])
  assert.equal(price, 999 + 150) // component prices are ignored entirely in fixed mode
})
test('calculateComboPriceCents in fixed mode with no upsells is exactly the base price', () => {
  assert.equal(calculateComboPriceCents('fixed', 999, []), 999)
})
test('calculateComboPriceCents in derived mode sums each component\'s own price plus its delta, ignoring the base price', () => {
  const price = calculateComboPriceCents('derived', 999, [{ priceDeltaCents: 0, componentUnitPriceCents: 250 }, { priceDeltaCents: 150, componentUnitPriceCents: 300 }])
  assert.equal(price, 250 + 300 + 150)
})
test('calculateComboPriceCents rejects a negative or out-of-range base price', () => {
  assert.throws(() => calculateComboPriceCents('fixed', -1, []), /Combo base price/)
  assert.throws(() => calculateComboPriceCents('fixed', 2_000_000_000, []), /Combo base price/)
})
