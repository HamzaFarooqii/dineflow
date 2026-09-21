import type { LocalOrder, LocalOrderItem, LocalPayment, OutboxEntry } from './db'

export interface LocalSalesReport {
  grossSalesCents: number
  discountCents: number
  netSalesCents: number
  taxCents: number
  cashTakingsCents: number
  cardTakingsCents: number
  recordedTotalCents: number
  completedOrderCount: number
  averageSaleCents: number
  itemsSold: number
  pendingCount: number
  pendingAmountCents: number
  rejectedCount: number
  rejectedAmountCents: number
  refundedCount: number
  refundedAmountCents: number
}

export interface ReportingData {
  orders: LocalOrder[]
  items: LocalOrderItem[]
  payments: LocalPayment[]
  outbox: OutboxEntry[]
}

const emptyReport = (): LocalSalesReport => ({
  grossSalesCents: 0, discountCents: 0, netSalesCents: 0, taxCents: 0,
  cashTakingsCents: 0, cardTakingsCents: 0, recordedTotalCents: 0,
  completedOrderCount: 0, averageSaleCents: 0, itemsSold: 0,
  pendingCount: 0, pendingAmountCents: 0, rejectedCount: 0, rejectedAmountCents: 0,
  refundedCount: 0, refundedAmountCents: 0,
})

