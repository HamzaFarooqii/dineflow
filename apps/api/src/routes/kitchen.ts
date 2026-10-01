import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreMember, requireStoreManager, sendApiError, ApiError } from './auth.js'
import { requireCashierCapability } from '../terminal-auth/routes.js'
import { deriveTicketStatus, KITCHEN_TICKET_ITEM_TRANSITIONS, KITCHEN_TICKET_STATUSES, type KitchenTicketStatus } from '../../../../packages/domain/src/kitchen-ticket-status.js'
import { convertQuantity, type RecipeCostUnit } from '../../../../packages/domain/src/recipe-cost.js'
import { COURSES, type Course } from '../../../../packages/domain/src/course.js'
import { deriveSlaState, DEFAULT_PREP_TARGET_SECONDS, type SlaState } from '../../../../packages/domain/src/kitchen-sla.js'
import { applyTableStatusTransition } from './floor.js'
import { toMicro } from '../../../../packages/domain/src/stock-allocation.js'
import { commitStockOut, loadBatchSources, lockIngredient, planStockOut } from '../lib/stock-allocation.js'

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
  course: Course | null; prep_time_target_seconds: number | null; held_at: string | null
  snapshot_name: string; quantity: number
  modifiers: { group_name: string; option_name: string }[]
}

const ITEM_COLUMNS = `
    kti.id as item_id, kti.order_item_id, kti.station_id, ks.name as station_name,
    kti.status as item_status, kti.fired_at, kti.ready_at, kti.served_at,
    kti.course, kti.prep_time_target_seconds, kti.held_at,
    poi.snapshot_name, poi.quantity,
    coalesce((select json_agg(json_build_object('group_name', m.snapshot_group_name, 'option_name', m.snapshot_option_name) order by m.snapshot_group_name, m.snapshot_option_name)
      from public.pos_order_item_modifiers m where m.store_id=poi.store_id and m.order_item_id=poi.id), '[]'::json) as modifiers
  from public.kitchen_tickets kt
  join public.pos_orders po on po.store_id = kt.store_id and po.id = kt.order_id
  join public.kitchen_ticket_items kti on kti.store_id = kt.store_id and kti.ticket_id = kt.id
  join public.pos_order_items poi on poi.store_id = kti.store_id and poi.id = kti.order_item_id
  left join public.restaurant_tables rt on rt.store_id = kt.store_id and rt.id = kt.table_id
  left join public.kitchen_stations ks on ks.store_id = kt.store_id and ks.id = kti.station_id`

// Active board only — a ticket disappears once every item is served (or the whole ticket is
// cancelled); GET /kitchen/tickets/history (below) is the paginated view of what leaves here.
const TICKETS_QUERY = `
  select kt.id as ticket_id, kt.status as ticket_status, kt.table_id, rt.label as table_label,
    kt.order_id, po.receipt_number, po.order_type, kt.created_at,${ITEM_COLUMNS}
  where kt.store_id = $1 and kt.status in ('queued', 'preparing', 'ready')
  order by kt.created_at asc, poi.snapshot_name asc
`

// SLA state is computed here, server-side, against the request's own clock -- never shipped to
// the browser as raw fired_at/target and recomputed there, which would let two staff members on
// clocks even a few seconds apart disagree about whether an item just crossed into 'late'.
function itemShape(row: TicketItemRow, now: Date) {
  return { id: row.item_id, order_item_id: row.order_item_id, station_id: row.station_id, station_name: row.station_name,
    status: row.item_status, fired_at: row.fired_at, ready_at: row.ready_at, served_at: row.served_at,
    course: row.course, held_at: row.held_at,
    sla_state: deriveSlaState(row.fired_at ? new Date(row.fired_at) : null, row.prep_time_target_seconds ?? DEFAULT_PREP_TARGET_SECONDS, now) as SlaState,
    snapshot_name: row.snapshot_name, quantity: row.quantity, modifiers: row.modifiers }
}
function groupTickets(rows: TicketItemRow[], now: Date) {
  const byId = new Map<string, ReturnType<typeof ticketShape>>()
  for (const row of rows) {
    let ticket = byId.get(row.ticket_id)
    if (!ticket) { ticket = ticketShape(row); byId.set(row.ticket_id, ticket) }
    ticket.items.push(itemShape(row, now))
  }
  return [...byId.values()]
}
function ticketShape(row: TicketItemRow) {
  return { id: row.ticket_id, status: row.ticket_status, order_id: row.order_id, receipt_number: row.receipt_number,
    order_type: row.order_type, table_id: row.table_id, table_label: row.table_label, created_at: row.created_at,
    items: [] as ReturnType<typeof itemShape>[] }
}

