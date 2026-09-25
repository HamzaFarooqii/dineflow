import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreMember, sendApiError, ApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'
import { deriveTicketStatus, KITCHEN_TICKET_ITEM_TRANSITIONS, KITCHEN_TICKET_STATUSES, type KitchenTicketStatus } from '../../../../packages/domain/src/kitchen-ticket-status.js'
import { convertQuantity, type RecipeCostUnit } from '../../../../packages/domain/src/recipe-cost.js'
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
      const current = await client.query<{ status: KitchenTicketStatus; order_item_id: string }>(
        'select status, order_item_id from public.kitchen_ticket_items where store_id=$1 and ticket_id=$2 and id=$3 for update',
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
      if (to === 'served') {
        const orderItem = await client.query<{ product_id: string; quantity: number }>(
          'select product_id, quantity from public.pos_order_items where id=$1',
          [current.rows[0].order_item_id],
        )
        if (orderItem.rows[0]) {
          await consumeRecipeIngredients(client, storeId, itemId, orderItem.rows[0].product_id, orderItem.rows[0].quantity)
        }
      }
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

// Consumption wiring: a served item decrements the ingredients its recipe calls for. Runs inside
// patchItem's own transaction (not best-effort/outside it like the table-status sync below) —
// unlike that sync, which is a UI convenience on a different aggregate with its own reconciliation
// path, stock accuracy is a first-class correctness concern here, same as every other write that
// touches ingredients.current_stock in inventory.ts.
//
// Stock is deliberately allowed to go negative: by the time an item is marked served, the dish
// has already been prepared and handed to the guest, so refusing to record consumption (or
// blocking the serve) would be operationally backwards -- the same "never block a completed
// action over a stock count that might already be stale" reasoning pos_stock's oversell already
// documents. A negative current_stock is a signal for reconciliation, surfaced as an "Out of
// stock" tag on the inventory screen, not an error to raise here.
//
// A recipe line whose unit has no known conversion to its ingredient's stored unit is skipped,
// not guessed at -- mirrors packages/domain/src/recipe-cost.ts's unit_mismatch handling exactly
// (same convertQuantity function, so a line that costs also consumes, and vice versa). A product
// with no recipe at all is skipped entirely; not every dish has one.
export async function consumeRecipeIngredients(client: import('pg').PoolClient, storeId: string, kitchenTicketItemId: string, productId: string, quantitySold: number): Promise<void> {
  const recipe = await client.query<{ id: string; yield_quantity: string }>(
    'select id, yield_quantity from public.recipes where store_id=$1 and product_id=$2',
    [storeId, productId],
  )
  const recipeRow = recipe.rows[0]
  if (!recipeRow) return
  const yieldQuantity = Number(recipeRow.yield_quantity)

  const lines = await client.query<{
    ingredient_id: string; line_quantity: string; line_unit_id: string; line_kind: RecipeCostUnit['kind']; line_factor: number | null
    ingredient_unit_id: string; ingredient_kind: RecipeCostUnit['kind']; ingredient_factor: number | null
  }>(
    `select ri.ingredient_id, ri.quantity::text as line_quantity,
            ri.unit_id as line_unit_id, lu.kind as line_kind, lu.factor_to_base::float8 as line_factor,
            i.unit_id as ingredient_unit_id, iu.kind as ingredient_kind, iu.factor_to_base::float8 as ingredient_factor
     from public.recipe_ingredients ri
     join public.ingredients i on i.store_id = ri.store_id and i.id = ri.ingredient_id
     join public.units lu on lu.store_id = ri.store_id and lu.id = ri.unit_id
     join public.units iu on iu.store_id = i.store_id and iu.id = i.unit_id
     where ri.store_id = $1 and ri.recipe_id = $2`,
    [storeId, recipeRow.id],
  )

  for (const line of lines.rows) {
    const converted = convertQuantity(1,
      { id: line.line_unit_id, kind: line.line_kind, factorToBase: line.line_factor },
      { id: line.ingredient_unit_id, kind: line.ingredient_kind, factorToBase: line.ingredient_factor })
    if (converted === null) continue

    // Defensive: the served transition is one-way (KITCHEN_TICKET_ITEM_TRANSITIONS['served'] is
    // empty) so this item can't be re-served, but a duplicate consumption row is cheap to guard
    // against directly rather than relying solely on that.
    const already = await client.query(
      `select 1 from public.stock_movements where kitchen_ticket_item_id=$1 and ingredient_id=$2 and reason='consumption'`,
      [kitchenTicketItemId, line.ingredient_id],
    )
    if (already.rowCount) continue

    // converted is per unit of line_quantity, so scale it the same way line_quantity itself is used.
    const consumeQuantity = ((Number(line.line_quantity) * converted) / yieldQuantity) * quantitySold
    // Best-effort FEFO batch depletion, same single-batch-only rule as inventory.ts's
    // selectWastageBatch: only associate a specific batch when it alone can cover the quantity,
    // since splitting one consumption across several batches would need multi-batch accounting
    // this schema doesn't have. Never blocks or errors -- if no batch qualifies, the movement is
    // still recorded at the ingredient level exactly as it always was.
    const candidateBatch = await client.query<{ id: string; remaining_quantity: string }>(
      `select id, remaining_quantity::text as remaining_quantity from public.ingredient_batches
       where store_id=$1 and ingredient_id=$2 and remaining_quantity > 0
       order by expires_at asc nulls last, received_at asc
       limit 1 for update`,
      [storeId, line.ingredient_id],
    )
    const batchRow = candidateBatch.rows[0]
    const batchId = batchRow && consumeQuantity <= Number(batchRow.remaining_quantity) ? batchRow.id : null

    await client.query(
      `insert into public.stock_movements (store_id, ingredient_id, batch_id, delta, reason, kitchen_ticket_item_id)
       values ($1,$2,$3,$4,'consumption',$5)`,
      [storeId, line.ingredient_id, batchId, -consumeQuantity, kitchenTicketItemId],
    )
    if (batchId) {
      await client.query('update public.ingredient_batches set remaining_quantity = remaining_quantity - $1 where id=$2 and store_id=$3', [consumeQuantity, batchId, storeId])
    }
    await client.query(
      `update public.ingredients set current_stock = current_stock - $1, updated_at = now() where store_id=$2 and id=$3`,
      [consumeQuantity, storeId, line.ingredient_id],
    )
  }
}

kitchenRouter.get('/tickets', (req, res) => getTickets(req, res))
terminalKitchenRouter.get('/tickets', (req, res) => getTickets(req, res, true))
kitchenRouter.patch('/tickets/:id/items/:itemId', (req, res) => patchItem(req, res))
