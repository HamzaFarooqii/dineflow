import type { TableStatus } from '../../../../packages/domain/src/table-status'
import { accessToken, configuredApiUrl } from './catalog'

export interface FloorArea { id: string; store_id: string; name: string; sort_order: number }
export interface RestaurantTable { id: string; store_id: string; floor_area_id: string; label: string; seats: number; status: TableStatus }
export interface FloorPlan { areas: FloorArea[]; tables: RestaurantTable[] }

export async function fetchFloorPlan(storeId: string, terminal = false): Promise<FloorPlan> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/floor' : '/floor'}?${query}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? {} : { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as Partial<FloorPlan> & { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Floor plan could not be loaded (${response.status}).`)
  return { areas: body.areas ?? [], tables: body.tables ?? [] }
}
