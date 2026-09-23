import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreMember, sendApiError, ApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'
import { deriveTicketStatus, KITCHEN_TICKET_ITEM_TRANSITIONS, KITCHEN_TICKET_STATUSES, type KitchenTicketStatus } from '../../../../packages/domain/src/kitchen-ticket-status.js'
import { applyTableStatusTransition } from './floor.js'

export const kitchenRouter = Router()
export const terminalKitchenRouter = Router()

// Mirrors floor.ts's storeIdParam exactly (duplicated rather than imported — floor.ts is
// Bisma's file; this route has no dependency on it).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}
function uuidParam(value: unknown, name: string): string {
  const result = String(value ?? '')
  if (!UUID_RE.test(result)) throw new ApiError(422, 'validation_failed', `${name} must be a UUID.`)
  return result
}

interface TicketItemRow {
  ticket_id: string; ticket_status: KitchenTicketStatus; table_id: string | null; table_label: string | null
  order_id: string; receipt_number: string; order_type: string; created_at: string
  item_id: string; order_item_id: string; station_id: string | null; station_name: string | null
  item_status: KitchenTicketStatus; fired_at: string | null; ready_at: string | null; served_at: string | null
  snapshot_name: string; quantity: number
}

// Active board only — a ticket disappears once every item is served (or the whole ticket is
// cancelled). No "history" view exists yet; that's a Reports-day concern, not the KDS.
const TICKETS_QUERY = `
  select kt.id as ticket_id, kt.status as ticket_status, kt.table_id, rt.label as table_label,
    kt.order_id, po.receipt_number, po.order_type, kt.created_at,
    kti.id as item_id, kti.order_item_id, kti.station_id, ks.name as station_name,
    kti.status as item_status, kti.fired_at, kti.ready_at, kti.served_at,
    poi.snapshot_name, poi.quantity
  from public.kitchen_tickets kt
  join public.pos_orders po on po.store_id = kt.store_id and po.id = kt.order_id
  join public.kitchen_ticket_items kti on kti.store_id = kt.store_id and kti.ticket_id = kt.id
  join public.pos_order_items poi on poi.id = kti.order_item_id
  left join public.restaurant_tables rt on rt.store_id = kt.store_id and rt.id = kt.table_id
  left join public.kitchen_stations ks on ks.store_id = kt.store_id and ks.id = kti.station_id
  where kt.store_id = $1 and kt.status in ('queued', 'preparing', 'ready')
  order by kt.created_at asc, poi.snapshot_name asc
`

function groupTickets(rows: TicketItemRow[]) {
  const byId = new Map<string, ReturnType<typeof ticketShape>>()
  for (const row of rows) {
    let ticket = byId.get(row.ticket_id)
    if (!ticket) { ticket = ticketShape(row); byId.set(row.ticket_id, ticket) }
    ticket.items.push({
      id: row.item_id, order_item_id: row.order_item_id, station_id: row.station_id, station_name: row.station_name,
      status: row.item_status, fired_at: row.fired_at, ready_at: row.ready_at, served_at: row.served_at,
      snapshot_name: row.snapshot_name, quantity: row.quantity,
    })
  }
  return [...byId.values()]
}
function ticketShape(row: TicketItemRow) {
  return { id: row.ticket_id, status: row.ticket_status, order_id: row.order_id, receipt_number: row.receipt_number,
    order_type: row.order_type, table_id: row.table_id, table_label: row.table_label, created_at: row.created_at,
    items: [] as { id: string; order_item_id: string; station_id: string | null; station_name: string | null
      status: KitchenTicketStatus; fired_at: string | null; ready_at: string | null; served_at: string | null
      snapshot_name: string; quantity: number }[] }
}

// GET /kitchen/tickets and GET /pos/kitchen/tickets — active kitchen tickets for a store, one
// row per ticket with its items nested, grouped/filterable by station client-side (same pattern
// FloorScreen uses for area tabs). Read-only.
async function getTickets(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    if (terminal) {
      const session = await requireCashierTerminal(req, db)
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }
    const rows = await db.query<TicketItemRow>(TICKETS_QUERY, [storeId])
    res.json({ tickets: groupTickets(rows.rows) })
  } catch (reason) { sendApiError(res, reason) }
}

