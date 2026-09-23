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
// `ordering -> served` is deliberately absent here — see MANAGER_ONLY_TRANSITIONS below.
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

// `ordering -> served` normally happens automatically — kitchen.ts's patchItem calls
// applyTableStatusTransition directly once every item on a dine-in ticket is served, bypassing
// this endpoint entirely. But the kitchen can't always be relied on to be the one source of
// truth (an item never rung through the KDS, a mistake in the ticket, a walked-in side dish) —
// a manager can also mark a table served by hand from the Floor screen. A cashier terminal
// cannot: only the manager/owner web route (requireStoreManager, not requireCashierTerminal)
// is allowed to use this map — see updateTableStatus's `managerCapable` argument below.
const MANAGER_ONLY_TRANSITIONS: Partial<Record<TableStatus, readonly TableStatus[]>> = {
  ordering: ['served'],
}

function isTableStatus(value: unknown): value is TableStatus {
  return typeof value === 'string' && value in TRANSITIONS
}

interface StatusUpdateBody {
  expectedStatus: TableStatus
  status: TableStatus
  assignedWaiterId: string | null
}

export function parseStatusUpdateBody(req: Request, managerCapable: boolean): StatusUpdateBody {
  const body = req.body as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw new ApiError(422, 'validation_failed', 'A JSON object is required.')
  const { expected_status, status, assigned_waiter_id } = body
  if (!isTableStatus(expected_status)) throw new ApiError(422, 'validation_failed', 'A valid expected_status is required.')
  if (!isTableStatus(status)) throw new ApiError(422, 'validation_failed', 'A valid status is required.')
  if (assigned_waiter_id !== undefined && assigned_waiter_id !== null && !UUID_RE.test(String(assigned_waiter_id))) {
    throw new ApiError(422, 'validation_failed', 'assigned_waiter_id must be a valid uuid or null.')
  }
  const allowed = TRANSITIONS[expected_status].includes(status)
    || (managerCapable && (MANAGER_ONLY_TRANSITIONS[expected_status]?.includes(status) ?? false))
  if (!allowed) {
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

function idParam(req: Request): string {
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
// think their transition won. Shared by the HTTP handler below (which enforces TRANSITIONS,
// plus MANAGER_ONLY_TRANSITIONS for a manager-authenticated caller) and by kitchen.ts's
// item-served hook (Day 3), which calls this directly, bypassing the HTTP layer's checks
// entirely — a served-by-the-kitchen table is a system transition, always allowed regardless of
// who's signed in, unlike the manager's manual override above. Returns null (never throws) when
// the row wasn't at expectedStatus or doesn't exist/isn't active — callers decide whether that's
// an error (the HTTP handler does) or an ignorable no-op (the kitchen hook does).
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
    const tableId = idParam(req)
    if (terminal) {
      const session = await requireCashierTerminal(req, db)
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreManager(req, storeId)
    }
    const { expectedStatus, status, assignedWaiterId } = parseStatusUpdateBody(req, !terminal)
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

// --- Floor structure CRUD: areas and tables themselves --------------------------------------
//
// Manager/owner only, no terminal equivalent — laying out the floor is a back-of-house task,
// not something done mid-service from a cashier terminal. Deletes are soft (active = false,
// the same convention pos_products already uses) rather than a real DELETE, so history (past
// orders/tickets that reference a table) never dangles — and each is refused if it would orphan
// or interrupt something currently in use, not just blindly applied.

function nonEmptyText(value: unknown, label: string, maxLength: number): string {
  const text = String(value ?? '').trim()
  if (!text || text.length > maxLength) throw new ApiError(422, 'validation_failed', `${label} must be 1–${maxLength} characters.`)
  return text
}

function isUniqueViolation(reason: unknown): boolean {
  return Boolean(reason && typeof reason === 'object' && 'code' in reason && (reason as { code?: string }).code === '23505')
}

// GET /floor/areas — full list including inactive ones, for the management UI (the main
// getFloorPlan above only returns active areas/tables, correctly, for day-to-day service use).
async function listAreas(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const areas = await db.query(
      'select id, store_id, name, sort_order, active from public.floor_areas where store_id = $1 order by sort_order, name',
      [storeId],
    )
    res.json({ areas: areas.rows })
  } catch (reason) { sendApiError(res, reason) }
}

async function createArea(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const body = req.body as Record<string, unknown>
    const name = nonEmptyText(body.name, 'Area name', 80)
    const sortOrder = body.sort_order !== undefined ? Number(body.sort_order) : 0
    if (!Number.isInteger(sortOrder)) throw new ApiError(422, 'validation_failed', 'sort_order must be an integer.')
    const result = await db.query(
      'insert into public.floor_areas (store_id, name, sort_order) values ($1,$2,$3) returning id, store_id, name, sort_order, active',
      [storeId, name, sortOrder],
    )
    res.status(201).json(result.rows[0])
  } catch (reason) {
    if (isUniqueViolation(reason)) sendApiError(res, new ApiError(409, 'name_conflict', 'An area with this name already exists.'))
    else sendApiError(res, reason)
  }
}

async function updateArea(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const areaId = idParam(req) // same "valid uuid in :id" shape, reused rather than duplicated
    const body = req.body as Record<string, unknown>
    const updates: string[] = []
    const values: unknown[] = []
    let index = 1
    if (body.name !== undefined) { updates.push(`name = $${index++}`); values.push(nonEmptyText(body.name, 'Area name', 80)) }
    if (body.sort_order !== undefined) {
      const sortOrder = Number(body.sort_order)
      if (!Number.isInteger(sortOrder)) throw new ApiError(422, 'validation_failed', 'sort_order must be an integer.')
      updates.push(`sort_order = $${index++}`); values.push(sortOrder)
    }
    if (body.active !== undefined) { updates.push(`active = $${index++}`); values.push(Boolean(body.active)) }
    if (!updates.length) throw new ApiError(422, 'validation_failed', 'Nothing to update.')
    values.push(areaId, storeId)
    const result = await db.query(
      `update public.floor_areas set ${updates.join(', ')} where id = $${index++} and store_id = $${index} returning id, store_id, name, sort_order, active`,
      values,
    )
    if (!result.rowCount) throw new ApiError(404, 'not_found', 'Area not found in this store.')
    res.json(result.rows[0])
  } catch (reason) {
    if (isUniqueViolation(reason)) sendApiError(res, new ApiError(409, 'name_conflict', 'An area with this name already exists.'))
    else sendApiError(res, reason)
  }
}

