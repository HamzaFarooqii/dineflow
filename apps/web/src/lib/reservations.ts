import { accessToken, configuredApiUrl } from './catalog'

export type BookingKind = 'reservation' | 'waitlist'
export type ReservationStatus = 'booked' | 'arrived' | 'seated' | 'cancelled' | 'no_show'
export type WaitlistStatus = 'waiting' | 'seated' | 'cancelled' | 'no_show'
export type BookingFilter = 'today' | 'upcoming' | 'waiting' | 'all'

export interface BookingEntry {
  id: string
  store_id: string
  guest_name: string
  guest_phone: string | null
  guest_size: number
  notes: string
  expected_at: string
  status: ReservationStatus | WaitlistStatus
  floor_area_id: string | null
  restaurant_table_id: string | null
  seated_at: string | null
  seated_table_id: string | null
  seated_operation_id: string | null
  wait_minutes?: number
}

export interface BookingsResponse {
  reservations: BookingEntry[]
  waitlist: BookingEntry[]
}

export interface BookingDraft {
  guest_name: string
  guest_phone?: string | null
  guest_size: number
  notes?: string
  expected_at?: string
  floor_area_id?: string | null
  restaurant_table_id?: string | null
}

async function bookingRequest<T>(storeId: string, path: string, terminal: boolean, options: RequestInit = {}): Promise<T> {
  const query = new URLSearchParams({ store_id: storeId })
  const separator = path.includes('?') ? '&' : '?'
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (!terminal) headers.set('Authorization', `Bearer ${await accessToken()}`)
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/reservations' : '/reservations'}${path}${separator}${query}`, {
    ...options,
    credentials: terminal ? 'include' : 'same-origin',
    headers,
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as T & { message?: string }
  if (!response.ok) throw new Error(parsed.message ?? `Reservation request failed (${response.status}).`)
  return parsed
}

export async function fetchBookings(storeId: string, filter: BookingFilter, terminal = false): Promise<BookingsResponse> {
  return bookingRequest<BookingsResponse>(storeId, `/?${new URLSearchParams({ filter }).toString()}`, terminal)
}

export async function createBooking(storeId: string, kind: BookingKind, draft: BookingDraft, terminal = false): Promise<{ reservation?: BookingEntry; waitlist?: BookingEntry; warnings?: string[] }> {
  return bookingRequest(storeId, kind === 'reservation' ? '/reservations' : '/waitlist', terminal, { method: 'POST', body: JSON.stringify(draft) })
}

export async function updateBooking(storeId: string, kind: BookingKind, id: string, draft: Partial<BookingDraft> & { status?: string }, terminal = false): Promise<{ reservation?: BookingEntry; waitlist?: BookingEntry; warnings?: string[] }> {
  return bookingRequest(storeId, `${kind === 'reservation' ? '/reservations' : '/waitlist'}/${id}`, terminal, { method: 'PATCH', body: JSON.stringify(draft) })
}

export async function runBookingAction(storeId: string, kind: BookingKind, id: string, action: 'arrive' | 'cancel' | 'no-show', terminal = false): Promise<{ reservation?: BookingEntry; waitlist?: BookingEntry }> {
  return bookingRequest(storeId, `${kind === 'reservation' ? '/reservations' : '/waitlist'}/${id}/${action}`, terminal, { method: 'POST' })
}

export async function seatBooking(storeId: string, kind: BookingKind, id: string, tableId: string, assignedWaiterId: string | null, terminal = false): Promise<{ reservation?: BookingEntry; waitlist?: BookingEntry }> {
  const operationId = crypto.randomUUID()
  return bookingRequest(storeId, `${kind === 'reservation' ? '/reservations' : '/waitlist'}/${id}/seat`, terminal, {
    method: 'POST',
    body: JSON.stringify({ table_id: tableId, assigned_waiter_id: assignedWaiterId, operation_id: operationId }),
  })
}
