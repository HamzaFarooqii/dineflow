import type { KitchenTicketStatus } from '../../../../packages/domain/src/kitchen-ticket-status'
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
  snapshot_name: string
  quantity: number
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
export async function advanceKitchenTicketItem(storeId: string, ticketId: string, itemId: string, status: KitchenTicketStatus): Promise<{ ticket_id: string; ticket_status: KitchenTicketStatus }> {
  const response = await fetch(`${configuredApiUrl()}/kitchen/tickets/${encodeURIComponent(ticketId)}/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
    body: JSON.stringify({ store_id: storeId, status }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { ticket_id?: string; ticket_status?: KitchenTicketStatus; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Could not update this ticket (${response.status}).`)
  return { ticket_id: body.ticket_id ?? ticketId, ticket_status: body.ticket_status ?? status }
}
