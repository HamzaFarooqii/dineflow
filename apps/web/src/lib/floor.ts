import type { TableStatus } from '../../../../packages/domain/src/table-status'
import type { StaffRole } from '../../../../packages/domain/src/staff-role'
import { accessToken, configuredApiUrl } from './catalog'

export interface FloorArea { id: string; store_id: string; name: string; sort_order: number }
export interface RestaurantTable {
  id: string
  store_id: string
  floor_area_id: string
  label: string
  seats: number
  status: TableStatus
  assigned_waiter_id: string | null
  assigned_waiter_name: string | null
  // The table's most recent non-refunded order — not a live running tab. pos_orders rows only
  // exist after checkout completes, so a table that's currently `ordering` has neither of these
  // yet (both null) until the register payment finishes. See floor.ts's getFloorPlan comment.
  current_order_id: string | null
  current_order_total_cents: string | null
}
export interface FloorEmployee { id: string; name: string; role: StaffRole }
export interface FloorPlan { areas: FloorArea[]; tables: RestaurantTable[]; employees: FloorEmployee[] }

export async function fetchFloorPlan(storeId: string, terminal = false): Promise<FloorPlan> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/floor' : '/floor'}?${query}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? {} : { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as Partial<FloorPlan> & { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Floor plan could not be loaded (${response.status}).`)
  return { areas: body.areas ?? [], tables: body.tables ?? [], employees: body.employees ?? [] }
}

// --- Floor structure CRUD (manager/owner only — no terminal variant, see floor.ts's comment) ---

async function floorRequest<T>(path: string, method: string, storeId: string, body?: Record<string, unknown>): Promise<T> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}/floor${path}?${query}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 204) return undefined as T
  const parsed = await response.json().catch(() => ({})) as T & { message?: string }
  if (!response.ok) throw new Error((parsed as { message?: string }).message ?? `Request failed (${response.status}).`)
  return parsed
}

export async function createFloorArea(storeId: string, name: string, sortOrder = 0): Promise<FloorArea> {
  return floorRequest<FloorArea>('/areas', 'POST', storeId, { name, sort_order: sortOrder })
}
export async function updateFloorArea(storeId: string, areaId: string, patch: { name?: string; sort_order?: number; active?: boolean }): Promise<FloorArea> {
  return floorRequest<FloorArea>(`/areas/${areaId}`, 'PATCH', storeId, patch)
}
export async function deleteFloorArea(storeId: string, areaId: string): Promise<void> {
  await floorRequest<void>(`/areas/${areaId}`, 'DELETE', storeId)
}
export async function createRestaurantTable(storeId: string, floorAreaId: string, label: string, seats: number): Promise<RestaurantTable> {
  return floorRequest<RestaurantTable>('/tables', 'POST', storeId, { floor_area_id: floorAreaId, label, seats })
}
export async function updateRestaurantTable(storeId: string, tableId: string, patch: { label?: string; seats?: number; floor_area_id?: string; active?: boolean }): Promise<RestaurantTable> {
  return floorRequest<RestaurantTable>(`/tables/${tableId}`, 'PATCH', storeId, patch)
}
export async function deleteRestaurantTable(storeId: string, tableId: string): Promise<void> {
  await floorRequest<void>(`/tables/${tableId}`, 'DELETE', storeId)
}

export class TableStatusConflictError extends Error {}

// Every call site passes `expectedStatus` as the status currently shown on the client's copy of
// the table, so a stale client naturally surfaces a 409 (TableStatusConflictError) instead of
// silently overwriting a concurrent change. `assignedWaiterId` is only meaningful when seating a
// table (available -> seated); the API rejects it on any other transition.
export async function updateTableStatus(
  storeId: string,
  tableId: string,
  expectedStatus: TableStatus,
  status: TableStatus,
  assignedWaiterId?: string | null,
  terminal = false,
): Promise<RestaurantTable> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/floor' : '/floor'}/tables/${tableId}/status?${query}`, {
    method: 'PATCH',
    credentials: terminal ? 'include' : 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }),
    },
    body: JSON.stringify({ expected_status: expectedStatus, status, assigned_waiter_id: assignedWaiterId ?? null }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as Partial<RestaurantTable> & { message?: string; code?: string }
  if (!response.ok) {
    if (response.status === 409) throw new TableStatusConflictError(body.message ?? 'This table changed since it was last loaded.')
    throw new Error(body.message ?? `Table status could not be updated (${response.status}).`)
  }
  return body as RestaurantTable
}

export interface TablePartyMoveResult { freed_table_id: string; occupied_table_id: string }

export async function transferTableParty(storeId: string, sourceTableId: string, targetTableId: string): Promise<TablePartyMoveResult> {
  return floorRequest<TablePartyMoveResult>(`/tables/${sourceTableId}/transfer`, 'PATCH', storeId, { target_table_id: targetTableId })
}
export async function mergeTableParty(storeId: string, primaryTableId: string, otherTableId: string): Promise<TablePartyMoveResult> {
  return floorRequest<TablePartyMoveResult>(`/tables/${primaryTableId}/merge`, 'PATCH', storeId, { other_table_id: otherTableId })
}
