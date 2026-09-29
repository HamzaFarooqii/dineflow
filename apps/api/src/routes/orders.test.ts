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
      tax_cents: line.taxCents, service_charge_bps: 0, service_charge_cents: 0, total_cents: line.totalCents,
      employee_id: null, manager_id: null, manager_approved_at: null },
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
test('includes modifier deltas in the unit price before all line math', () => {
  const operation = validOperation() as any
  const modifiedLine = calculateDiscountedLine(449, 2, 500)
  operation.items[0].base_price_cents = 199
  operation.items[0].snapshot_price_cents = 449
  operation.items[0].modifiers = [
    { option_id: '22222222-2222-4222-8222-222222222222', group_name: 'Size', option_name: 'Large', price_delta_cents: 200 },
    { option_id: '33333333-3333-4333-8333-333333333333', group_name: 'Add-ons', option_name: 'Extra syrup', price_delta_cents: 50 },
  ]
  Object.assign(operation.items[0], { subtotal_cents: modifiedLine.subtotalCents, discount_applied_cents: 0,
    taxable_cents: modifiedLine.taxableCents, tax_cents: modifiedLine.taxCents, total_cents: modifiedLine.totalCents })
  Object.assign(operation.order, { subtotal_cents: modifiedLine.subtotalCents, discount_cents: 0,
    tax_cents: modifiedLine.taxCents, total_cents: modifiedLine.totalCents })
  Object.assign(operation.payment, { amount_cents: modifiedLine.totalCents, tendered_cents: modifiedLine.totalCents, change_cents: 0 })
  const result = validateOperation(operation)
  assert.equal(result.items[0].snapshot_price_cents, 449)
  assert.equal(result.items[0].modifiers.length, 2)
  operation.items[0].modifiers[1].price_delta_cents = 40
  assert.throws(() => validateOperation(operation), /modifier prices do not match/)
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

test('defaults order_type to dine_in for a payload with none, so an outbox sale queued before this field existed still syncs', () => {
  const result = validateOperation(validOperation())
  assert.equal(result.order.order_type, 'dine_in')
  assert.equal(result.order.table_id, null)
})
test('threads a valid order_type/table_id through and rejects an invalid order_type', () => {
  const tableId = '22222222-2222-4222-8222-222222222222'
  const withTable = validOperation()
  withTable.order.order_type = 'dine_in'
  withTable.order.table_id = tableId
  const result = validateOperation(withTable)
  assert.equal(result.order.order_type, 'dine_in')
  assert.equal(result.order.table_id, tableId)
  const takeaway = validOperation()
  takeaway.order.order_type = 'takeaway'
  assert.equal(validateOperation(takeaway).order.order_type, 'takeaway')
  const invalid = validOperation()
  invalid.order.order_type = 'dine-in'
  assert.throws(() => validateOperation(invalid), /Order type is invalid/)
})
test('rejects a table_id on a non-dine-in order', () => {
  const operation = validOperation()
  operation.order.order_type = 'takeaway'
  operation.order.table_id = '22222222-2222-4222-8222-222222222222'
  assert.throws(() => validateOperation(operation), /table can only be set for a dine-in order/)
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

// A2: split settlement -- multiple tenders, tips, backward compatibility with the singular
// `payment` field every existing caller (push(), checkout.ts) still sends unchanged.
test('a singular payment still produces exactly one tender in the parsed operation', () => {
  const result = validateOperation(validOperation())
  assert.equal(result.payments.length, 1)
  assert.equal(result.payments[0].amount_cents, line.totalCents)
  assert.equal(result.payments[0].tip_cents, 0, 'absent tip_cents defaults to zero, same as an older client')
})
test('a cash+card split accepts two tenders whose amounts sum to the order total, tips excluded from that sum', () => {
  const operation = validOperation() as Record<string, unknown>
  delete operation.payment
  const half = Math.floor(line.totalCents / 2)
  operation.payments = [
    { id: '11111111-1111-4111-8111-000000000001', method: 'cash', amount_cents: half, tendered_cents: half + 100 + 50, change_cents: 50, tip_cents: 100, reference: null },
    { id: '11111111-1111-4111-8111-000000000002', method: 'card', amount_cents: line.totalCents - half, tendered_cents: line.totalCents - half + 25, change_cents: 0, tip_cents: 25, reference: 'AUTH-1' },
  ]
  const result = validateOperation(operation)
  assert.equal(result.payments.length, 2)
  assert.equal(result.payments.reduce((sum, payment) => sum + payment.amount_cents, 0), line.totalCents)
  assert.equal(result.payments[1].tip_cents, 25)
  assert.equal(result.payments[1].reference, 'AUTH-1')
})
test('rejects tenders whose amounts do not sum to the order total', () => {
  const operation = validOperation() as Record<string, unknown>
  delete operation.payment
  operation.payments = [
    { id: '11111111-1111-4111-8111-000000000003', method: 'cash', amount_cents: line.totalCents - 1, tendered_cents: line.totalCents - 1, change_cents: 0, reference: null },
  ]
  assert.throws(() => validateOperation(operation), /total_mismatch|do not balance/)
})
test('rejects a cash tender whose tendered amount does not cover amount plus tip plus change', () => {
  const operation = validOperation() as Record<string, unknown>
  const payment = (operation.payment as Record<string, unknown>)
  payment.tip_cents = 100
  // tendered_cents is left as the fixture's pre-tip value -- no longer balances once a tip is added.
  assert.throws(() => validateOperation(operation), /does not balance/)
})
test('rejects sending both payment and payments together', () => {
  const operation = validOperation() as Record<string, unknown>
  operation.payments = [operation.payment]
  assert.throws(() => validateOperation(operation), /either payment or payments/)
})
test('rejects duplicate tender IDs within one sale', () => {
  const operation = validOperation() as Record<string, unknown>
  delete operation.payment
  const half = Math.floor(line.totalCents / 2)
  const sameId = '11111111-1111-4111-8111-000000000009'
  operation.payments = [
    { id: sameId, method: 'cash', amount_cents: half, tendered_cents: half, change_cents: 0, reference: null },
    { id: sameId, method: 'card', amount_cents: line.totalCents - half, tendered_cents: line.totalCents - half, change_cents: 0, reference: null },
  ]
  assert.throws(() => validateOperation(operation), /Tender IDs must be unique/)
})

test('refund input rejects repeated items and tenders before checking refundable balances', async () => {
  const { parseRefundItems, parseRefundTenders } = await import('./orders.js')
  const item = { order_item_id: '11111111-1111-4111-8111-000000000001', quantity: 1 }
  const tender = { payment_id: item.order_item_id, amount_cents: 100 }
  assert.throws(() => parseRefundItems([item, item]), /unique/)
  assert.throws(() => parseRefundTenders([tender, tender]), /unique/)
  assert.throws(() => parseRefundTenders([{ ...tender, amount_cents: 0 }]), /positive/)
  assert.deepEqual(parseRefundItems([item]), [item])
})
