import test from 'node:test'
import assert from 'node:assert/strict'
import {
  allowedStockEffects, defaultStockEffect, isWastageCategory, WASTAGE_CATEGORIES, WASTAGE_CATEGORY_LABELS,
  wastageRequiresVerifiedApproval,
} from './wastage-category.ts'

test('every category has a label and the eleven required categories exist', () => {
  assert.equal(WASTAGE_CATEGORIES.length, 11)
  for (const category of WASTAGE_CATEGORIES) assert.ok(WASTAGE_CATEGORY_LABELS[category])
  for (const required of ['spoiled', 'expired', 'damaged', 'prep_waste', 'overproduction', 'staff_meal', 'complimentary', 'incorrect_order', 'returned_order', 'discrepancy', 'other']) {
    assert.ok(isWastageCategory(required), required)
  }
  assert.equal(isWastageCategory('Spoilage'), false)
})

test('returned dishes never deduct stock again; incorrect orders must say which; the rest always deduct', () => {
  assert.deepEqual(allowedStockEffects('returned_order'), ['already_consumed'])
  assert.equal(defaultStockEffect('returned_order'), 'already_consumed')
  assert.deepEqual(allowedStockEffects('incorrect_order'), ['deduct', 'already_consumed'])
  for (const category of WASTAGE_CATEGORIES.filter(item => item !== 'returned_order' && item !== 'incorrect_order')) {
    assert.deepEqual(allowedStockEffects(category), ['deduct'], category)
  }
})

test('approval threshold boundary: strictly below passes, equal or above needs a verified approval', () => {
  const threshold = 5000
  assert.equal(wastageRequiresVerifiedApproval(4_999_999_999n, threshold), false, '4999.999999 cents')
  assert.equal(wastageRequiresVerifiedApproval(5_000_000_000n, threshold), true, 'exactly the threshold')
  assert.equal(wastageRequiresVerifiedApproval(5_000_000_001n, threshold), true)
  assert.equal(wastageRequiresVerifiedApproval(0n, 0), true, 'threshold 0 gates every entry')
  assert.throws(() => wastageRequiresVerifiedApproval(1n, -1))
  assert.throws(() => wastageRequiresVerifiedApproval(1n, 1.5))
})
