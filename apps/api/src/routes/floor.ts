import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreMember, requireStoreManager, sendApiError, ApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'
import type { TableStatus } from '../../../../packages/domain/src/table-status.js'

export const floorRouter = Router()
export const terminalFloorRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}

// GET /floor and GET /pos/floor — read-only floor plan (active areas + active tables) for a
// store, plus the store's active terminal employees so the web app can populate a waiter
// selector without any browser access to public.terminal_employees (that table revokes all
// browser grants — see 202609150001_terminal_employee_access.sql).
//
// current_order_total_cents/current_order_id (Day 3, closing a Day 2 gap): the most recent
// non-refunded order placed against this table. This is honestly labeled "last order," not a
// live running tab — pos_orders rows are only created at checkout, after payment, because
// there is no in-progress/open-ticket concept in this codebase yet (docs/09 flags this
// explicitly). A table sitting at 'ordering' has no order row at all until the register
// checkout completes; this column is null until then. Building a true pre-payment running
// total is a bigger feature (an open-ticket layer) than this fixup, not a Day 3 task.
async function getFloorPlan(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    if (terminal) {
      const session = await requireCashierTerminal(req, db)
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }
    // Independent queries — no query depends on another's result, so run them concurrently
    // instead of paying three sequential round-trips on every Floor screen load.
    const [areas, tables, employees] = await Promise.all([
      db.query(
        'select id, store_id, name, sort_order from public.floor_areas where store_id = $1 and active = true order by sort_order, name',
        [storeId],
      ),
      db.query(
        `select t.id, t.store_id, t.floor_area_id, t.label, t.seats, t.status, t.assigned_waiter_id,
                e.name as assigned_waiter_name, o.id as current_order_id, o.total_cents::text as current_order_total_cents
         from public.restaurant_tables t
         left join public.terminal_employees e on e.id = t.assigned_waiter_id and e.store_id = t.store_id
         left join lateral (
           select po.id, po.total_cents
           from public.pos_orders po
           where po.store_id = t.store_id and po.table_id = t.id
             and not exists (select 1 from public.pos_refunds pr where pr.store_id = po.store_id and pr.order_id = po.id)
           order by po.client_generated_at desc
           limit 1
         ) o on true
         where t.store_id = $1 and t.active = true
         order by t.label`,
        [storeId],
      ),
      db.query(
        'select id, name, role from public.terminal_employees where store_id = $1 and active = true order by name, id',
        [storeId],
      ),
    ])
    res.json({ areas: areas.rows, tables: tables.rows, employees: employees.rows })
  } catch (reason) { sendApiError(res, reason) }
}

floorRouter.get('/', (req, res) => getFloorPlan(req, res))
terminalFloorRouter.get('/', (req, res) => getFloorPlan(req, res, true))

// --- Table status transitions ---------------------------------------------------------------
//
// Explicit edges only — no wildcard "any status -> bill_requested" (a literal wildcard would
// allow nonsensical jumps like available -> bill_requested or out_of_service -> bill_requested).
// `seated -> bill_requested` is deliberately left out: a party that hasn't ordered shouldn't be
// billable. Flag to the lead: confirm this narrowing is correct, since the original spec used
// `*` and this file is picking a conservative interpretation instead of guessing every case.
//
// `bill_requested -> dirty` is exposed by the floor as an explicit manual "Bill settled" action.
// A future payment integration can trigger the same guarded transition automatically.
//
// Note: no edge below ever produces 'served' — a table can only reach it by a direct DB write
// (e.g. a future kitchen-display integration), never through this endpoint. Flagging this so it
// isn't mistaken for an oversight: the UI's BILLABLE_FROM already accounts for it defensively.
const TRANSITIONS: Record<TableStatus, readonly TableStatus[]> = {
  available: ['seated'],
  seated: ['ordering'],
  ordering: ['bill_requested'],
  served: ['bill_requested'],
  bill_requested: ['dirty'],
  dirty: ['available'],
  reserved: [],
  out_of_service: [],
}

function isTableStatus(value: unknown): value is TableStatus {
  return typeof value === 'string' && value in TRANSITIONS
}

interface StatusUpdateBody {
  expectedStatus: TableStatus
  status: TableStatus
  assignedWaiterId: string | null
}

