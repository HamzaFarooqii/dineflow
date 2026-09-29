import { posDb, type LocalCustomer, type LocalOrder, type LocalOrderItem, type LocalPayment } from '../lib/db'

// customer is null both when the order has no customer_id and when that customer isn't (or
// isn't yet) synced to this browser — the receipt shows "Guest not on file" either way rather
// than distinguishing the two, since neither is actionable from a receipt screen.
export interface SavedReceipt { order: LocalOrder; items: LocalOrderItem[]; payment: LocalPayment; payments?: LocalPayment[]; customer: LocalCustomer | null }

// One read-only transaction: never reconstruct a historical sale from the catalog.
export async function readReceipt(storeId: string, orderId: string): Promise<SavedReceipt | null> {
  return posDb.transaction('r', posDb.orders, posDb.order_items, posDb.payments, posDb.customers, async () => {
    const order = await posDb.orders.get(orderId)
    if (!order || order.store_id !== storeId) return null
    const items = await posDb.order_items.where('order_id').equals(orderId).toArray()
    const payments = await posDb.payments.where('order_id').equals(orderId).toArray()
    const payment = payments[0]
    if (!items.length || !payment) throw new Error('This saved receipt is incomplete. Keep the local data and ask a manager to review it. Do not charge again.')
    const customer = order.customer_id ? (await posDb.customers.get(order.customer_id)) ?? null : null
    return { order, items, payment, payments, customer }
  })
}

// Cross-device fallback (GET /orders/:id, apps/api/src/routes/orders.ts): a manager, or on a
// cashier terminal any unlocked terminal in the store, can view/reprint a check closed on a
// *different* device even though it was never local to this browser. Only used when the local
// Dexie read above comes back null -- this never overrides or duplicates the local-first read.
export async function fetchRemoteReceipt(storeId: string, orderId: string, terminal = false): Promise<SavedReceipt | null> {
  // Dynamic import, not a static one: this module's other exports (readReceipt, saleDate, saleDay)
  // are pure/local-Dexie-only and get pulled into plain-node test runs (tests/receipts.test.ts)
  // that never touch a browser and have no import.meta.env -- a static import of lib/catalog.ts
  // (which reads import.meta.env at module load, via lib/supabase.ts) would crash that run before
  // any test even executes, for a dependency only this one cross-device function actually needs.
  const { accessToken, configuredApiUrl } = await import('../lib/catalog')
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/orders' : '/orders'}/${orderId}?${query}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? {} : { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 404) return null
  const body = await response.json().catch(() => ({})) as {
    order?: Record<string, unknown>; items?: Record<string, unknown>[]
    payments?: Record<string, unknown>[]; payment?: Record<string, unknown> | null; customer?: { id: string; name: string; phone_normalized: string | null } | null; message?: string
  }
  if (!response.ok) throw new Error(body.message ?? `Check could not be loaded (${response.status}).`)
  const rawPayments = body.payments ?? (body.payment ? [body.payment] : [])
  if (!body.order || !rawPayments.length) throw new Error('This check is missing its saved payment record. Do not charge again.')
  const order = body.order as Record<string, unknown>
  const localOrder: LocalOrder = {
    id: order.id as string, store_id: order.store_id as string, receipt_number: order.receipt_number as string,
    subtotal_cents: order.subtotal_cents as number, discount_cents: order.discount_cents as number, tax_cents: order.tax_cents as number,
    service_charge_cents: order.service_charge_cents as number, total_cents: order.total_cents as number,
    catalog_version: order.catalog_version as number, client_generated_at: order.client_generated_at as string,
    sync_status: 'synced', currency: order.currency as string, store_name_snapshot: order.store_name_snapshot as string,
    timezone_snapshot: order.timezone_snapshot as string, accepted_checkpoint: null, failure_reason: null,
    customer_id: order.customer_id as string | null, employee_id: order.employee_id as string | null,
    manager_id: order.manager_id as string | null, manager_approved_at: order.manager_approved_at as string | null,
    order_type: order.order_type as LocalOrder['order_type'], table_id: order.table_id as string | null,
    refunded_at: order.refunded_at as string | null, refunded_amount_cents: order.refunded_amount_cents as number,
    refunded_tax_cents: order.refunded_tax_cents as number, refunded_merchandise_cents: order.refunded_merchandise_cents as number,
    refunded_tip_cents: order.refunded_tip_cents as number,
  }
  const items: LocalOrderItem[] = (body.items ?? []).map(item => ({
    id: item.id as string, order_id: localOrder.id, product_id: item.product_id as string,
    snapshot_name: item.snapshot_name as string, snapshot_sku: item.snapshot_sku as string,
    snapshot_price_cents: item.snapshot_price_cents as number, modifiers: item.modifiers as LocalOrderItem['modifiers'],
    snapshot_tax_bps: item.snapshot_tax_bps as number, catalog_version: item.catalog_version as number, quantity: item.quantity as number,
    subtotal_cents: item.subtotal_cents as number, discount_kind: item.discount_kind as LocalOrderItem['discount_kind'],
    discount_value: item.discount_value as number | null, discount_applied_cents: item.discount_applied_cents as number,
    taxable_cents: item.taxable_cents as number, tax_cents: item.tax_cents as number, total_cents: item.total_cents as number,
  }))
  const payments: LocalPayment[] = rawPayments.map(paymentRaw => ({ id: paymentRaw.id as string, order_id: localOrder.id, method: paymentRaw.method as LocalPayment['method'],
    amount_cents: paymentRaw.amount_cents as number, tendered_cents: paymentRaw.tendered_cents as number,
    change_cents: paymentRaw.change_cents as number, tip_cents: (paymentRaw.tip_cents as number) ?? 0,
    refunded_amount_cents: (paymentRaw.refunded_amount_cents as number) ?? 0, refunded_tip_cents: (paymentRaw.refunded_tip_cents as number) ?? 0, reference: paymentRaw.reference as string | null }))
  const customer: LocalCustomer | null = body.customer ? { id: body.customer.id, store_id: localOrder.store_id, name: body.customer.name,
    phone_normalized: body.customer.phone_normalized, client_generated_at: localOrder.client_generated_at, creating_operation_id: null,
    sync_status: 'synced', failure_reason: null } : null
  return { order: localOrder, items, payment: payments[0], payments, customer }
}

export function saleDate(order: LocalOrder): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: order.timezone_snapshot }).format(new Date(order.client_generated_at))
  } catch { return `${order.client_generated_at} (recorded date; timezone unavailable)` }
}

export function saleDay(order: LocalOrder): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: order.timezone_snapshot }).formatToParts(new Date(order.client_generated_at))
    const value = (type: string) => parts.find(part => part.type === type)?.value
    return `${value('year')}-${value('month')}-${value('day')}`
  } catch { return '' }
}

export const syncLabel = (order: LocalOrder) => order.sync_status === 'failed' ? 'Rejected / needs review' : order.sync_status === 'synced' ? 'Synced' : 'Pending sync'
