import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalOrder, LocalOrderItem, LocalPayment, OutboxEntry } from '../src/lib/db'
import { calculateLocalSalesReport, calculateCashierShift, calendarDay } from '../src/lib/reporting'

const order = (overrides: Partial<LocalOrder> & Pick<LocalOrder, 'id' | 'store_id' | 'client_generated_at'>): LocalOrder => ({
  receipt_number: `R-${overrides.id}`, subtotal_cents: 1000, tax_cents: 100, total_cents: 1100,
  catalog_version: 1, sync_status: 'synced', currency: 'USD', store_name_snapshot: 'Store',
  timezone_snapshot: 'Asia/Karachi', accepted_checkpoint: null, failure_reason: null, ...overrides,
})
const item = (orderId: string, quantity: number): LocalOrderItem => ({ id: `item-${orderId}`, order_id: orderId,
  product_id: 'product', snapshot_name: 'Item', snapshot_sku: 'SKU', snapshot_price_cents: 1000,
  snapshot_tax_bps: 1000, catalog_version: 1, quantity, subtotal_cents: 1000, tax_cents: 100, total_cents: 1100 })
const payment = (orderId: string, method: 'cash' | 'card', amount: number, tendered = amount, change = 0): LocalPayment => ({
  id: `payment-${orderId}`, order_id: orderId, method, amount_cents: amount, tendered_cents: tendered, change_cents: change, reference: null,
})
const outbox = (orderId: string, storeId: string, failureKind: OutboxEntry['failure_kind'] = null): OutboxEntry => ({
  store_id: storeId, operation_id: `op-${orderId}`, order_id: orderId, status: failureKind === 'validation' ? 'failed' : 'pending',
  failure_reason: null, failure_kind: failureKind, reason_code: null, attempt_count: 0, lease_owner: null,
  lease_expires_at: null, accepted_checkpoint: null, next_attempt_at: new Date(0).toISOString(), created_at: new Date(0).toISOString(), payload: '{}',
})

test('uses the saved store timezone for calendar-day boundaries', () => {
  assert.equal(calendarDay('2026-09-15T18:59:59.000Z', 'Asia/Karachi'), '2026-09-15')
  assert.equal(calendarDay('2026-09-15T19:00:00.000Z', 'Asia/Karachi'), '2026-09-16')
})

test('reconciles local sales, excludes cash change, and keeps unresolved sales in totals', () => {
  const orders = [
    order({ id: 'cash', store_id: 'store-a', client_generated_at: '2026-09-15T19:30:00.000Z', subtotal_cents: 1000, discount_cents: 100, tax_cents: 90, total_cents: 990, sync_status: 'pending' }),
    order({ id: 'card', store_id: 'store-a', client_generated_at: '2026-09-16T10:00:00.000Z', subtotal_cents: 2000, tax_cents: 200, total_cents: 2200, sync_status: 'failed' }),
    order({ id: 'other-store', store_id: 'store-b', client_generated_at: '2026-09-16T10:00:00.000Z' }),
  ]
  const report = calculateLocalSalesReport('store-a', '2026-09-16', 'Asia/Karachi', {
    orders, items: [item('cash', 2), item('card', 3), item('other-store', 50)],
    payments: [payment('cash', 'cash', 990, 1500, 510), payment('card', 'card', 2200), payment('other-store', 'cash', 1100)],
    outbox: [outbox('cash', 'store-a'), outbox('card', 'store-a', 'validation')],
  })
  assert.deepEqual(report, {
    grossSalesCents: 3000, discountCents: 100, netSalesCents: 2900, taxCents: 290,
    cashTakingsCents: 990, cardTakingsCents: 2200, recordedTotalCents: 3190,
    completedOrderCount: 2, averageSaleCents: 1595, itemsSold: 5,
    pendingCount: 1, pendingAmountCents: 990, rejectedCount: 1, rejectedAmountCents: 2200,
    refundedCount: 0, refundedAmountCents: 0,
  })
})

test('a refunded sale remains in gross activity while reducing net totals and takings', () => {
  const orders = [
    order({ id: 'kept', store_id: 'store-a', client_generated_at: '2026-09-16T10:00:00.000Z', subtotal_cents: 1000, tax_cents: 100, total_cents: 1100 }),
    order({ id: 'refunded', store_id: 'store-a', client_generated_at: '2026-09-16T11:00:00.000Z', subtotal_cents: 2000, tax_cents: 200, total_cents: 2200,
      refunded_at: '2026-09-16T12:00:00.000Z', refunded_amount_cents: 2200 }),
  ]
  const report = calculateLocalSalesReport('store-a', '2026-09-16', 'Asia/Karachi', {
    orders, items: [item('kept', 1), item('refunded', 3)],
    payments: [payment('kept', 'cash', 1100), payment('refunded', 'card', 2200)],
    outbox: [],
  })
  assert.equal(report.completedOrderCount, 2)
  assert.equal(report.recordedTotalCents, 1100)
  assert.equal(report.grossSalesCents, 3000)
  assert.equal(report.netSalesCents, 1000)
  assert.equal(report.taxCents, 100)
  assert.equal(report.cardTakingsCents, 0)
  assert.equal(report.itemsSold, 4, 'gross units preserve the original sale')
  assert.equal(report.averageSaleCents, 1650)
  assert.equal(report.refundedCount, 1)
  assert.equal(report.refundedAmountCents, 2200)
  const shift = calculateCashierShift(orders, [payment('kept', 'cash', 1100), payment('refunded', 'card', 2200)], 'store-a', '2026-09-16', 'Asia/Karachi')
  assert.equal(shift.orderCount, 2)
  assert.equal(shift.salesCents, 1100)
  assert.equal(shift.cardCents, 0)
  const nextDay = calculateLocalSalesReport('store-a', '2026-09-17', 'Asia/Karachi', {
    orders: orders.map(row => row.id === 'refunded' ? { ...row, refunded_at: '2026-09-17T12:00:00.000Z' } : row),
    items: [item('kept', 1), item('refunded', 3)],
    payments: [payment('kept', 'cash', 1100), payment('refunded', 'card', 2200)], outbox: [],
  })
  assert.equal(nextDay.grossSalesCents, 0)
  assert.equal(nextDay.recordedTotalCents, -2200)
  assert.equal(nextDay.cardTakingsCents, -2200)
  assert.equal(nextDay.refundedCount, 1)
})

test('returns integer zero values for a day without orders and treats old discounts as zero', () => {
  const empty = calculateLocalSalesReport('store-a', '2026-09-17', 'UTC', { orders: [], items: [], payments: [], outbox: [] })
  assert.equal(empty.averageSaleCents, 0)
  assert.equal(empty.completedOrderCount, 0)
  const legacy = calculateLocalSalesReport('store-a', '2026-09-16', 'UTC', {
    orders: [order({ id: 'legacy', store_id: 'store-a', client_generated_at: '2026-09-16T23:59:00.000Z' })], items: [], payments: [], outbox: [],
  })
  assert.equal(legacy.discountCents, 0)
  assert.equal(legacy.netSalesCents, 1000)
})