async function deleteArea(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const areaId = idParam(req)
    const activeTables = await db.query(
      'select 1 from public.restaurant_tables where store_id = $1 and floor_area_id = $2 and active = true limit 1',
      [storeId, areaId],
    )
    if (activeTables.rowCount) throw new ApiError(409, 'area_not_empty', 'Remove or reassign this area’s tables before deleting it.')
    const result = await db.query(
      'update public.floor_areas set active = false where id = $1 and store_id = $2 and active = true returning id',
      [areaId, storeId],
    )
    if (!result.rowCount) throw new ApiError(404, 'not_found', 'Area not found in this store.')
    res.status(204).end()
  } catch (reason) { sendApiError(res, reason) }
}

async function createTable(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const body = req.body as Record<string, unknown>
    const label = nonEmptyText(body.label, 'Table label', 40)
    const floorAreaId = String(body.floor_area_id ?? '')
    if (!UUID_RE.test(floorAreaId)) throw new ApiError(422, 'validation_failed', 'A valid floor_area_id is required.')
    const seats = Number(body.seats)
    if (!Number.isInteger(seats) || seats <= 0) throw new ApiError(422, 'validation_failed', 'seats must be a positive integer.')
    const area = await db.query('select 1 from public.floor_areas where id = $1 and store_id = $2 and active = true', [floorAreaId, storeId])
    if (!area.rowCount) throw new ApiError(422, 'validation_failed', 'floor_area_id must reference an active area in this store.')
    const result = await db.query(
      `insert into public.restaurant_tables (store_id, floor_area_id, label, seats)
       values ($1,$2,$3,$4) returning id, store_id, floor_area_id, label, seats, status, assigned_waiter_id, active`,
      [storeId, floorAreaId, label, seats],
    )
    res.status(201).json(result.rows[0])
  } catch (reason) {
    if (isUniqueViolation(reason)) sendApiError(res, new ApiError(409, 'name_conflict', 'A table with this label already exists.'))
    else sendApiError(res, reason)
  }
}

