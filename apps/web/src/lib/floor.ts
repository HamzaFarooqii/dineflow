import type { TableStatus } from '../../../../packages/domain/src/table-status'
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
}
export interface FloorEmployee { id: string; name: string; role: 'cashier' | 'manager' }
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
