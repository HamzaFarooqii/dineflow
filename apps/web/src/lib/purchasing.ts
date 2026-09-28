import { authenticatedFetch, configuredApiUrl } from './catalog'

// Owner/manager-only surface -- there is no terminal/cashier variant of purchasing (unlike
// inventory.ts), so every call goes through the authenticated Supabase session, same convention
// as customers.ts/promotions.ts use for their owner-facing screens.

export interface Vendor {
  id: string
  store_id: string
  name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  terms: string
  active: boolean
  created_at: string
  updated_at: string
}

export interface PurchaseOrderLine {
  id: string
  store_id: string
  purchase_order_id: string
  ingredient_id: string
  ingredient_name: string | null
  ordered_quantity: string
  received_quantity: string
  unit_cost_cents: number
  reference: string | null
  created_at: string
}

export interface PurchaseReceipt {
  id: string
  store_id: string
  purchase_order_id: string
  operation_id: string
  invoice_reference: string | null
  received_at: string
  manager_approved: boolean
  manager_approval_reason: string | null
  created_at: string
}

export type PurchaseOrderStatus = 'draft' | 'sent' | 'partially_received' | 'received' | 'cancelled'

export interface PurchaseOrder {
  id: string
  store_id: string
  vendor_id: string
  vendor_name: string | null
  status: PurchaseOrderStatus
  reference: string | null
  notes: string
  sent_at: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
  line_count: number
  ordered_total_cents: string
  received_total_cents: string
}

export interface PurchaseOrderDetail {
  purchase_order: PurchaseOrder
  lines: PurchaseOrderLine[]
  receipts: PurchaseReceipt[]
}

export interface PurchasingReport {
  vendors: { active: string; inactive: string }
  vendor_spend: { vendor_id: string; vendor_name: string; spend_cents: string }[]
  cost_variance: { ingredient_id: string; ingredient_name: string; variance_cents: string }[]
}

async function purchasingRequest<T>(path: string, method: string, storeId: string, body?: Record<string, unknown>): Promise<T> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await authenticatedFetch(`${configuredApiUrl()}/purchasing${path}?${query}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as T & { message?: string }
  if (!response.ok) throw new Error(parsed.message ?? `Request failed (${response.status}).`)
  return parsed
}

export async function fetchVendors(storeId: string, includeInactive = false): Promise<Vendor[]> {
  const query = new URLSearchParams({ store_id: storeId })
  if (includeInactive) query.set('include_inactive', 'true')
  const response = await authenticatedFetch(`${configuredApiUrl()}/purchasing/vendors?${query}`, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { vendors?: Vendor[]; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Vendors could not be loaded (${response.status}).`)
  return body.vendors ?? []
}

export function createVendor(storeId: string, input: { name: string; contact_name?: string | null; email?: string | null; phone?: string | null; terms?: string | null }): Promise<Vendor> {
  return purchasingRequest<Vendor>('/vendors', 'POST', storeId, input)
}

export function updateVendor(storeId: string, vendorId: string, patch: Partial<{ name: string; contact_name: string | null; email: string | null; phone: string | null; terms: string | null; active: boolean }>): Promise<Vendor> {
  return purchasingRequest<Vendor>(`/vendors/${vendorId}`, 'PATCH', storeId, patch)
}

export async function fetchPurchaseOrders(storeId: string): Promise<PurchaseOrder[]> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await authenticatedFetch(`${configuredApiUrl()}/purchasing/purchase-orders?${query}`, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { purchase_orders?: PurchaseOrder[]; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Purchase orders could not be loaded (${response.status}).`)
  return body.purchase_orders ?? []
}

export async function fetchPurchaseOrder(storeId: string, poId: string): Promise<PurchaseOrderDetail> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await authenticatedFetch(`${configuredApiUrl()}/purchasing/purchase-orders/${poId}?${query}`, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as Partial<PurchaseOrderDetail> & { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Purchase order could not be loaded (${response.status}).`)
  return body as PurchaseOrderDetail
}

export function createPurchaseOrder(storeId: string, input: { vendor_id: string; reference?: string | null; notes?: string | null; lines: { ingredient_id: string; ordered_quantity: number; unit_cost_cents: number; reference?: string | null }[] }): Promise<PurchaseOrderDetail> {
  return purchasingRequest<PurchaseOrderDetail>('/purchase-orders', 'POST', storeId, input)
}

export function sendPurchaseOrder(storeId: string, poId: string): Promise<PurchaseOrderDetail> {
  return purchasingRequest<PurchaseOrderDetail>(`/purchase-orders/${poId}/send`, 'POST', storeId)
}

export function cancelPurchaseOrder(storeId: string, poId: string): Promise<PurchaseOrderDetail> {
  return purchasingRequest<PurchaseOrderDetail>(`/purchase-orders/${poId}/cancel`, 'POST', storeId)
}

export interface ReceivePurchaseOrderInput {
  operation_id: string
  invoice_reference?: string | null
  received_at?: string | null
  manager_approved?: boolean
  manager_approval_reason?: string | null
  update_ingredient_costs?: boolean
  lines: { purchase_order_line_id: string; received_quantity: number; unit_cost_cents?: number }[]
}

export function receivePurchaseOrder(storeId: string, poId: string, input: ReceivePurchaseOrderInput): Promise<PurchaseOrderDetail & { receipt_id: string; replayed: boolean }> {
  return purchasingRequest(`/purchase-orders/${poId}/receive`, 'POST', storeId, input as unknown as Record<string, unknown>)
}

export async function fetchPurchasingReport(storeId: string): Promise<PurchasingReport> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await authenticatedFetch(`${configuredApiUrl()}/purchasing/report?${query}`, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as Partial<PurchasingReport> & { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Purchasing report could not be loaded (${response.status}).`)
  return { vendors: body.vendors ?? { active: '0', inactive: '0' }, vendor_spend: body.vendor_spend ?? [], cost_variance: body.cost_variance ?? [] }
}