// PATCH /kitchen/tickets/:id/items/:itemId — advance (or cancel) one ticket item. Body:
// { store_id, status }. Rejects any transition not listed in KITCHEN_TICKET_ITEM_TRANSITIONS,
// then recomputes the parent ticket's status from all its items (deriveTicketStatus) — a
// ticket's status is never set directly, only read off its items.
async function patchItem(req: Request, res: Response) {
  try {
    const storeId = uuidParam((req.body as Record<string, unknown>)?.store_id, 'Store ID')
    const ticketId = uuidParam(req.params.id, 'Ticket ID')
    const itemId = uuidParam(req.params.itemId, 'Item ID')
    const nextStatus = (req.body as Record<string, unknown>)?.status
    if (typeof nextStatus !== 'string' || !KITCHEN_TICKET_STATUSES.includes(nextStatus as KitchenTicketStatus)) {
      throw new ApiError(422, 'validation_failed', 'Status is invalid.')
    }
    await requireStoreMember(req, storeId)

    const client = await db.connect()
    try {
      await client.query('begin')
      const current = await client.query<{ status: KitchenTicketStatus }>(
        'select status from public.kitchen_ticket_items where store_id=$1 and ticket_id=$2 and id=$3 for update',
        [storeId, ticketId, itemId],
      )
      if (!current.rows[0]) throw new ApiError(404, 'not_found', 'Ticket item not found.')
      const from = current.rows[0].status
      const to = nextStatus as KitchenTicketStatus
      if (!KITCHEN_TICKET_ITEM_TRANSITIONS[from].includes(to)) {
        throw new ApiError(422, 'invalid_transition', `Cannot move a ${from} item to ${to}.`)
      }
      const timestampColumn = to === 'preparing' ? 'fired_at' : to === 'ready' ? 'ready_at' : to === 'served' ? 'served_at' : null
      await client.query(
        `update public.kitchen_ticket_items set status=$1${timestampColumn ? `, ${timestampColumn}=now()` : ''} where store_id=$2 and id=$3`,
        [to, storeId, itemId],
      )
      const siblings = await client.query<{ status: KitchenTicketStatus }>(
        'select status from public.kitchen_ticket_items where store_id=$1 and ticket_id=$2',
        [storeId, ticketId],
      )
      const ticketStatus = deriveTicketStatus(siblings.rows.map(row => row.status))
      const ticket = await client.query<{ table_id: string | null }>(
        'update public.kitchen_tickets set status=$1 where store_id=$2 and id=$3 returning table_id',
        [ticketStatus, storeId, ticketId],
      )
      await client.query('commit')

      // Closing a Day 2 gap: a fully-served dine-in ticket frees its table. This calls floor.ts's
      // shared transition primitive directly rather than writing to restaurant_tables here — it's
      // a system-triggered transition, not one exposed through the public status-update endpoint
      // (see applyTableStatusTransition's own comment). Best-effort and outside the transaction
      // above: if the table already moved on (e.g. staff hit "Bill" early) or has no table_id
      // (takeaway/delivery), this is a silent no-op, not a failure — the ticket is correctly
      // served either way, and the kitchen's response below doesn't depend on this succeeding.
      const tableId = ticket.rows[0]?.table_id
      if (ticketStatus === 'served' && tableId) {
        await applyTableStatusTransition(storeId, tableId, 'ordering', 'served').catch(() => undefined)
      }

      res.json({ ticket_id: ticketId, ticket_status: ticketStatus, item: { id: itemId, status: to } })
    } catch (reason) { await client.query('rollback'); throw reason }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
}

kitchenRouter.get('/tickets', (req, res) => getTickets(req, res))
terminalKitchenRouter.get('/tickets', (req, res) => getTickets(req, res, true))
kitchenRouter.patch('/tickets/:id/items/:itemId', (req, res) => patchItem(req, res))
