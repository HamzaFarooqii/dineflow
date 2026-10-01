import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeInventoryCost, type CostLineGroup } from './inventory-cost-summary.ts'

const period = { startUtc: '2026-10-01T00:00:00.000Z', endUtc: '2026-10-02T00:00:00.000Z', effectiveFrom: '2026-10-02T09:00:00.000Z' }
const group = (over: Partial<CostLineGroup>): CostLineGroup => ({
  reason: 'consumption', wastageCategory: null, stockEffect: null, movementCount: 1,
  knownCostCents: '0', estimatedCostCents: '0', estimatedMovementCount: 0, unknownMovementCount: 0, ...over,
})

test('an empty period reports no_data with explicit contract metadata', () => {
  const summary = summarizeInventoryCost({ ...period, groups: [] })
  assert.equal(summary.completeness.status, 'no_data')
  assert.equal(summary.consumption.totalCents, 0)
  assert.equal(summary.valuation.method, 'batch_pick_order')
  assert.equal(summary.timeBasis.field, 'stock_movements.created_at')
  assert.equal(summary.refundTreatment.consumption, 'not_reversed')
  assert.equal(summary.variance.actualVariance.available, false)
})

test('known and estimated are separated and the total is exactly their sum', () => {
  const summary = summarizeInventoryCost({ ...period, groups: [
    group({ movementCount: 3, knownCostCents: '1000.4', estimatedCostCents: '200.4', estimatedMovementCount: 1 }),
  ] })
  assert.equal(summary.consumption.knownCents, 1000)
  assert.equal(summary.consumption.estimatedCents, 200)
  assert.equal(summary.consumption.totalCents, 1200)
  assert.equal(summary.completeness.status, 'estimated')
  assert.equal(summary.completeness.knownShareBps, 8333)
})

test('unknown movements make completeness incomplete and are counted, not priced', () => {
  const summary = summarizeInventoryCost({ ...period, groups: [
    group({ movementCount: 2, knownCostCents: '500', unknownMovementCount: 1 }),
  ] })
  assert.equal(summary.completeness.status, 'incomplete')
  assert.equal(summary.consumption.unknownMovementCount, 1)
  assert.equal(summary.consumption.totalCents, 500)
})

test('returned-dish wastage is shown but excluded from the incremental amount so cost is not double counted', () => {
  const summary = summarizeInventoryCost({ ...period, groups: [
    group({ reason: 'consumption', knownCostCents: '1000' }),
    group({ reason: 'wastage', wastageCategory: 'spoiled', stockEffect: 'deduct', knownCostCents: '300' }),
    group({ reason: 'wastage', wastageCategory: 'returned_order', stockEffect: 'already_consumed', knownCostCents: '120' }),
  ] })
  assert.equal(summary.wastage.totalCents, 420)
  assert.equal(summary.wastage.includedInConsumption.totalCents, 120)
  assert.equal(summary.wastage.incrementalCostCents, 300)
  assert.equal(summary.consumption.totalCents + summary.wastage.incrementalCostCents, 1300, 'what the profitability layer should add up')
  assert.deepEqual(summary.wastage.byCategory.map(row => row.label), ['spoiled', 'returned_order'])
})

test('adjustments are counted but not valued and actual variance stays unavailable', () => {
  const summary = summarizeInventoryCost({ ...period, groups: [group({ reason: 'adjustment', movementCount: 4, unknownMovementCount: 4 })] })
  assert.equal(summary.variance.knownAdjustments.movementCount, 4)
  assert.equal(summary.variance.knownAdjustments.valued, false)
  assert.equal(summary.variance.actualVariance.available, false)
  assert.equal(summary.variance.theoreticalUsageCostCents, 0)
})
