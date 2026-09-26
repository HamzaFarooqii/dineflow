import { configuredApiUrl } from './catalog'

export interface Shift { id: string; employee_id: string; device_id: string; clocked_in_at: string; clocked_out_at: string | null }

// Terminal-only (clock-in/out is a PIN-authenticated cashier-terminal concept, same credentials
// shape as fetchActivePromotions' terminal path -- device+cashier cookies, no bearer token).
async function shiftsRequest(path: string, storeId: string, method = 'GET'): Promise<{ shift: Shift | null }> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}/pos/shifts${path}?${query}`, {
    method,
    credentials: 'include',
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as { shift?: Shift | null; message?: string }
  if (!response.ok) throw new Error(parsed.message ?? `Request failed (${response.status}).`)
  return { shift: parsed.shift ?? null }
}

export const fetchCurrentShift = (storeId: string) => shiftsRequest('/current', storeId)
export const clockIn = (storeId: string) => shiftsRequest('/clock-in', storeId, 'POST')
export const clockOut = (storeId: string) => shiftsRequest('/clock-out', storeId, 'POST')