function parseStatusUpdateBody(req: Request): StatusUpdateBody {
  const body = req.body as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw new ApiError(422, 'validation_failed', 'A JSON object is required.')
  const { expected_status, status, assigned_waiter_id } = body
  if (!isTableStatus(expected_status)) throw new ApiError(422, 'validation_failed', 'A valid expected_status is required.')
  if (!isTableStatus(status)) throw new ApiError(422, 'validation_failed', 'A valid status is required.')
  if (assigned_waiter_id !== undefined && assigned_waiter_id !== null && !UUID_RE.test(String(assigned_waiter_id))) {
    throw new ApiError(422, 'validation_failed', 'assigned_waiter_id must be a valid uuid or null.')
  }
  if (!TRANSITIONS[expected_status].includes(status)) {
    throw new ApiError(400, 'invalid_transition', `Cannot move a table from ${expected_status} to ${status}.`)
  }
  const assignedWaiterId = (assigned_waiter_id ?? null) as string | null
  if (assignedWaiterId !== null && !(expected_status === 'available' && status === 'seated')) {
    throw new ApiError(422, 'validation_failed', 'assigned_waiter_id may only be supplied when seating a table (available -> seated).')
  }
  return { expectedStatus: expected_status, status, assignedWaiterId }
}

async function validateWaiter(storeId: string, waiterId: string | null) {
  if (waiterId === null) return
  const result = await db.query(
    'select 1 from public.terminal_employees where id = $1 and store_id = $2 and active = true',
    [waiterId, storeId],
  )
  if (!result.rowCount) throw new ApiError(422, 'validation_failed', 'The selected waiter is not an active employee of this store.')
}

function tableIdParam(req: Request): string {
  const id = String(req.params.id ?? '')
  if (!UUID_RE.test(id)) throw new ApiError(422, 'validation_failed', 'A valid table id is required.')
  return id
}

export interface TableStatusRow {
  id: string; store_id: string; floor_area_id: string; label: string; seats: number
  status: TableStatus; assigned_waiter_id: string | null
}

// The one place anything writes to restaurant_tables.status — an atomic compare-and-swap
// (only applies if the row is still at expectedStatus) so two concurrent callers can never both
// think their transition won. Shared by the HTTP handler below (which enforces TRANSITIONS
// against a caller-supplied expected_status/status pair) and by kitchen.ts's item-served hook
// (Day 3, closing a Day 2 gap), which calls this directly rather than going through the HTTP
// endpoint's TRANSITIONS check — a served-by-the-kitchen table is a system transition, not one
// a manager should be able to trigger by hand through the API, so it deliberately never becomes
// a reachable edge in the public TRANSITIONS map below. Returns null (never throws) when the
// row wasn't at expectedStatus or doesn't exist/isn't active — callers decide whether that's an
// error (the HTTP handler does) or an ignorable no-op (the kitchen hook does).
export async function applyTableStatusTransition(storeId: string, tableId: string, expectedStatus: TableStatus, status: TableStatus, assignedWaiterId: string | null = null): Promise<TableStatusRow | null> {
  const result = await db.query<TableStatusRow>(
    `update public.restaurant_tables
     set
       status = $1,
       assigned_waiter_id = case
         when $1 = 'seated' then $4::uuid
         when $1 = 'available' then null
         else assigned_waiter_id
       end,
       updated_at = now()
     where id = $2
       and store_id = $3
       and status = $5
       and active = true
     returning id, store_id, floor_area_id, label, seats, status, assigned_waiter_id`,
    [status, tableId, storeId, assignedWaiterId, expectedStatus],
  )
  return result.rows[0] ?? null
}

async function updateTableStatus(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    const tableId = tableIdParam(req)
    if (terminal) {
      const session = await requireCashierTerminal(req, db)
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreManager(req, storeId)
    }
    const { expectedStatus, status, assignedWaiterId } = parseStatusUpdateBody(req)
    await validateWaiter(storeId, assignedWaiterId)

    const updated = await applyTableStatusTransition(storeId, tableId, expectedStatus, status, assignedWaiterId)
    if (updated) {
      const employee = updated.assigned_waiter_id
        ? await db.query<{ name: string }>('select name from public.terminal_employees where id = $1 and store_id = $2', [updated.assigned_waiter_id, storeId])
        : null
      res.json({ ...updated, assigned_waiter_name: employee?.rows[0]?.name ?? null })
      return
    }

    // No row matched the atomic update above (either the table doesn't exist/isn't active in
    // this store, or its status had already moved on from expectedStatus) — this lookup filters
    // on active = true too, so a soft-deleted table reports 404 here rather than a misleading 409.
    const existing = await db.query(
      'select status from public.restaurant_tables where id = $1 and store_id = $2 and active = true',
      [tableId, storeId],
    )
    if (!existing.rowCount) throw new ApiError(404, 'table_not_found', 'Table not found in this store.')
    throw new ApiError(409, 'status_conflict', `This table's status changed to ${existing.rows[0].status} since it was last loaded.`)
  } catch (reason) { sendApiError(res, reason) }
}

floorRouter.patch('/tables/:id/status', (req, res) => updateTableStatus(req, res))
terminalFloorRouter.patch('/tables/:id/status', (req, res) => updateTableStatus(req, res, true))
