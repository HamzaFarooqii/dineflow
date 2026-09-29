import type { KitchenTicketStatus } from '../../../../packages/domain/src/kitchen-ticket-status'
import type { Course } from '../../../../packages/domain/src/course'
import type { SlaState } from '../../../../packages/domain/src/kitchen-sla'
import { accessToken, configuredApiUrl } from './catalog'

export interface KitchenTicketItem {
  id: string
  order_item_id: string
  station_id: string | null
  station_name: string | null
  status: KitchenTicketStatus
  fired_at: string | null
  ready_at: string | null
  served_at: string | null
  course: Course | null
  held_at: string | null
  sla_state: SlaState
  snapshot_name: string
  quantity: number
  modifiers: { group_name: string; option_name: string }[]
}
export interface KitchenTicket {
  id: string
  status: KitchenTicketStatus
  order_id: string
  receipt_number: string
  order_type: string
  table_id: string | null
  table_label: string | null
  created_at: string
  items: KitchenTicketItem[]
}

// GET /kitchen/tickets (or /pos/kitchen/tickets on a terminal) — mirrors fetchFloorPlan's shape
// exactly (Blueprint docs/09, Day 2).
export async function fetchKitchenTickets(storeId: string, terminal = false): Promise<KitchenTicket[]> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/kitchen' : '/kitchen'}/tickets?${query}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? {} : { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { tickets?: KitchenTicket[]; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Kitchen tickets could not be loaded (${response.status}).`)
  return body.tickets ?? []
}

// PATCH /kitchen/tickets/:id/items/:itemId — advance (or cancel) one ticket item. Owner/manager
// only today, same as the rest of /kitchen (no terminal variant is wired up yet).
export async function advanceKitchenTicketItem(storeId: string, ticketId: string, itemId: string, status: KitchenTicketStatus, terminal = false): Promise<{ ticket_id: string; ticket_status: KitchenTicketStatus }> {
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/kitchen' : '/kitchen'}/tickets/${encodeURIComponent(ticketId)}/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH', credentials: terminal ? 'include' : 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }) },
    body: JSON.stringify({ store_id: storeId, status }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { ticket_id?: string; ticket_status?: KitchenTicketStatus; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Could not update this ticket (${response.status}).`)
  return { ticket_id: body.ticket_id ?? ticketId, ticket_status: body.ticket_status ?? status }
}

async function postCourseAction(action: 'fire' | 'hold', storeId: string, ticketId: string, course: Course, terminal = false) {
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/kitchen' : '/kitchen'}/tickets/${encodeURIComponent(ticketId)}/courses/${course}/${action}`, {
    method: 'POST', credentials: terminal ? 'include' : 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }) },
    body: JSON.stringify({ store_id: storeId }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Could not ${action} this course (${response.status}).`)
  return body
}
// Fires every still-queued item of one course on one ticket -- 'queued' -> 'preparing'. Idempotent
// on the server: calling this again after the course already fired is a harmless no-op.
export const fireCourse = (storeId: string, ticketId: string, course: Course, terminal = false) => postCourseAction('fire', storeId, ticketId, course, terminal)
// Marks every still-queued item of one course as explicitly held (informational only).
export const holdCourse = (storeId: string, ticketId: string, course: Course, terminal = false) => postCourseAction('hold', storeId, ticketId, course, terminal)

export interface StationSummary { station_id: string | null; station_name: string | null; calm: number; warning: number; late: number }
export async function fetchStationSummary(storeId: string, terminal = false): Promise<StationSummary[]> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/kitchen' : '/kitchen'}/stations/summary?${query}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? {} : { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { stations?: StationSummary[]; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Station summary could not be loaded (${response.status}).`)
  return body.stations ?? []
}

// GET /kitchen/tickets/history — manager-only, no terminal variant (see kitchen.ts's own comment:
// ticket history is a back-of-house reporting concern).
export async function fetchKitchenTicketHistory(
  storeId: string,
  filters: { status?: 'served' | 'cancelled'; date?: string; stationId?: string; cursor?: string; limit?: number } = {},
): Promise<{ tickets: KitchenTicket[]; next_cursor: string | null }> {
  const query = new URLSearchParams({ store_id: storeId })
  if (filters.status) query.set('status', filters.status)
  if (filters.date) query.set('date', filters.date)
  if (filters.stationId) query.set('station_id', filters.stationId)
  if (filters.cursor) query.set('cursor', filters.cursor)
  if (filters.limit) query.set('limit', String(filters.limit))
  const response = await fetch(`${configuredApiUrl()}/kitchen/tickets/history?${query}`, {
    credentials: 'same-origin',
    headers: { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { tickets?: KitchenTicket[]; next_cursor?: string | null; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Ticket history could not be loaded (${response.status}).`)
  return { tickets: body.tickets ?? [], next_cursor: body.next_cursor ?? null }
}
