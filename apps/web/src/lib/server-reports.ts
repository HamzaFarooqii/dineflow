import { requireSupabase } from './supabase'

export class ServerReportError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

// Mirrors terminal-auth/api.ts's request() (Supabase session -> Authorization: Bearer -> fetch),
// but lives in lib/ since reports aren't a terminal-auth concern and always require a manager/owner session.
async function request<T>(path: string): Promise<T> {
  const { data } = await requireSupabase().auth.getSession()
  const session = data.session
  if (!session) throw new Error('Sign in with your owner or manager email account.')
  const response = await fetch(`/api${path}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ code: 'server_unavailable', message: 'Reporting service unavailable.' })) as { code: string; message: string }
    throw new ServerReportError(response.status, error.code, error.message)
  }
  return await response.json() as T
}

export interface ServerDailySummary {
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
  refundedCount: number
  refundedAmountCents: number
}

export function fetchDailySummary(storeId: string, date: string): Promise<ServerDailySummary> {
  return request<ServerDailySummary>(`/reports/daily-summary?store_id=${encodeURIComponent(storeId)}&date=${encodeURIComponent(date)}`)
}

export interface ServerOrderSummary {
  id: string
  receiptNumber: string
  time: string
  totalCents: number
  paymentMethod: 'cash' | 'card' | 'unknown'
  itemCount: number
  syncStatus: 'synced'
  employeeId: string | null
  cashierName: string | null
  refunded: boolean
}
export interface ServerOrdersPage { orders: ServerOrderSummary[]; next_cursor: string | null }

export function fetchOrdersPage(storeId: string, date: string, cursor?: string | null, limit?: number): Promise<ServerOrdersPage> {
  const params = new URLSearchParams({ store_id: storeId, date })
  if (cursor) params.set('cursor', cursor)
  if (limit) params.set('limit', String(limit))
  return request<ServerOrdersPage>(`/reports/orders?${params.toString()}`)
}

export interface ServerOversoldProduct {
  id: string
  name: string
  sku: string
  current_stock: number
}

// Server truth for oversell: reflects pos_stock across every device that has synced, unlike the
// local low-stock calculation in reporting.ts which only reflects this browser's synced stock.
export async function fetchOversold(storeId: string): Promise<ServerOversoldProduct[]> {
  const result = await request<{ products: ServerOversoldProduct[] }>(`/reports/oversold?store_id=${encodeURIComponent(storeId)}`)
  return result.products
}
