import { posDb, type LocalOrder, type LocalOrderItem, type LocalPayment } from '../lib/db'

export interface SavedReceipt { order: LocalOrder; items: LocalOrderItem[]; payment: LocalPayment }

// One read-only transaction: never reconstruct a historical sale from the catalog.
export async function readReceipt(storeId: string, orderId: string): Promise<SavedReceipt | null> {
  return posDb.transaction('r', posDb.orders, posDb.order_items, posDb.payments, async () => {
    const order = await posDb.orders.get(orderId)
    if (!order || order.store_id !== storeId) return null
    const items = await posDb.order_items.where('order_id').equals(orderId).toArray()
    const payment = await posDb.payments.where('order_id').equals(orderId).first()
    if (!items.length || !payment) throw new Error('This saved receipt is incomplete. Keep the local data and ask a manager to review it. Do not charge again.')
    return { order, items, payment }
  })
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
