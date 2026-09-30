// Client for QR table ordering (apps/api/src/routes/qr-ordering.ts). Two audiences, deliberately
// separate: the anonymous customer (bearer = short-lived table session, never a staff credential)
// and staff/manager (existing owner-bearer or terminal-cookie auth, same as open-checks).
import { accessToken, configuredApiUrl } from './catalog'

export type QrMode = 'menu_only' | 'menu_and_order' | 'waiter_only'
export const QR_MODE_LABELS: Record<QrMode, string> = {
  menu_only: 'Menu only', menu_and_order: 'Menu and ordering', waiter_only: 'Waiter only',
}

export class QrApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message) }
  get sessionEnded() { return this.status === 401 }
}

export interface QrSessionIssued {
  session_token: string; expires_at: string; store_name: string; currency: string
  table_label: string; mode: QrMode; requires_confirmation: boolean
}
export interface QrModifierOption { id: string; name: string; price_delta_cents: number }
export interface QrModifierGroup { id: string; name: string; selection: 'single' | 'multi'; required: boolean; options: QrModifierOption[] }
export interface QrMenuProduct { id: string; name: string; category_id: string | null; price_cents: number; image_url: string | null; modifier_groups: QrModifierGroup[] }
export interface QrMenu {
  table_label: string; mode: QrMode; requires_confirmation: boolean; expires_at: string; ordering_available: boolean
  categories: { id: string; name: string }[]; products: QrMenuProduct[]
}
export interface QrOrderLineInput { product_id: string; quantity: number; modifier_option_ids: string[] }
export interface QrCustomerOrder {
  id: string; status: 'awaiting_confirmation' | 'added_to_check' | 'declined'; created_at: string; decided_at: string | null
  note: string | null; items: { name: string; quantity: number; modifiers: string[]; total_cents: number }[]
  subtotal_cents: number; tax_cents: number
}

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { message?: string; code?: string }
  if (!response.ok) throw new QrApiError(body.message ?? `Request failed (${response.status}).`, response.status, body.code ?? 'error')
  return body
}

async function customerRequest<T>(path: string, method: string, token: string | null, body?: unknown): Promise<T> {
  const response = await fetch(`${configuredApiUrl()}/public/qr${path}`, {
    method, credentials: 'omit',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  return parse<T>(response)
}

export const openQrSession = (code: string) => customerRequest<QrSessionIssued>('/sessions', 'POST', null, { code })
export const fetchQrMenu = (token: string) => customerRequest<QrMenu>('/menu', 'GET', token)
export const fetchQrOrders = async (token: string) => (await customerRequest<{ orders: QrCustomerOrder[] }>('/orders', 'GET', token)).orders
export const submitQrOrder = (token: string, operationId: string, items: QrOrderLineInput[], note: string | null) =>
  customerRequest<{ replayed: boolean; submission: QrCustomerOrder }>('/orders', 'POST', token, {
    operation_id: operationId, items: items.map(item => ({ ...item, modifier_option_ids: item.modifier_option_ids.length ? item.modifier_option_ids : undefined })), ...(note ? { note } : {}),
  })

export interface QrTableState {
  id: string; label: string; status: string; qr_enabled: boolean; qr_mode: QrMode
  qr_require_confirmation: boolean; qr_generation: number; qr_rotated_at: string | null
}
export interface QrStaffSubmission {
  id: string; table_id: string; table_label: string; table_status: string; status: 'pending' | 'confirmed' | 'rejected'
  note: string | null; auto_confirmed: boolean; created_at: string; decided_at: string | null; check_id: string | null
  items: { name?: string; snapshot_name?: string; quantity: number; modifiers?: unknown[] }[]; subtotal_cents: number; tax_cents: number
}

async function staffRequest<T>(path: string, method: string, storeId: string, terminal: boolean, body?: unknown): Promise<T> {
  const [routePath, existing] = path.split('?')
  const query = new URLSearchParams(existing)
  query.set('store_id', storeId)
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/qr' : '/qr'}${routePath}?${query}`, {
    method, credentials: terminal ? 'include' : 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  return parse<T>(response)
}

export const fetchQrTables = async (storeId: string) => (await staffRequest<{ tables: QrTableState[] }>('/tables', 'GET', storeId, false)).tables
export const rotateQrCode = (storeId: string, tableId: string) => staffRequest<{ id: string; label: string; code: string }>(`/tables/${tableId}/code`, 'POST', storeId, false, {})
export const revokeQrCode = (storeId: string, tableId: string) => staffRequest<{ status: 'revoked' }>(`/tables/${tableId}/code`, 'DELETE', storeId, false)
export const updateQrSettings = (storeId: string, tableId: string, settings: { mode?: QrMode; require_confirmation?: boolean }) =>
  staffRequest<QrTableState>(`/tables/${tableId}/settings`, 'PATCH', storeId, false, settings)
export const fetchQrSubmissions = async (storeId: string, terminal: boolean, status: 'pending' | 'confirmed' | 'rejected' = 'pending') =>
  (await staffRequest<{ submissions: QrStaffSubmission[] }>(`/submissions?status=${status}`, 'GET', storeId, terminal)).submissions
export const confirmQrSubmission = (storeId: string, id: string, terminal: boolean) => staffRequest<{ status: 'confirmed'; check_id: string }>(`/submissions/${id}/confirm`, 'POST', storeId, terminal, {})
export const rejectQrSubmission = (storeId: string, id: string, terminal: boolean) => staffRequest<{ status: 'rejected' }>(`/submissions/${id}/reject`, 'POST', storeId, terminal, {})

export function orderUrl(code: string): string { return `${window.location.origin}/order/${code}` }