async function updateTable(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const tableId = idParam(req)
    const body = req.body as Record<string, unknown>
    const updates: string[] = []
    const values: unknown[] = []
    let index = 1
    if (body.label !== undefined) { updates.push(`label = $${index++}`); values.push(nonEmptyText(body.label, 'Table label', 40)) }
    if (body.seats !== undefined) {
      const seats = Number(body.seats)
      if (!Number.isInteger(seats) || seats <= 0) throw new ApiError(422, 'validation_failed', 'seats must be a positive integer.')
      updates.push(`seats = $${index++}`); values.push(seats)
    }
    if (body.floor_area_id !== undefined) {
      const floorAreaId = String(body.floor_area_id)
      if (!UUID_RE.test(floorAreaId)) throw new ApiError(422, 'validation_failed', 'A valid floor_area_id is required.')
      const area = await db.query('select 1 from public.floor_areas where id = $1 and store_id = $2 and active = true', [floorAreaId, storeId])
      if (!area.rowCount) throw new ApiError(422, 'validation_failed', 'floor_area_id must reference an active area in this store.')
      updates.push(`floor_area_id = $${index++}`); values.push(floorAreaId)
    }
    if (body.active !== undefined) { updates.push(`active = $${index++}`); values.push(Boolean(body.active)) }
    if (!updates.length) throw new ApiError(422, 'validation_failed', 'Nothing to update.')
    updates.push('updated_at = now()')
    values.push(tableId, storeId)
    const result = await db.query(
      `update public.restaurant_tables set ${updates.join(', ')} where id = $${index++} and store_id = $${index}
       returning id, store_id, floor_area_id, label, seats, status, assigned_waiter_id, active`,
      values,
    )
    if (!result.rowCount) throw new ApiError(404, 'not_found', 'Table not found in this store.')
    res.json(result.rows[0])
  } catch (reason) {
    if (isUniqueViolation(reason)) sendApiError(res, new ApiError(409, 'name_conflict', 'A table with this label already exists.'))
    else sendApiError(res, reason)
  }
}

async function deleteTable(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const tableId = idParam(req)
    const result = await db.query(
      // Only a table that isn't mid-service can be removed — deleting an occupied table would
      // silently strand its ticket/guest with nowhere on the floor to point to.
      `update public.restaurant_tables set active = false, updated_at = now()
       where id = $1 and store_id = $2 and active = true and status = 'available' returning id`,
      [tableId, storeId],
    )
    if (result.rowCount) { res.status(204).end(); return }
    const existing = await db.query('select status from public.restaurant_tables where id = $1 and store_id = $2 and active = true', [tableId, storeId])
    if (!existing.rowCount) throw new ApiError(404, 'not_found', 'Table not found in this store.')
    throw new ApiError(409, 'table_in_use', `This table is currently ${existing.rows[0].status} — free it before deleting.`)
  } catch (reason) { sendApiError(res, reason) }
}

floorRouter.get('/areas', listAreas)
floorRouter.post('/areas', createArea)
floorRouter.patch('/areas/:id', updateArea)
floorRouter.delete('/areas/:id', deleteArea)
floorRouter.post('/tables', createTable)
floorRouter.patch('/tables/:id', updateTable)
floorRouter.delete('/tables/:id', deleteTable)

// --- Transfer and Merge -----------------------------------------------------------------------
//
// Both move a table's open kitchen tickets (status not yet served/cancelled) to a different
// table's table_id — the mechanic is identical; only the preconditions differ. Historical
// pos_orders rows are never rewritten (an order's table_id records where it was actually placed,
// which stays true after the party moves) — only in-flight kitchen tickets move, since those are
// what the kitchen and the floor still need to track together going forward. Manager/owner only,
// same as the rest of floor structure management; both run inside a single transaction with row
// locks on both tables so two concurrent transfers can't interleave into an inconsistent state.

const OCCUPIED_STATUSES: readonly TableStatus[] = ['seated', 'ordering', 'served']

async function lockTable(client: import('pg').PoolClient, storeId: string, tableId: string): Promise<TableStatusRow> {
  const result = await client.query<TableStatusRow>(
    'select id, store_id, floor_area_id, label, seats, status, assigned_waiter_id from public.restaurant_tables where id=$1 and store_id=$2 and active=true for update',
    [tableId, storeId],
  )
  if (!result.rows[0]) throw new ApiError(404, 'table_not_found', 'Table not found in this store.')
  return result.rows[0]
}

