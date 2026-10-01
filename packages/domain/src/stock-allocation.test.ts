import test from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateAcrossSources, costMicroCents, microCentsToCents, microToString, singleCoveringBatchId, toMicro, totalCostMicroCents,
  type AllocationSource,
} from './stock-allocation.ts'

const batch = (id: string, remaining: string, unitCostCents: number): AllocationSource =>
  ({ sourceId: id, batchId: id, remainingMicro: toMicro(remaining), unitCostCents, basis: 'batch' })

test('toMicro and microToString round-trip fractional quantities without float noise', () => {
  assert.equal(toMicro('0.1') + toMicro('0.2'), toMicro('0.3'))
  assert.equal(toMicro(0.1 + 0.2), toMicro('0.3'), '0.30000000000000004 must not leak into stored quantities')
  assert.equal(microToString(toMicro('2.500')), '2.5')
  assert.equal(microToString(toMicro('3')), '3')
  assert.equal(microToString(toMicro('0.000001')), '0.000001')
  assert.equal(toMicro('0.0000005'), 1n, 'half rounds up at the sixth decimal')
  assert.equal(toMicro('0.0000004'), 0n)
  assert.equal(toMicro(1e-7), 0n, 'exponent-notation numbers are handled')
  assert.throws(() => toMicro('abc'))
  assert.throws(() => toMicro(Number.NaN))
})

test('a single batch that covers the quantity takes all of it and is recorded on the movement', () => {
  const plan = allocateAcrossSources([batch('A', '10', 50)], toMicro('3'), 70)
  assert.equal(plan.allocations.length, 1)
  assert.equal(plan.uncoveredMicro, 0n)
  assert.equal(singleCoveringBatchId(plan, toMicro('3')), 'A')
  assert.equal(microCentsToCents(totalCostMicroCents(plan.allocations)), 150)
})

test('a quantity spanning batches takes them in the order given and costs each at its own batch price', () => {
  const plan = allocateAcrossSources([batch('A', '4', 50), batch('B', '10', 80)], toMicro('6'), 99)
  assert.deepEqual(plan.allocations.map(a => [a.batchId, microToString(a.quantityMicro), a.unitCostCents]), [['A', '4', 50], ['B', '2', 80]])
  assert.equal(microCentsToCents(totalCostMicroCents(plan.allocations)), 4 * 50 + 2 * 80)
  assert.equal(singleCoveringBatchId(plan, toMicro('6')), null, 'spanning movements carry null batch_id; allocations hold the truth')
})

test('uncovered quantity is an explicit estimate at the ingredient cost, never attributed to a batch', () => {
  const plan = allocateAcrossSources([batch('A', '2', 50)], toMicro('5'), 70)
  assert.equal(plan.uncoveredMicro, toMicro('3'))
  const estimate = plan.allocations[1]
  assert.equal(estimate.batchId, null)
  assert.equal(estimate.basis, 'estimated_ingredient_cost')
  assert.equal(estimate.unitCostCents, 70)
  assert.equal(singleCoveringBatchId(plan, toMicro('5')), null)
})

test('with no estimate price the uncovered remainder is reported but not invented', () => {
  const plan = allocateAcrossSources([batch('A', '2', 50)], toMicro('5'), null)
  assert.equal(plan.allocations.length, 1)
  assert.equal(plan.uncoveredMicro, toMicro('3'))
})

test('depleted sources are skipped and the allocation is deterministic for equal input', () => {
  const sources = [batch('A', '0', 10), batch('B', '1', 20), batch('C', '1', 30)]
  const first = allocateAcrossSources(sources, toMicro('1.5'), 0)
  const second = allocateAcrossSources(sources, toMicro('1.5'), 0)
  assert.deepEqual(first, second)
  assert.deepEqual(first.allocations.map(a => a.batchId), ['B', 'C'])
})

test('fractional quantities cost exactly; whole cents are rounded once at the edge', () => {
  // 0.003 kg at 50c/kg = 0.15c -- per-movement rounding would call this 0 forever.
  const cost = costMicroCents(toMicro('0.003'), 50)
  assert.equal(cost, 150_000n)
  assert.equal(microCentsToCents(cost), 0)
  assert.equal(microCentsToCents(cost * 100n), 15, 'one hundred such movements are correctly worth 15 cents')
  assert.equal(microCentsToCents(500_000n), 1, 'half a cent rounds up')
})

test('zero or negative allocation is rejected', () => {
  assert.throws(() => allocateAcrossSources([batch('A', '1', 1)], 0n, 1))
})
