import test from 'node:test'
import assert from 'node:assert/strict'
import { allocateEqualSplit, allocateWeightedSplit } from './split-settlement.ts'

test('weighted allocation stays exact when safe input products exceed Number precision', () => {
  const total = Number.MAX_SAFE_INTEGER
  assert.deepEqual(allocateWeightedSplit(total, [total, total, total]), [3002399751580331, 3002399751580330, 3002399751580330])
  assert.deepEqual(allocateWeightedSplit(total, [total, 0]), [total, 0])
})

test('allocateEqualSplit divides evenly when the total is a multiple of the count', () => {
  assert.deepEqual(allocateEqualSplit(3000, 3), [1000, 1000, 1000])
})
test('allocateEqualSplit distributes the remainder to the first guests, one cent each, and always sums exactly', () => {
  const shares = allocateEqualSplit(1000, 3) // 333, 333, 334 in some order summing to 1000
  assert.equal(shares.reduce((sum, share) => sum + share, 0), 1000)
  assert.deepEqual(shares, [334, 333, 333])
  assert.ok(shares.every(share => share === 333 || share === 334))
})
test('allocateEqualSplit is stable -- same inputs always produce the same allocation', () => {
  assert.deepEqual(allocateEqualSplit(1001, 4), allocateEqualSplit(1001, 4))
})
test('allocateEqualSplit rejects a negative total or an out-of-range count', () => {
  assert.throws(() => allocateEqualSplit(-1, 2), /non-negative/)
  assert.throws(() => allocateEqualSplit(1000, 0), /Guest count/)
  assert.throws(() => allocateEqualSplit(1000, 51), /Guest count/)
})
test('allocateEqualSplit of zero cents gives every guest zero', () => {
  assert.deepEqual(allocateEqualSplit(0, 3), [0, 0, 0])
})

test('allocateWeightedSplit divides proportionally to each weight and sums exactly to the total', () => {
  // Two seats, subtotals 3000 and 1000 (3:1 ratio) splitting a 4000-cent total after tax/discount.
  const shares = allocateWeightedSplit(4000, [3000, 1000])
  assert.deepEqual(shares, [3000, 1000])
  assert.equal(shares.reduce((sum, share) => sum + share, 0), 4000)
})
test('allocateWeightedSplit handles a total that does not divide evenly, still summing exactly', () => {
  const shares = allocateWeightedSplit(1000, [1, 1, 1]) // even weights, 1000/3 = 333.33 each
  assert.equal(shares.reduce((sum, share) => sum + share, 0), 1000)
  assert.ok(shares.every(share => share === 333 || share === 334))
})
test('allocateWeightedSplit gives a zero-weight seat exactly zero', () => {
  assert.deepEqual(allocateWeightedSplit(1000, [1000, 0]), [1000, 0])
})
test('allocateWeightedSplit rejects all-zero weights and negative/non-integer weights', () => {
  assert.throws(() => allocateWeightedSplit(1000, [0, 0]), /positive/)
  assert.throws(() => allocateWeightedSplit(1000, [-1, 100]), /non-negative integer/)
  assert.throws(() => allocateWeightedSplit(1000, [1.5, 100]), /non-negative integer/)
})