// GET /kitchen/tickets and GET /pos/kitchen/tickets — active kitchen tickets for a store, one
// row per ticket with its items nested, grouped/filterable by station client-side (same pattern
// FloorScreen uses for area tabs). Read-only.
async function getTickets(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    if (terminal) {
      const session = await requireCashierCapability(req, db, 'kitchen')
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }
    const rows = await db.query<TicketItemRow>(TICKETS_QUERY, [storeId])
    res.json({ tickets: groupTickets(rows.rows, new Date()) })
  } catch (reason) { sendApiError(res, reason) }
}

// PATCH /kitchen/tickets/:id/items/:itemId — advance (or cancel) one ticket item. Body:
// { store_id, status }. Rejects any transition not listed in KITCHEN_TICKET_ITEM_TRANSITIONS,
// then recomputes the parent ticket's status from all its items (deriveTicketStatus) — a
// ticket's status is never set directly, only read off its items.
async function patchItem(req: Request, res: Response, terminal = false) {
  try {
    const storeId = uuidParam((req.body as Record<string, unknown>)?.store_id, 'Store ID')
    const ticketId = uuidParam(req.params.id, 'Ticket ID')
    const itemId = uuidParam(req.params.itemId, 'Item ID')
    const nextStatus = (req.body as Record<string, unknown>)?.status
    if (typeof nextStatus !== 'string' || !KITCHEN_TICKET_STATUSES.includes(nextStatus as KitchenTicketStatus)) {
      throw new ApiError(422, 'validation_failed', 'Status is invalid.')
    }
    if (terminal) {
      const session = await requireCashierCapability(req, db, 'kitchen')
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }

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

function courseParam(value: unknown): Course {
  if (typeof value !== 'string' || !COURSES.includes(value as Course)) throw new ApiError(422, 'validation_failed', 'A valid course is required.')
  return value as Course
}

// Core of POST /kitchen/tickets/:id/courses/:course/fire -- exported, req/res-free, directly
// testable against PGlite (same shape as floor.ts's applyTableStatusTransition and
// open-checks.ts's createOpenCheckCore). Fires every still-queued item of one course on one
// ticket at once: 'queued' -> 'preparing', fired_at=now(), held_at cleared, and logs who fired it.
// Idempotent: firing a course with nothing left queued (already fired, or never had that course)
// is a no-op that still returns the ticket's current state rather than erroring -- a repeated tap
// (a flaky connection retrying, two cooks tapping at once) can never fire the same course twice.
export async function fireCourseCore(storeId: string, ticketId: string, course: Course, actor: { employeeId: string | null; userId: string | null }) {
  const client = await db.connect()
  try {
    await client.query('begin')
    const queued = await client.query<{ id: string }>(
      `select id from public.kitchen_ticket_items where store_id=$1 and ticket_id=$2 and course=$3 and status='queued' for update`,
      [storeId, ticketId, course],
    )
    if (queued.rowCount) {
      const itemIds = queued.rows.map(row => row.id)
      await client.query(
        `update public.kitchen_ticket_items set status='preparing', fired_at=now(), held_at=null where store_id=$1 and id = any($2::uuid[])`,
        [storeId, itemIds],
      )
      await client.query(
        `insert into public.kitchen_course_fire_log(store_id, ticket_id, course, fired_by_employee_id, fired_by_user_id, fired_item_count)
         values ($1,$2,$3,$4,$5,$6)`,
        [storeId, ticketId, course, actor.employeeId, actor.userId, itemIds.length],
      )
    }
    const siblings = await client.query<{ status: KitchenTicketStatus }>(
      'select status from public.kitchen_ticket_items where store_id=$1 and ticket_id=$2', [storeId, ticketId],
    )
    if (!siblings.rowCount) throw new ApiError(404, 'not_found', 'Ticket not found.')
    const ticketStatus = deriveTicketStatus(siblings.rows.map(row => row.status))
    await client.query('update public.kitchen_tickets set status=$1 where store_id=$2 and id=$3', [ticketStatus, storeId, ticketId])
    await client.query('commit')
    return { ticket_id: ticketId, ticket_status: ticketStatus, course, fired_item_count: queued.rowCount ?? 0 }
  } catch (reason) { await client.query('rollback'); throw reason }
  finally { client.release() }
}
async function fireCourse(req: Request, res: Response, terminal = false) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = uuidParam(body?.store_id, 'Store ID')
    const ticketId = uuidParam(req.params.id, 'Ticket ID')
    const course = courseParam(req.params.course)
    let actor = { employeeId: null as string | null, userId: null as string | null }
    if (terminal) {
      const session = await requireCashierCapability(req, db, 'kitchen')
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
      actor = { employeeId: session.employeeId, userId: null }
    } else {
      actor = { employeeId: null, userId: await requireStoreMember(req, storeId) }
    }
    res.json(await fireCourseCore(storeId, ticketId, course, actor))
  } catch (reason) { sendApiError(res, reason) }
}