async function moveOpenTickets(client: import('pg').PoolClient, storeId: string, fromTableId: string, toTableId: string): Promise<void> {
  await client.query(
    `update public.kitchen_tickets set table_id = $1 where store_id = $2 and table_id = $3 and status not in ('served', 'cancelled')`,
    [toTableId, storeId, fromTableId],
  )
}

export interface TablePartyMoveResult { freedTableId: string; occupiedTableId: string }

// The shared core of both Transfer and Merge — exported so it's directly testable against
// PGlite without needing an HTTP layer (mirrors applyTableStatusTransition's approach). Locks
// both rows in a fixed (sorted) id order regardless of caller-supplied source/target, so a
// transfer and a merge running concurrently on the same two tables can never deadlock.
//
// Transfer: sourceTableId must be occupied, targetTableId must be 'available' — the party moves
// entirely, and the target inherits the source's exact status/waiter.
// Merge: both tables must already be occupied — the source's open tickets join the target's,
// and the target's own status/waiter are left untouched (it was already running its own party).
export async function moveTableParty(storeId: string, sourceTableId: string, targetTableId: string, mode: 'transfer' | 'merge'): Promise<TablePartyMoveResult> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const [first, second] = [sourceTableId, targetTableId].sort()
    const firstRow = await lockTable(client, storeId, first)
    const secondRow = await lockTable(client, storeId, second)
    const source = first === sourceTableId ? firstRow : secondRow
    const target = first === sourceTableId ? secondRow : firstRow

    if (!OCCUPIED_STATUSES.includes(source.status)) {
      throw new ApiError(409, 'invalid_transition', `Table ${source.label} has no active party to ${mode}.`)
    }
    if (mode === 'transfer' && target.status !== 'available') {
      throw new ApiError(409, 'invalid_transition', `Table ${target.label} is not available to transfer into.`)
    }
    if (mode === 'merge' && !OCCUPIED_STATUSES.includes(target.status)) {
      throw new ApiError(409, 'invalid_transition', `Table ${target.label} has no active party to merge into.`)
    }

    await moveOpenTickets(client, storeId, sourceTableId, targetTableId)
    if (mode === 'transfer') {
      await client.query(
        `update public.restaurant_tables set status=$1, assigned_waiter_id=$2, updated_at=now() where id=$3 and store_id=$4`,
        [source.status, source.assigned_waiter_id, targetTableId, storeId],
      )
    }
    await client.query(
      `update public.restaurant_tables set status='available', assigned_waiter_id=null, updated_at=now() where id=$1 and store_id=$2`,
      [sourceTableId, storeId],
    )
    await client.query('commit')
    return { freedTableId: sourceTableId, occupiedTableId: targetTableId }
  } catch (reason) { await client.query('rollback').catch(() => undefined); throw reason }
  finally { client.release() }
}

async function transferTable(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const sourceId = idParam(req)
    const targetId = String((req.body as Record<string, unknown>)?.target_table_id ?? '')
    if (!UUID_RE.test(targetId)) throw new ApiError(422, 'validation_failed', 'A valid target_table_id is required.')
    if (targetId === sourceId) throw new ApiError(422, 'validation_failed', 'Choose a different table to transfer to.')
    const result = await moveTableParty(storeId, sourceId, targetId, 'transfer')
    res.json({ freed_table_id: result.freedTableId, occupied_table_id: result.occupiedTableId })
  } catch (reason) { sendApiError(res, reason) }
}

async function mergeTables(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const targetId = idParam(req)
    const otherId = String((req.body as Record<string, unknown>)?.other_table_id ?? '')
    if (!UUID_RE.test(otherId)) throw new ApiError(422, 'validation_failed', 'A valid other_table_id is required.')
    if (otherId === targetId) throw new ApiError(422, 'validation_failed', 'Choose a different table to merge in.')
    const result = await moveTableParty(storeId, otherId, targetId, 'merge')
    res.json({ freed_table_id: result.freedTableId, occupied_table_id: result.occupiedTableId })
  } catch (reason) { sendApiError(res, reason) }
}

floorRouter.patch('/tables/:id/transfer', transferTable)
floorRouter.patch('/tables/:id/merge', mergeTables)