export function calendarDay(instant: string, timezone: string): string {
  const date = new Date(instant)
  if (!Number.isFinite(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export function todayInTimezone(timezone: string, now = new Date()): string {
  return calendarDay(now.toISOString(), timezone)
}

export function calculateLocalSalesReport(storeId: string, day: string, timezone: string, data: ReportingData): LocalSalesReport {
  const report = emptyReport()
  const dayOrders = data.orders.filter(order => order.store_id === storeId && calendarDay(order.client_generated_at, timezone) === day)
  const refundsToday = data.orders.filter(order => order.store_id === storeId && order.refunded_at && calendarDay(order.refunded_at, timezone) === day)
  if (!dayOrders.length && !refundsToday.length) return report
  const orderIds = new Set(dayOrders.map(order => order.id))
  const outboxByOrder = new Map(data.outbox.filter(entry => entry.store_id === storeId && orderIds.has(entry.order_id)).map(entry => [entry.order_id, entry]))

  for (const order of dayOrders) {
    const discount = order.discount_cents ?? 0
    report.grossSalesCents += order.subtotal_cents
    report.discountCents += discount
    report.netSalesCents += order.subtotal_cents - discount
    report.taxCents += order.tax_cents
    report.recordedTotalCents += order.total_cents
    report.completedOrderCount += 1

    const outbox = outboxByOrder.get(order.id)
    const rejected = order.sync_status === 'failed' || outbox?.failure_kind === 'validation'
    if (rejected) {
      report.rejectedCount += 1
      report.rejectedAmountCents += order.total_cents
    } else if (order.sync_status !== 'synced') {
      report.pendingCount += 1
      report.pendingAmountCents += order.total_cents
    }
  }

  for (const item of data.items) if (orderIds.has(item.order_id)) report.itemsSold += item.quantity
  for (const payment of data.payments) {
    if (!orderIds.has(payment.order_id)) continue
    if (payment.method === 'cash') report.cashTakingsCents += payment.amount_cents
    if (payment.method === 'card') report.cardTakingsCents += payment.amount_cents
  }
  const paymentByOrder = new Map(data.payments.map(payment => [payment.order_id, payment]))
  for (const order of refundsToday) {
    const amount = order.refunded_amount_cents ?? order.total_cents
    report.refundedCount += 1
    report.refundedAmountCents += amount
    report.netSalesCents -= order.subtotal_cents - (order.discount_cents ?? 0)
    report.taxCents -= order.tax_cents
    report.recordedTotalCents -= amount
    const payment = paymentByOrder.get(order.id)
    if (payment?.method === 'cash') report.cashTakingsCents -= amount
    if (payment?.method === 'card') report.cardTakingsCents -= amount
  }
  const originalTotal = dayOrders.reduce((sum, order) => sum + order.total_cents, 0)
  report.averageSaleCents = report.completedOrderCount
    ? Math.floor((originalTotal + Math.floor(report.completedOrderCount / 2)) / report.completedOrderCount)
    : 0
  return report
}

export interface TopProduct {
  productId: string
  name: string
  quantity: number
  totalCents: number
}

export function calculateTopProducts(items: LocalOrderItem[], orders: LocalOrder[], storeId: string, day: string, timezone: string, limit = 4): TopProduct[] {
  const storeOrders = new Set(orders.filter(o => o.store_id === storeId && calendarDay(o.client_generated_at, timezone) === day).map(o => o.id))
  if (!storeOrders.size) return []
  const map = new Map<string, { name: string; quantity: number; totalCents: number }>()
  for (const item of items) {
    if (!storeOrders.has(item.order_id)) continue
    const existing = map.get(item.product_id) ?? { name: item.snapshot_name, quantity: 0, totalCents: 0 }
    existing.quantity += item.quantity
    existing.totalCents += item.total_cents
    map.set(item.product_id, existing)
  }
  return Array.from(map.entries())
    .map(([productId, data]) => ({ productId, ...data }))
    .sort((a, b) => b.quantity - a.quantity || b.totalCents - a.totalCents)
    .slice(0, limit)
}

export interface LowStockItem {
  productId: string
  name: string
  sku: string
  currentStock: number
}

export function calculateLowStockItems(
  products: { id: string; name: string; sku: string; active: boolean }[],
  stocks: { product_id: string; current_stock: number }[],
  adjustments: { product_id: string; delta: number }[],
  threshold = 5,
  limit = 5,
): LowStockItem[] {
  const stockMap = new Map<string, number>()
  for (const s of stocks) stockMap.set(s.product_id, s.current_stock)
  for (const a of adjustments) stockMap.set(a.product_id, (stockMap.get(a.product_id) ?? 0) + a.delta)

  const alerts: LowStockItem[] = []
  for (const p of products) {
    if (!p.active) continue
    const count = stockMap.get(p.id) ?? 0
    if (count <= threshold) {
      alerts.push({ productId: p.id, name: p.name, sku: p.sku, currentStock: count })
    }
  }
  return alerts.sort((a, b) => a.currentStock - b.currentStock).slice(0, limit)
}

export interface RecentOrderSummary {
  id: string
  receiptNumber: string
  time: string
  totalCents: number
  paymentMethod: 'cash' | 'card' | 'unknown'
  itemCount: number
  syncStatus: 'synced' | 'pending' | 'failed'
  refunded: boolean
}

export function getRecentOrders(orders: LocalOrder[], items: LocalOrderItem[], payments: LocalPayment[], storeId: string, limit = 5): RecentOrderSummary[] {
  const storeOrders = orders
    .filter(o => o.store_id === storeId)
    .sort((a, b) => Date.parse(b.client_generated_at) - Date.parse(a.client_generated_at))
    .slice(0, limit)

  const paymentMap = new Map<string, 'cash' | 'card'>(payments.map(p => [p.order_id, p.method]))
  const itemCountMap = new Map<string, number>()
  for (const it of items) itemCountMap.set(it.order_id, (itemCountMap.get(it.order_id) ?? 0) + it.quantity)

  return storeOrders.map(o => ({
    id: o.id,
    receiptNumber: o.receipt_number,
    time: o.client_generated_at,
    totalCents: o.total_cents,
    paymentMethod: paymentMap.get(o.id) ?? 'unknown',
    itemCount: itemCountMap.get(o.id) ?? 0,
    syncStatus: o.sync_status,
    refunded: Boolean(o.refunded_at),
  }))
}

export interface CashierShiftSummary {
  salesCents: number
  orderCount: number
  cashCents: number
  cardCents: number
  changeCents: number
}

export function calculateCashierShift(
  orders: LocalOrder[],
  payments: LocalPayment[],
  storeId: string,
  day: string,
  timezone: string,
): CashierShiftSummary {
  const todayOrders = orders.filter(o => o.store_id === storeId && calendarDay(o.client_generated_at, timezone) === day)
  const orderIds = new Set(todayOrders.map(o => o.id))
  const refundsToday = orders.filter(o => o.store_id === storeId && o.refunded_at && calendarDay(o.refunded_at, timezone) === day)
  let cashCents = 0
  let cardCents = 0
  let changeCents = 0
  for (const p of payments) {
    if (!orderIds.has(p.order_id)) continue
    if (p.method === 'cash') {
      cashCents += p.amount_cents
      changeCents += p.change_cents
    } else if (p.method === 'card') {
      cardCents += p.amount_cents
    }
  }
  const paymentByOrder = new Map(payments.map(payment => [payment.order_id, payment]))
  for (const order of refundsToday) {
    const amount = order.refunded_amount_cents ?? order.total_cents
    const payment = paymentByOrder.get(order.id)
    if (payment?.method === 'cash') cashCents -= amount
    if (payment?.method === 'card') cardCents -= amount
  }
  const salesCents = todayOrders.reduce((sum, o) => sum + o.total_cents, 0)
    - refundsToday.reduce((sum, o) => sum + (o.refunded_amount_cents ?? o.total_cents), 0)
  return {
    salesCents,
    orderCount: todayOrders.length,
    cashCents,
    cardCents,
    changeCents,
  }
}

