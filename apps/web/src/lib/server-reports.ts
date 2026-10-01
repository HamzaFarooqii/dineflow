import { authenticatedFetch, configuredApiUrl } from './catalog'

export class ServerReportError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

// Mirrors terminal-auth/api.ts's request() (Supabase session -> Authorization: Bearer -> fetch),
// but lives in lib/ since reports aren't a terminal-auth concern and always require a manager/owner session.
async function request<T>(path: string): Promise<T> {
  const response = await authenticatedFetch(`${configuredApiUrl()}${path}`, {
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
  tipsCents?: number
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
  paymentMethod: 'cash' | 'card' | 'split' | 'unknown'
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

export interface CustomerReportRow {
  id: string
  name: string
  visitCount: number
  spendCents: number
  lastVisit: string
  pointsBalance: number
  lifetimePoints: number
  tierName: string | null
}
export interface CustomerReport {
  uniqueGuests: number
  returningGuests: number
  newGuests: number
  enrolledGuests: number
  visits: number
  guestRevenueCents: number
  pointsEarned: number
  pointsRedeemed: number
  topGuests: CustomerReportRow[]
}

export function fetchCustomerReport(storeId: string, from: string, to: string): Promise<CustomerReport> {
  const params = new URLSearchParams({ store_id: storeId, from, to })
  return request<CustomerReport>(`/reports/customers?${params.toString()}`)
}

export interface InventoryAlertRow { id: string; name: string; unit: string; currentStock: number; reorderThreshold: number | null }
export interface InventoryExpiryRow { id: string; ingredientName: string; remainingQuantity: number; unit: string; expiresAt: string }
export interface InventoryWastageRow { ingredientId: string; ingredientName: string; quantity: number; unit: string; valueCents: number }
export interface InventoryReport {
  lowStockCount: number
  outOfStockCount: number
  expiredBatchCount: number
  expiringBatchCount: number
  wastageQuantity: number
  wastageValueCents: number
  lowStock: InventoryAlertRow[]
  expiringBatches: InventoryExpiryRow[]
  topWastage: InventoryWastageRow[]
}

export function fetchInventoryReport(storeId: string, from: string, to: string): Promise<InventoryReport> {
  const params = new URLSearchParams({ store_id: storeId, from, to })
  return request<InventoryReport>(`/reports/inventory?${params.toString()}`)
}

export interface DishProfitabilityRow {
  productId: string; name: string; unitsSold: number; netRevenueCents: number; portionCostCents: number
  estimatedFoodCostCents: number; grossProfitCents: number; foodCostBps: number | null; recipeComplete: boolean
}
export interface FoodCostReport {
  netRevenueCents: number; estimatedFoodCostCents: number; grossProfitCents: number; foodCostBps: number | null
  incompleteRecipeCount: number; dishes: DishProfitabilityRow[]
}
export function fetchFoodCostReport(storeId: string, from: string, to: string): Promise<FoodCostReport> {
  const params = new URLSearchParams({ store_id: storeId, from, to })
  return request<FoodCostReport>(`/reports/food-cost?${params.toString()}`)
}

export interface ProfitabilityDay {
  date: string
  grossMerchandiseSalesCents: number
  discountCents: number
  merchandiseRefundsCents: number
  netMerchandiseRevenueCents: number
  estimatedCostOfGoodsCents: number
  costCoverageBps: number | null
  wastageValueCents: number
  grossProfitCents: number
  wastageAdjustedGrossProfitCents: number
  grossMarginBps: number | null
  taxCents: number
  tipsCents: number
  serviceChargeCents: number
}
export interface ProfitabilityReport {
  from: string; to: string
  costBasis: 'estimated_recipe' | 'actual_batch'
  actualCostAvailable: boolean
  totals: ProfitabilityDay
  days: ProfitabilityDay[]
}
export function fetchProfitabilityReport(storeId: string, from: string, to: string): Promise<ProfitabilityReport> {
  const params = new URLSearchParams({ store_id: storeId, from, to })
  return request<ProfitabilityReport>(`/reports/profitability?${params.toString()}`)
}

export interface KitchenStationPerformance {
  stationId: string | null; stationName: string; itemCount: number; completedCount: number; openCount: number
  averagePrepSeconds: number | null; averageServeSeconds: number | null
}
export interface KitchenPerformanceReport { totalItems: number; completedItems: number; averagePrepSeconds: number | null; stations: KitchenStationPerformance[] }
export function fetchKitchenPerformanceReport(storeId: string, from: string, to: string): Promise<KitchenPerformanceReport> {
  const params = new URLSearchParams({ store_id: storeId, from, to })
  return request<KitchenPerformanceReport>(`/reports/kitchen-performance?${params.toString()}`)
}

export interface ShiftRow {
  id: string
  employee_id: string
  employee_name: string
  employee_role: string
  device_id: string
  clocked_in_at: string
  clocked_out_at: string | null
  open_duration_minutes: number | null
  potentially_missed_clock_out: boolean
}

export async function fetchShifts(storeId: string, from: string, toExclusive: string): Promise<ShiftRow[]> {
  const params = new URLSearchParams({ store_id: storeId, from, to: toExclusive })
  const result = await request<{ shifts: ShiftRow[] }>(`/shifts?${params.toString()}`)
  return result.shifts
}

export interface EmployeeTipRow {
  employeeId: string | null
  employeeName: string
  employeeRole: string | null
  orderCount: number
  grossTipCents: number
  refundedTipCents: number
  netTipCents: number
}

export interface EmployeeTipReport { tips: EmployeeTipRow[]; definition: string }

export function fetchEmployeeTips(storeId: string, from: string, toExclusive: string): Promise<EmployeeTipReport> {
  const params = new URLSearchParams({ store_id: storeId, from, to: toExclusive })
  return request<EmployeeTipReport>(`/shifts/tips?${params.toString()}`)
}

export interface BreakRow { id: string; shift_id: string; employee_id: string; paid: boolean; started_at: string; ended_at: string | null }

export async function fetchBreaks(storeId: string, from: string, toExclusive: string): Promise<BreakRow[]> {
  const params = new URLSearchParams({ store_id: storeId, from, to: toExclusive })
  const result = await request<{ breaks: BreakRow[] }>(`/shifts/breaks?${params.toString()}`)
  return result.breaks
}

export interface TimekeepingCorrection {
  id: string; record_type: 'shift' | 'break'; record_id: string; corrected_by: string
  field: string; old_value: string | null; new_value: string; reason: string; created_at: string
}

export async function fetchCorrections(storeId: string): Promise<TimekeepingCorrection[]> {
  const params = new URLSearchParams({ store_id: storeId })
  const result = await request<{ corrections: TimekeepingCorrection[] }>(`/shifts/corrections?${params.toString()}`)
  return result.corrections
}

// Manager correction to a shift or break record — always requires a reason, written to an
// immutable audit row server-side (timekeeping_corrections). Never mutates history silently.
export async function correctShift(storeId: string, shiftId: string, field: 'clocked_in_at' | 'clocked_out_at', newValue: string, reason: string): Promise<void> {
  await correctionRequest(`/shifts/${shiftId}/correct`, storeId, field, newValue, reason)
}

export async function correctBreak(storeId: string, breakId: string, field: 'started_at' | 'ended_at' | 'paid', newValue: string, reason: string): Promise<void> {
  await correctionRequest(`/shifts/breaks/${breakId}/correct`, storeId, field, newValue, reason)
}

async function correctionRequest(path: string, storeId: string, field: string, newValue: string, reason: string): Promise<void> {
  const response = await authenticatedFetch(`${configuredApiUrl()}${path}?store_id=${encodeURIComponent(storeId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, new_value: newValue, reason }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ code: 'server_unavailable', message: 'Correction failed.' })) as { code: string; message: string }
    throw new ServerReportError(response.status, error.code, error.message)
  }
}

// Payroll-ready CSV export: triggers a browser download rather than returning the text, since
// the endpoint sets Content-Disposition: attachment and the totals must exactly match what's
// already on screen (integer minutes, no client-side recomputation).
export async function downloadTimekeepingCsv(storeId: string, from: string, to: string): Promise<void> {
  const params = new URLSearchParams({ store_id: storeId, from, to })
  const response = await authenticatedFetch(`${configuredApiUrl()}/shifts/export.csv?${params.toString()}`, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ code: 'server_unavailable', message: 'Export failed.' })) as { code: string; message: string }
    throw new ServerReportError(response.status, error.code, error.message)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `timekeeping-${from}-to-${to}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
