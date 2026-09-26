import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDiscountedLine, calculateLine, calculateServiceCharge, discountNeedsManagerApproval, formatCents, parseCents, sumDiscountedLines, sumLines } from './money.ts'

test('rounds tax half up in integer cents', () => {
  assert.equal(calculateLine(10, 1, 500).taxCents, 1)
  assert.equal(calculateLine(199, 2, 500).taxCents, 20)
})
test('sums lines and rejects money overflow', () => {
  const totals = sumLines([calculateLine(1800, 2, 800), calculateLine(3200, 1, 0)])
  assert.deepEqual(totals, { subtotalCents: 6800, taxCents: 288, totalCents: 7088 })
  assert.throws(() => calculateLine(1_000_000_000, 2, 0))
})
test('parses only whole cents and formats currency', () => {
  assert.equal(parseCents('18.50'), 1850)
  assert.equal(formatCents(1850), '$18.50')
  assert.throws(() => parseCents('18.501'))
  assert.throws(() => parseCents('-1'))
})
test('discounted line matches the PRD worked example: 2x199 at 10% discount and 5% tax', () => {
  const line = calculateDiscountedLine(199, 2, 500, { kind: 'percent', bps: 1_000 })
  assert.deepEqual(line, { subtotalCents: 398, discountAppliedCents: 40, taxableCents: 358, taxCents: 18, totalCents: 376 })
})
test('fixed discount reduces the taxable amount before tax', () => {
  const line = calculateDiscountedLine(500, 1, 0, { kind: 'fixed', cents: 100 })
  assert.deepEqual(line, { subtotalCents: 500, discountAppliedCents: 100, taxableCents: 400, taxCents: 0, totalCents: 400 })
  assert.throws(() => calculateDiscountedLine(500, 1, 0, { kind: 'fixed', cents: 501 }))
})
test('a line with no discount matches the plain calculateLine result', () => {
  const line = calculateDiscountedLine(1800, 2, 800)
  assert.deepEqual(line, { subtotalCents: 3600, discountAppliedCents: 0, taxableCents: 3600, taxCents: 288, totalCents: 3888 })
})
test('sums discounted lines into order-level subtotal, discount, tax and total', () => {
  const totals = sumDiscountedLines([
    calculateDiscountedLine(199, 2, 500, { kind: 'percent', bps: 1_000 }),
    calculateDiscountedLine(3200, 1, 0),
  ])
  assert.deepEqual(totals, { subtotalCents: 3598, discountCents: 40, taxCents: 18, totalCents: 3576 })
})
test('20% discount is within cashier authority; anything above needs manager approval', () => {
  assert.equal(discountNeedsManagerApproval(1_000, 200), false)
  assert.equal(discountNeedsManagerApproval(1_000, 201), true)
  assert.equal(discountNeedsManagerApproval(1_000, 250), true)
  assert.equal(discountNeedsManagerApproval(1_000, 0), false)
})
test('calculateServiceCharge rounds half up in integer cents and is zero at a 0% rate', () => {
  assert.equal(calculateServiceCharge(10_000, 1_000), 1_000) // 10% of $100.00
  assert.equal(calculateServiceCharge(10, 500), 1) // 5% of 10¢ rounds 0.5 up to 1
  assert.equal(calculateServiceCharge(10_000, 0), 0)
  assert.throws(() => calculateServiceCharge(10_000, 10_001))
  assert.throws(() => calculateServiceCharge(-1, 1_000))
})