// Core of POST /kitchen/tickets/:id/courses/:course/hold -- marks every still-queued item of one
// course as explicitly held (informational only; status stays 'queued'). Idempotent for the same
// reason as fireCourseCore: holding an already-held (or already-fired) course is a harmless no-op.
export async function holdCourseCore(storeId: string, ticketId: string, course: Course) {
  const result = await db.query(
    `update public.kitchen_ticket_items set held_at=now() where store_id=$1 and ticket_id=$2 and course=$3 and status='queued' and held_at is null`,
    [storeId, ticketId, course],
  )
  return { ticket_id: ticketId, course, held_item_count: result.rowCount ?? 0 }
}
async function holdCourse(req: Request, res: Response, terminal = false) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = uuidParam(body?.store_id, 'Store ID')
    const ticketId = uuidParam(req.params.id, 'Ticket ID')
    const course = courseParam(req.params.course)
    if (terminal) {
      const session = await requireCashierCapability(req, db, 'kitchen')
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }
    res.json(await holdCourseCore(storeId, ticketId, course))
  } catch (reason) { sendApiError(res, reason) }
}

// Core of GET /kitchen/stations/summary -- per-station due/late counts among currently
// preparing/ready items (queued items have no running SLA clock, see kitchen-sla.ts, so they're
// excluded here the same way they're excluded from ever being 'late'). `now` is a parameter
// (not `new Date()` inline) specifically so boundary-time tests can pin it exactly.
export async function getStationSummaryCore(storeId: string, now: Date) {
  const rows = await db.query<{ station_id: string | null; station_name: string | null; fired_at: string | null; prep_time_target_seconds: number | null }>(
    `select kti.station_id, ks.name as station_name, kti.fired_at, kti.prep_time_target_seconds
     from public.kitchen_ticket_items kti
     join public.kitchen_tickets kt on kt.store_id=kti.store_id and kt.id=kti.ticket_id
     left join public.kitchen_stations ks on ks.store_id=kti.store_id and ks.id=kti.station_id
     where kti.store_id=$1 and kt.status in ('queued','preparing','ready') and kti.status in ('preparing','ready')`,
    [storeId],
  )
  const byStation = new Map<string, { station_id: string | null; station_name: string | null; calm: number; warning: number; late: number }>()
  for (const row of rows.rows) {
    const key = row.station_id ?? 'unassigned'
    const bucket = byStation.get(key) ?? { station_id: row.station_id, station_name: row.station_name, calm: 0, warning: 0, late: 0 }
    const state = deriveSlaState(row.fired_at ? new Date(row.fired_at) : null, row.prep_time_target_seconds ?? DEFAULT_PREP_TARGET_SECONDS, now)
    bucket[state] += 1
    byStation.set(key, bucket)
  }
  return [...byStation.values()]
}
async function getStationSummary(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    if (terminal) {
      const session = await requireCashierCapability(req, db, 'kitchen')
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }
    res.json({ stations: await getStationSummaryCore(storeId, new Date()) })
  } catch (reason) { sendApiError(res, reason) }
}

