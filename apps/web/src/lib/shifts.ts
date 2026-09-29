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

export interface ShiftBreak { id: string; shift_id: string; employee_id: string; paid: boolean; started_at: string; ended_at: string | null }

// Same terminal-cookie auth shape as shiftsRequest above — breaks are a sub-resource of the
// caller's own open shift, so no shift_id is threaded through the client at all.
async function breaksRequest(path: string, storeId: string, method = 'GET', body?: Record<string, unknown>): Promise<{ break: ShiftBreak | null }> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}/pos/shifts/breaks${path}?${query}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as { break?: ShiftBreak | null; message?: string }
  if (!response.ok) throw new Error(parsed.message ?? `Request failed (${response.status}).`)
  return { break: parsed.break ?? null }
}

export const fetchCurrentBreak = (storeId: string) => breaksRequest('/current', storeId)
export const startBreak = (storeId: string, paid: boolean) => breaksRequest('/start', storeId, 'POST', { paid })
export const endBreak = (storeId: string) => breaksRequest('/end', storeId, 'POST')
