// Restaurant POS Transformation Blueprint (docs/09) — shared kitchen-ticket-status contract.
// Values mirror the check constraint on both public.kitchen_tickets.status and
// public.kitchen_ticket_items.status, added by
// supabase/migrations/202609230001_kitchen_display_system.sql, exactly; do not add a value here
// without a matching migration, and do not add a migration value without updating this file.
//
// One union serves both columns: an item's status is the real, independently-advanced state a
// line cook moves through course by course; a ticket's status is a derived read of its items
// (see deriveTicketStatus below), never set directly.
import type { StatusTone } from './table-status.js'

export type KitchenTicketStatus = 'queued' | 'preparing' | 'ready' | 'served' | 'cancelled'

export const KITCHEN_TICKET_STATUSES: readonly KitchenTicketStatus[] = [
  'queued', 'preparing', 'ready', 'served', 'cancelled',
]

export const KITCHEN_TICKET_STATUS_LABELS: Record<KitchenTicketStatus, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  cancelled: 'Cancelled',
}

// Reuses table-status.ts's StatusTone rather than redeclaring the same --mise-* tone union —
// this mapping is consumed the same way TABLE_STATUS_TONE is (Blueprint Section 2).
export const KITCHEN_TICKET_STATUS_TONE: Record<KitchenTicketStatus, StatusTone> = {
  queued: 'muted',
  preparing: 'saffron',
  ready: 'info',
  served: 'success',
  cancelled: 'danger',
}

// Forward-only lifecycle for a single ticket item: queued -> preparing -> ready -> served, or
// cancelled from anywhere before served. The API checks a PATCH's requested status against this
// instead of trusting whatever the client sends.
export const KITCHEN_TICKET_ITEM_TRANSITIONS: Record<KitchenTicketStatus, readonly KitchenTicketStatus[]> = {
  queued: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served', 'cancelled'],
  served: [],
  cancelled: [],
}

// A ticket's own status is derived from its items, never set independently — this is the one
// place that derivation lives so the API (and any future UI) agree on what "the ticket" is
// doing. Cancelled items don't count toward the ticket's state unless every item is cancelled.
export function deriveTicketStatus(itemStatuses: readonly KitchenTicketStatus[]): KitchenTicketStatus {
  const active = itemStatuses.filter(status => status !== 'cancelled')
  if (!active.length) return itemStatuses.length ? 'cancelled' : 'queued'
  if (active.every(status => status === 'served')) return 'served'
  if (active.every(status => status === 'ready' || status === 'served')) return 'ready'
  if (active.some(status => status === 'preparing' || status === 'ready' || status === 'served')) return 'preparing'
  return 'queued'
}