export interface TicketHistoryFilters { status: 'served' | 'cancelled' | null; date: string | null; stationId: string | null; limit: number; cursor: string | null }

// Core of GET /kitchen/tickets/history -- manager-only at the HTTP layer (no terminal route:
// ticket history is a back-of-house reporting concern, same scoping OrderHistoryScreen's remote
// section already uses), paginated, filterable by date/station/status. Served/cancelled tickets
// never appear on the active board (TICKETS_QUERY above); this is the only place they're readable.
export async function getTicketHistoryCore(storeId: string, filters: TicketHistoryFilters) {
  const { status, date, stationId, cursor } = filters
  const limit = Math.min(100, Math.max(1, filters.limit))
  // Paginate at the ticket level first (one row per ticket, cheap), then fetch the full
  // item/modifier detail only for the page of ticket ids that survives -- pulling `limit+1`
  // tickets, one more than requested, is how we know whether a next page exists without a
  // separate count query.
  const conditions = [`kt.store_id = $1`, `kt.status in ('served','cancelled')`]
  const params: unknown[] = [storeId]
  if (status) { params.push(status); conditions.push(`kt.status = $${params.length}`) }
  if (date) { params.push(date); conditions.push(`kt.created_at::date = $${params.length}::date`) }
  if (stationId) { params.push(stationId); conditions.push(`exists (select 1 from public.kitchen_ticket_items kti2 where kti2.store_id=kt.store_id and kti2.ticket_id=kt.id and kti2.station_id=$${params.length})`) }
  if (cursor) { params.push(cursor); conditions.push(`kt.created_at < $${params.length}::timestamptz`) }
  params.push(limit + 1)

  const idRows = await db.query<{ id: string }>(
    `select kt.id from public.kitchen_tickets kt where ${conditions.join(' and ')} order by kt.created_at desc limit $${params.length}`,
    params,
  )
  const truncated = idRows.rowCount === limit + 1
  const pageIds = truncated ? idRows.rows.slice(0, limit).map(row => row.id) : idRows.rows.map(row => row.id)
  if (!pageIds.length) return { tickets: [] as ReturnType<typeof ticketShape>[], next_cursor: null as string | null }

  const rows = await db.query<TicketItemRow>(
    `select kt.id as ticket_id, kt.status as ticket_status, kt.table_id, rt.label as table_label,
       kt.order_id, po.receipt_number, po.order_type, kt.created_at,${ITEM_COLUMNS}
     where kt.store_id = $1 and kt.id = any($2::uuid[])
     order by kt.created_at desc, poi.snapshot_name asc`,
    [storeId, pageIds],
  )
  // Re-sort into pageIds' own order -- the `any(...)` query above doesn't guarantee row order
  // matches the array, but groupTickets/orderBy above already sorts within a ticket; this keeps
  // tickets themselves in the same newest-first order idRows established.
  const byTicketId = new Map(groupTickets(rows.rows, new Date()).map(ticket => [ticket.id, ticket]))
  const tickets = pageIds.map(id => byTicketId.get(id)).filter((ticket): ticket is NonNullable<typeof ticket> => Boolean(ticket))
  return { tickets, next_cursor: truncated ? tickets[tickets.length - 1]?.created_at ?? null : null }
}
async function getTicketHistory(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const status = req.query.status ? String(req.query.status) : null
    if (status && !['served', 'cancelled'].includes(status)) throw new ApiError(422, 'validation_failed', 'status must be served or cancelled.')
    const date = req.query.date ? String(req.query.date) : null
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(422, 'validation_failed', 'date must be YYYY-MM-DD.')
    const stationId = req.query.station_id ? uuidParam(req.query.station_id, 'station_id') : null
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
    const cursor = req.query.cursor ? String(req.query.cursor) : null
    res.json(await getTicketHistoryCore(storeId, { status: status as 'served' | 'cancelled' | null, date, stationId, limit, cursor }))
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

  // Unit conversion is explicit and happens exactly once, here: the recipe line's unit is converted
  // to the ingredient's stored unit with convertQuantity (a line whose units can't be related is
  // skipped, never guessed at 1:1), the result is rounded to 6 decimal places (toMicro) and every
  // later step -- batch picking, cost snapshots, stock arithmetic -- works in that integer
  // micro-unit quantity, so fractional kg/L never accumulate floating-point drift.
  // A recipe that lists the same ingredient on two lines consumes the SUM once: the one-consumption-
  // per-item-and-ingredient unique index (and the idempotency check below) would otherwise treat
  // the second line as a duplicate and silently drop it.
  const perIngredient = new Map<string, bigint>()
  for (const line of lines.rows) {
    const converted = convertQuantity(1,
      { id: line.line_unit_id, kind: line.line_kind, factorToBase: line.line_factor },
      { id: line.ingredient_unit_id, kind: line.ingredient_kind, factorToBase: line.ingredient_factor })
    if (converted === null) continue
    const quantityMicro = toMicro(((Number(line.line_quantity) * converted) / yieldQuantity) * quantitySold)
    if (quantityMicro > 0n) perIngredient.set(line.ingredient_id, (perIngredient.get(line.ingredient_id) ?? 0n) + quantityMicro)
  }

  // Ascending ingredient id: two items served at once can never lock the same two ingredients in
  // opposite orders (lock order is documented in lib/stock-allocation.ts).
  for (const [ingredientId, quantityMicro] of [...perIngredient.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ingredient = await lockIngredient(client, storeId, ingredientId)
    if (!ingredient) continue

    // Idempotency, checked AFTER taking the ingredient lock so a concurrent duplicate waits for the
    // first transaction to commit and then sees its row. The partial unique index
    // stock_movements_one_consumption_per_item_ingredient is the backstop beneath this check.
    const already = await client.query(
      `select 1 from public.stock_movements where kitchen_ticket_item_id=$1 and ingredient_id=$2 and reason='consumption'`,
      [kitchenTicketItemId, ingredientId],
    )
    if (already.rowCount) continue

    // Service is never blocked: consumption may take aggregate stock negative. Batches supply what
    // they can in physical picking order (earliest expiry first); any quantity they cannot cover is
    // recorded as an allocation with basis 'estimated_ingredient_cost' and no batch.
    const sources = await loadBatchSources(client, storeId, ingredientId)
    const plan = planStockOut(sources, quantityMicro, ingredient.costPerUnitCents)
    await commitStockOut(client, storeId, ingredientId, plan, quantityMicro, { reason: 'consumption', kitchenTicketItemId })
  }
}

kitchenRouter.get('/tickets', (req, res) => getTickets(req, res))
terminalKitchenRouter.get('/tickets', (req, res) => getTickets(req, res, true))
kitchenRouter.get('/tickets/history', (req, res) => getTicketHistory(req, res))
kitchenRouter.patch('/tickets/:id/items/:itemId', (req, res) => patchItem(req, res))
terminalKitchenRouter.patch('/tickets/:id/items/:itemId', (req, res) => patchItem(req, res, true))
kitchenRouter.post('/tickets/:id/courses/:course/fire', (req, res) => fireCourse(req, res))
terminalKitchenRouter.post('/tickets/:id/courses/:course/fire', (req, res) => fireCourse(req, res, true))
kitchenRouter.post('/tickets/:id/courses/:course/hold', (req, res) => holdCourse(req, res))
terminalKitchenRouter.post('/tickets/:id/courses/:course/hold', (req, res) => holdCourse(req, res, true))
kitchenRouter.get('/stations/summary', (req, res) => getStationSummary(req, res))
terminalKitchenRouter.get('/stations/summary', (req, res) => getStationSummary(req, res, true))
