import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDiscountedLine, calculateLine, parseCents } from '../../../../packages/domain/src/money.js'

// Import the validator after setting a harmless pool URL; these tests never open a connection.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { validateOperation } = await import('./orders.js')

const orderId = '37c68bc9-d138-4b6f-9f2f-1521e68e7e56'
const storeId = '90ca1d78-8027-4db8-8247-f4d8794b2680'
const productId = 'ff439cac-818c-43cc-924e-62f5cc049322'
const managerId = '11111111-1111-4111-8111-111111111111'
const line = calculateDiscountedLine(199, 2, 500)
function validOperation() {
  return { operation_id: orderId,
    order: { id: orderId, store_id: storeId, receipt_number: 'LOCAL-TEST-000001', catalog_version: 1,
      client_generated_at: '2026-09-15T09:00:00.000Z', subtotal_cents: line.subtotalCents, discount_cents: 0,
      tax_cents: line.taxCents, total_cents: line.totalCents, employee_id: null, manager_id: null, manager_approved_at: null },
    items: [{ id: 'e5ae5b38-d2d6-453f-bb99-c552b2c69ebf', product_id: productId,
      snapshot_name: 'Test item', snapshot_sku: 'TEST-001', snapshot_price_cents: 199,
      snapshot_tax_bps: 500, catalog_version: 1, quantity: 2, discount_kind: null, discount_value: null,
      subtotal_cents: line.subtotalCents, discount_applied_cents: line.discountAppliedCents,
      taxable_cents: line.taxableCents, tax_cents: line.taxCents, total_cents: line.totalCents }],
    payment: { id: '954cb8ba-4a42-4692-a014-de59c102a741', method: 'cash',
      amount_cents: line.totalCents, tendered_cents: 500, change_cents: 500 - line.totalCents,
      reference: null } }
}

test('money rounds half a cent up and parses tender as integer cents', () => {
  assert.equal(calculateLine(10, 1, 500).taxCents, 1)
  assert.equal(parseCents('5.00'), 500)
  assert.throws(() => parseCents('5.001'))
})
test('accepts a balanced immutable sale snapshot', () => {
  const result = validateOperation(validOperation())
  assert.equal(result.totals.totalCents, line.totalCents)
  assert.equal(result.operationId, orderId)
})
test('rejects changed line totals and cash tender mismatch', () => {
  const changed = validOperation()
  changed.items[0].tax_cents += 1
  assert.throws(() => validateOperation(changed), /totals do not match/)
  const tender = validOperation()
  tender.payment.change_cents = 0
  assert.throws(() => validateOperation(tender), /Payment does not balance/)
})
test('threads a valid employee_id through and rejects a malformed one', () => {
  const withEmployee = validOperation()
  withEmployee.order.employee_id = managerId
  const result = validateOperation(withEmployee)
  assert.equal(result.order.employee_id, managerId)
  const malformed = validOperation()
  malformed.order.employee_id = 'not-a-uuid'
  assert.throws(() => validateOperation(malformed), /Employee ID must be a UUID/)
})
test('rejects cross-operation identity and fractional money', () => {
  const changed = validOperation()
  changed.order.id = 'e5ae5b38-d2d6-453f-bb99-c552b2c69ebf'
  assert.throws(() => validateOperation(changed), /must match operation ID/)
  const fractional = validOperation()
  fractional.payment.amount_cents = 123.5
  assert.throws(() => validateOperation(fractional), /integer cents/)
})

test('rejects repeated line IDs and invalid sale timestamps before database work', () => {
  const repeated = validOperation()
  repeated.items.push({ ...repeated.items[0] })
  repeated.order.subtotal_cents *= 2
  repeated.order.tax_cents *= 2
  repeated.order.total_cents *= 2
  repeated.payment.amount_cents *= 2
  repeated.payment.tendered_cents = repeated.payment.amount_cents
  repeated.payment.change_cents = 0
  assert.throws(() => validateOperation(repeated), /Item IDs must be unique/)
  const invalidTime = validOperation()
  invalidTime.order.client_generated_at = '2026-02-30T09:00:00.000Z'
  assert.throws(() => validateOperation(invalidTime), /valid UTC timestamp/)
})

test('accepts a cashier-level discount (20% or less) without manager evidence', () => {
  const discounted = calculateDiscountedLine(199, 2, 500, { kind: 'percent', bps: 1_000 })
  const operation = validOperation()
  operation.order.subtotal_cents = discounted.subtotalCents
  operation.order.discount_cents = discounted.discountAppliedCents
  operation.order.tax_cents = discounted.taxCents
  operation.order.total_cents = discounted.totalCents
  operation.items[0].discount_kind = 'percent'
  operation.items[0].discount_value = 1_000
  operation.items[0].subtotal_cents = discounted.subtotalCents
  operation.items[0].discount_applied_cents = discounted.discountAppliedCents
  operation.items[0].taxable_cents = discounted.taxableCents
  operation.items[0].tax_cents = discounted.taxCents
  operation.items[0].total_cents = discounted.totalCents
  operation.payment.amount_cents = discounted.totalCents
  operation.payment.tendered_cents = discounted.totalCents
  operation.payment.change_cents = 0
  const result = validateOperation(operation)
  assert.equal(result.totals.discountCents, discounted.discountAppliedCents)
  assert.equal(result.order.manager_id, null)
})

test('rejects a discount above cashier authority without manager evidence, accepts it with evidence', () => {
  const discounted = calculateDiscountedLine(199, 2, 500, { kind: 'percent', bps: 2_500 })
  const operation = validOperation()
  operation.order.subtotal_cents = discounted.subtotalCents
  operation.order.discount_cents = discounted.discountAppliedCents
  operation.order.tax_cents = discounted.taxCents
  operation.order.total_cents = discounted.totalCents
  operation.items[0].discount_kind = 'percent'
  operation.items[0].discount_value = 2_500
  operation.items[0].subtotal_cents = discounted.subtotalCents
  operation.items[0].discount_applied_cents = discounted.discountAppliedCents
  operation.items[0].taxable_cents = discounted.taxableCents
  operation.items[0].tax_cents = discounted.taxCents
  operation.items[0].total_cents = discounted.totalCents
  operation.payment.amount_cents = discounted.totalCents
  operation.payment.tendered_cents = discounted.totalCents
  operation.payment.change_cents = 0
  assert.throws(() => validateOperation(operation), /requires manager approval/)
  operation.order.manager_id = managerId
  operation.order.manager_approved_at = '2026-09-17T10:00:00.000Z'
  const result = validateOperation(operation)
  assert.equal(result.order.manager_id, managerId)
  assert.equal(result.order.manager_approved_at, '2026-09-17T10:00:00.000Z')
})

test('rejects mismatched discount-derived totals and incomplete manager evidence', () => {
  const tampered = validOperation()
  tampered.items[0].discount_kind = 'fixed'
  tampered.items[0].discount_value = 50
  // subtotal/taxable/tax/total left unchanged from the undiscounted fixture — must not match.
  assert.throws(() => validateOperation(tampered), /totals do not match/)
  const partialEvidence = validOperation()
  partialEvidence.order.manager_id = managerId
  assert.throws(() => validateOperation(partialEvidence), /evidence is incomplete/)
})
