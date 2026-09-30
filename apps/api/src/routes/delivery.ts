import { Router, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { ApiError, requireStoreManager, requireStoreMember, sendApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'
import type { StaffRole } from '../../../../packages/domain/src/staff-role.js'

export const deliveryRouter = Router()
export const terminalDeliveryRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PHONE_RE = /^[1-9][0-9]{3,14}$/

function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}
function uuidParam(value: unknown, name: string): string {
  const result = String(value ?? '')
  if (!UUID_RE.test(result)) throw new ApiError(422, 'validation_failed', `${name} must be a valid uuid.`)
  return result
}

export type DeliveryStatus = 'pending' | 'accepted' | 'picked_up' | 'out_for_delivery' | 'delivered' | 'failed'
export const DELIVERY_STATUSES: readonly DeliveryStatus[] = ['pending', 'accepted', 'picked_up', 'out_for_delivery', 'delivered', 'failed']
function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === 'string' && (DELIVERY_STATUSES as readonly string[]).includes(value)
}

export function isRiderRole(role: StaffRole): boolean {
  return role === 'rider'
}

// Explicit edges only, same philosophy as floor.ts's TRANSITIONS -- a rider's device can only
// ever move a delivery forward one step at a time, or into 'failed' from any non-terminal state.
// 'pending' -> 'accepted' is the rider acknowledging an assignment; a delivery cannot be
// "accepted" before a rider is assigned (enforced in applyDeliveryTransition, not here).
export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  pending: ['accepted', 'failed'],
  accepted: ['picked_up', 'failed'],
  picked_up: ['out_for_delivery', 'failed'],
  out_for_delivery: ['delivered', 'failed'],
  delivered: [],
  failed: [],
}

const STATUS_TIMESTAMP_COLUMN: Partial<Record<DeliveryStatus, string>> = {
  accepted: 'accepted_at', picked_up: 'picked_up_at', out_for_delivery: 'out_for_delivery_at',
  delivered: 'delivered_at', failed: 'failed_at',
}

export interface DeliveryOrderRow {
  id: string; store_id: string; order_id: string
  recipient_name_snapshot: string; contact_phone_snapshot: string; address_snapshot: string
  delivery_instructions_snapshot: string | null
  rider_id: string | null; status: DeliveryStatus; failure_reason: string | null
  last_operation_id: string | null
  accepted_at: string | null; picked_up_at: string | null; out_for_delivery_at: string | null
  delivered_at: string | null; failed_at: string | null
  created_at: string; updated_at: string
}

const DELIVERY_COLUMNS = `id, store_id, order_id, recipient_name_snapshot, contact_phone_snapshot, address_snapshot,
  delivery_instructions_snapshot, rider_id, status, failure_reason, last_operation_id,
  accepted_at, picked_up_at, out_for_delivery_at, delivered_at, failed_at, created_at, updated_at`

// Same column list, aliased for use in a query that joins delivery_orders (as "d") against other
// tables -- avoids ambiguous-column errors without hand-duplicating the list at each call site.
const DELIVERY_COLUMNS_D = DELIVERY_COLUMNS.split(',').map(c => `d.${c.trim()}`).join(', ')

// --- Creation: a delivery-type order gets exactly one delivery_orders row, created once at
// checkout time with an immutable snapshot of the recipient/contact/address/instructions as they
// stood at that moment. orders.ts calls this after inserting the order row (same transaction is
// not required -- a delivery order with no delivery_orders row yet is simply not visible on
// dispatch, which is a safe, self-correcting state, not a broken one).
export async function createDeliveryOrderSnapshot(client: PoolClient, params: {
  storeId: string; orderId: string
  recipientName: string; contactPhone: string; address: string; instructions: string | null
}): Promise<void> {
  await client.query(
    `insert into public.delivery_orders (store_id, order_id, recipient_name_snapshot, contact_phone_snapshot, address_snapshot, delivery_instructions_snapshot)
     values ($1,$2,$3,$4,$5,$6)`,
    [params.storeId, params.orderId, params.recipientName, params.contactPhone, params.address, params.instructions],
  )
}

function deliveryDetailsBody(body: Record<string, unknown>): { recipientName: string; contactPhone: string; address: string; instructions: string | null } {
  const recipientName = String(body.recipient_name ?? '').trim()
  if (!recipientName || recipientName.length > 120) throw new ApiError(422, 'validation_failed', 'recipient_name must be 1-120 characters.')
  const contactPhone = String(body.contact_phone ?? '')
  if (!PHONE_RE.test(contactPhone)) throw new ApiError(422, 'validation_failed', 'contact_phone must be a valid normalized phone number.')
  const address = String(body.address ?? '').trim()
  if (!address || address.length > 400) throw new ApiError(422, 'validation_failed', 'address must be 1-400 characters.')
  const rawInstructions = body.delivery_instructions
  const instructions = rawInstructions === undefined || rawInstructions === null ? null : String(rawInstructions)
  if (instructions !== null && instructions.length > 500) throw new ApiError(422, 'validation_failed', 'delivery_instructions must be at most 500 characters.')
  return { recipientName, contactPhone, address, instructions }
}
export { deliveryDetailsBody }

// --- Owner dispatch: list ------------------------------------------------------------------
//
// Delivery-only, by construction: this table only ever has a row for an order whose order_type
// is 'delivery' (createDeliveryOrderSnapshot is only ever called for those), so no order_type
// filter is needed here -- the join target itself is the filter.
async function listDispatch(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreMember(req, storeId)
    const statusFilter = req.query.status
    const params: unknown[] = [storeId]
    let statusClause = ''
    if (statusFilter !== undefined) {
      if (!isDeliveryStatus(statusFilter)) throw new ApiError(422, 'validation_failed', 'status filter is invalid.')
      params.push(statusFilter)
      statusClause = `and d.status = $${params.length}`
    }
    const rows = await db.query(
      `select ${DELIVERY_COLUMNS_D},
              po.receipt_number, po.total_cents::text as total_cents, po.client_generated_at,
              e.name as rider_name
       from public.delivery_orders d
       join public.pos_orders po on po.store_id = d.store_id and po.id = d.order_id
       left join public.terminal_employees e on e.store_id = d.store_id and e.id = d.rider_id
       where d.store_id = $1 ${statusClause}
       order by po.client_generated_at desc`,
      params,
    )
    res.json({ deliveries: rows.rows })
  } catch (reason) { sendApiError(res, reason) }
}

// --- Owner dispatch: KPIs -------------------------------------------------------------------
//
// Count by status (covers every delivery, including 'failed') plus average time-to-delivered
// (created_at -> delivered_at, in seconds), which is only meaningful for -- and only averaged
// over -- deliveries that actually reached 'delivered'; a failed delivery has no delivered_at
// and is correctly excluded from that average, not folded into it. Computed in SQL rather than
// pulled client-side so the number is correct even as the dataset grows past what a single page
// load would fetch.
async function dispatchKpis(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreMember(req, storeId)
    const counts = await db.query<{ status: DeliveryStatus; count: string }>(
      'select status, count(*)::text as count from public.delivery_orders where store_id = $1 group by status',
      [storeId],
    )
    const avg = await db.query<{ avg_seconds: string | null }>(
      `select avg(extract(epoch from (delivered_at - created_at)))::text as avg_seconds
       from public.delivery_orders where store_id = $1 and status = 'delivered'`,
      [storeId],
    )
    const byStatus = Object.fromEntries(DELIVERY_STATUSES.map(status => [status, 0])) as Record<DeliveryStatus, number>
    for (const row of counts.rows) byStatus[row.status] = Number(row.count)
    res.json({ by_status: byStatus, average_time_to_delivered_seconds: avg.rows[0]?.avg_seconds ? Number(avg.rows[0].avg_seconds) : null })
  } catch (reason) { sendApiError(res, reason) }
}

// --- Owner dispatch: assign / reassign / unassign -------------------------------------------
//
// Manager/owner only. Assigning (or reassigning) a rider is only allowed while the delivery
// hasn't progressed past 'pending' or 'accepted' -- once a rider has picked the order up, control
// belongs to that rider's own lifecycle transitions, not a fresh assignment out from under them.
// Reassigning away from a rider who already accepted resets the delivery to 'pending' so the new
// rider must explicitly accept it too (an acceptance is a commitment specific to one rider).
async function assignRider(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    const actorId = await requireStoreManager(req, storeId)
    const deliveryId = uuidParam(req.params.id, 'Delivery ID')
    const body = req.body as Record<string, unknown>
    const riderId = body.rider_id === null ? null : uuidParam(body.rider_id, 'rider_id')

    const client = await db.connect()
    try {
      await client.query('begin')
      const current = await client.query<DeliveryOrderRow>(
        `select ${DELIVERY_COLUMNS} from public.delivery_orders where store_id=$1 and id=$2 for update`,
        [storeId, deliveryId],
      )
      const row = current.rows[0]
      if (!row) throw new ApiError(404, 'not_found', 'Delivery not found in this store.')
      if (!['pending', 'accepted'].includes(row.status)) {
        throw new ApiError(409, 'invalid_transition', `Cannot reassign a delivery that is already ${row.status}.`)
      }
      if (riderId !== null) {
        const rider = await client.query<{ role: StaffRole }>(
          'select role from public.terminal_employees where id=$1 and store_id=$2 and active=true',
          [riderId, storeId],
        )
        if (!rider.rows[0] || !isRiderRole(rider.rows[0].role)) {
          throw new ApiError(422, 'validation_failed', 'rider_id must reference an active rider in this store.')
        }
      }
      const resetToPending = row.rider_id !== riderId && row.status === 'accepted'
      const updated = await client.query<DeliveryOrderRow>(
        `update public.delivery_orders
         set rider_id = $1, status = case when $3 then 'pending' else status end,
             accepted_at = case when $3 then null else accepted_at end, updated_at = now()
         where store_id = $2 and id = $4
         returning ${DELIVERY_COLUMNS}`,
        [riderId, storeId, resetToPending, deliveryId],
      )
      await client.query(
        `insert into public.delivery_status_events (store_id, delivery_order_id, from_status, to_status, actor_type, actor_id, operation_id, note)
         values ($1,$2,$3,$4,'manager',$5,$6,$7)`,
        [storeId, deliveryId, row.status, updated.rows[0].status, actorId, randomUUID(),
          riderId ? `Assigned rider ${riderId}` : 'Unassigned rider'],
      )
      await client.query('commit')
      res.json(updated.rows[0])
    } catch (reason) { await client.query('rollback').catch(() => undefined); throw reason }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
}

// --- Owner dispatch: status timeline ---------------------------------------------------------
async function statusTimeline(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreMember(req, storeId)
    const deliveryId = uuidParam(req.params.id, 'Delivery ID')
    const rows = await db.query(
      `select id, from_status, to_status, actor_type, actor_id, operation_id, note, created_at
       from public.delivery_status_events where store_id=$1 and delivery_order_id=$2 order by created_at asc`,
      [storeId, deliveryId],
    )
    res.json({ events: rows.rows })
  } catch (reason) { sendApiError(res, reason) }
}

// --- Shared transition core -------------------------------------------------------------------
//
// Server-authoritative, audited, idempotent compare-and-swap. Mirrors floor.ts's
// applyTableStatusTransition (row lock + CAS) plus purchasing's operation_id idempotency: the
// caller supplies both the status it believes the row is currently at (expectedStatus, i.e.
// optimistic-concurrency "version") and an operationId it generates once per logical action.
//
// Three outcomes:
//  1. Row is at expectedStatus and the edge is legal -> apply it, stamp last_operation_id, audit,
//     return the new row. This is the normal path.
//  2. Row is NOT at expectedStatus, but its last_operation_id already equals the one supplied and
//     its current status already equals the target status -> this is a replay of a request that
//     already succeeded (e.g. a rider's flaky connection retried the same PATCH). Returns the
//     current row unchanged, not an error -- replaying never double-applies or errors confusingly.
//  3. Anything else -> a genuine stale-write conflict: the row moved on to a different state than
//     the client's local copy expects. Surfaced as 409 so the client shows a visible conflict
//     (e.g. "This delivery is already picked_up — refresh") instead of silently overwriting
//     newer server state. This is this feature's offline-conflict contract: a Rider's device
//     always sends the status it thinks it's transitioning FROM, and a mismatch is never resolved
//     by trusting the client.
export class DeliveryConflictError extends ApiError {
  constructor(public currentStatus: DeliveryStatus, message: string) { super(409, 'status_conflict', message) }
}

export async function applyDeliveryTransition(params: {
  storeId: string; deliveryId: string; expectedStatus: DeliveryStatus; toStatus: DeliveryStatus
  operationId: string; actorType: 'rider' | 'manager' | 'system'; actorId: string | null
  requireRiderId?: string; failureReason?: string | null
}): Promise<DeliveryOrderRow> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const current = await client.query<DeliveryOrderRow>(
      `select ${DELIVERY_COLUMNS} from public.delivery_orders where store_id=$1 and id=$2 for update`,
      [params.storeId, params.deliveryId],
    )
    const row = current.rows[0]
    if (!row) throw new ApiError(404, 'not_found', 'Delivery not found in this store.')

    if (params.requireRiderId !== undefined && row.rider_id !== params.requireRiderId) {
      throw new ApiError(403, 'authorization_failed', 'This delivery is not assigned to you.')
    }

    // Outcome 2: idempotent replay of an already-applied transition.
    if (row.status === params.toStatus && row.last_operation_id === params.operationId) {
      await client.query('commit')
      return row
    }

    if (row.status !== params.expectedStatus) {
      await client.query('rollback')
      throw new DeliveryConflictError(row.status, `This delivery's status changed to ${row.status} since it was last loaded.`)
    }
    if (!DELIVERY_TRANSITIONS[params.expectedStatus].includes(params.toStatus)) {
      throw new ApiError(422, 'invalid_transition', `Cannot move a delivery from ${params.expectedStatus} to ${params.toStatus}.`)
    }
    if (params.toStatus === 'accepted' && !row.rider_id) {
      throw new ApiError(409, 'invalid_transition', 'A rider must be assigned before a delivery can be accepted.')
    }

    const timestampColumn = STATUS_TIMESTAMP_COLUMN[params.toStatus]
    const updated = await client.query<DeliveryOrderRow>(
      `update public.delivery_orders
       set status = $1, last_operation_id = $2, updated_at = now(),
           failure_reason = case when $1 = 'failed' then $6 else failure_reason end
           ${timestampColumn ? `, ${timestampColumn} = now()` : ''}
       where store_id = $3 and id = $4 and status = $5
       returning ${DELIVERY_COLUMNS}`,
      [params.toStatus, params.operationId, params.storeId, params.deliveryId, params.expectedStatus, params.failureReason ?? null],
    )
    if (!updated.rows[0]) {
      // Lost the race between our read and our write (another transition committed in between).
      await client.query('rollback')
      const fresh = await db.query<{ status: DeliveryStatus }>('select status from public.delivery_orders where store_id=$1 and id=$2', [params.storeId, params.deliveryId])
      throw new DeliveryConflictError(fresh.rows[0]?.status ?? row.status, `This delivery's status changed since it was last loaded.`)
    }
    await client.query(
      `insert into public.delivery_status_events (store_id, delivery_order_id, from_status, to_status, actor_type, actor_id, operation_id, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [params.storeId, params.deliveryId, params.expectedStatus, params.toStatus, params.actorType, params.actorId, params.operationId, params.failureReason ?? null],
    )
    await client.query('commit')
    return updated.rows[0]
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    throw reason
  } finally { client.release() }
}

function transitionBody(req: Request): { expectedStatus: DeliveryStatus; toStatus: DeliveryStatus; operationId: string; failureReason: string | null } {
  const body = req.body as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw new ApiError(422, 'validation_failed', 'A JSON object is required.')
  const { expected_status, status, operation_id, failure_reason } = body
  if (!isDeliveryStatus(expected_status)) throw new ApiError(422, 'validation_failed', 'A valid expected_status is required.')
  if (!isDeliveryStatus(status)) throw new ApiError(422, 'validation_failed', 'A valid status is required.')
  if (typeof operation_id !== 'string' || !UUID_RE.test(operation_id)) throw new ApiError(422, 'validation_failed', 'A valid operation_id (uuid) is required for idempotent replay.')
  if (status === 'failed') {
    if (typeof failure_reason !== 'string' || !failure_reason.trim() || failure_reason.length > 300) {
      throw new ApiError(422, 'validation_failed', 'failure_reason is required (1-300 chars) when failing a delivery.')
    }
  } else if (failure_reason !== undefined && failure_reason !== null) {
    throw new ApiError(422, 'validation_failed', 'failure_reason may only be supplied when failing a delivery.')
  }
  return { expectedStatus: expected_status, toStatus: status, operationId: operation_id, failureReason: (failure_reason as string | undefined) ?? null }
}

// Owner/manager transition: can drive the same lifecycle by hand (e.g. marking a delivery failed
// after a phone call with the rider) but never needs the "assigned to me" restriction a rider's
// own endpoint enforces below.
async function ownerTransition(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    const actorId = await requireStoreManager(req, storeId)
    const deliveryId = uuidParam(req.params.id, 'Delivery ID')
    const { expectedStatus, toStatus, operationId, failureReason } = transitionBody(req)
    const updated = await applyDeliveryTransition({
      storeId, deliveryId, expectedStatus, toStatus, operationId, actorType: 'manager', actorId, failureReason,
    })
    res.json(updated)
  } catch (reason) { sendApiError(res, reason) }
}

deliveryRouter.get('/', listDispatch)
deliveryRouter.get('/kpis', dispatchKpis)
deliveryRouter.get('/:id/events', statusTimeline)
deliveryRouter.patch('/:id/rider', assignRider)
deliveryRouter.patch('/:id/status', ownerTransition)

// --- Rider terminal: view assigned deliveries, accept, advance own lifecycle ------------------
//
// Scoped strictly to the signed-in rider's own store and own assigned deliveries -- no listing of
// unassigned deliveries (that would leak other guests'/other riders' work), no financial data, no
// other store's rows. requireRiderTerminal below layers a role check on top of
// requireCashierTerminal's existing store/device/session verification: a cashier, waiter, chef or
// inventory_manager terminal login must never reach these routes even if it somehow knows the URL.
export interface RiderTerminalContext { storeId: string; deviceId: string; employeeId: string }
async function requireRiderTerminal(req: Request): Promise<RiderTerminalContext> {
  // requireCashierTerminal already re-verifies the session against an active employee row and
  // returns that employee's own server-verified role -- no second query needed to re-check it.
  const session = await requireCashierTerminal(req, db)
  if (!isRiderRole(session.role)) {
    throw new ApiError(403, 'authorization_failed', 'This terminal session does not have rider access.')
  }
  return session
}

// GET /pos/delivery/mine — only deliveries currently assigned to the signed-in rider, and never
// deliveries already 'delivered'/'failed' more than a day old (keeps the working list small and
// avoids handing a rider's device an ever-growing personal history dump).
async function myDeliveries(req: Request, res: Response) {
  try {
    const session = await requireRiderTerminal(req)
    const rows = await db.query(
      `select ${DELIVERY_COLUMNS_D},
              po.receipt_number, po.order_type
       from public.delivery_orders d
       join public.pos_orders po on po.store_id = d.store_id and po.id = d.order_id
       where d.store_id = $1 and d.rider_id = $2
         and (d.status not in ('delivered','failed') or d.updated_at > now() - interval '1 day')
       order by d.created_at asc`,
      [session.storeId, session.employeeId],
    )
    res.json({ deliveries: rows.rows })
  } catch (reason) { sendApiError(res, reason) }
}

// PATCH /pos/delivery/:id/status — the rider's own lifecycle transition. requireRiderId enforces
// that this delivery is actually assigned to the calling rider (see applyDeliveryTransition) —
// a rider can never advance, view the timeline of, or otherwise act on another rider's delivery,
// even one in their own store, closing the "no access to ... other riders' orders" requirement.
async function riderTransition(req: Request, res: Response) {
  try {
    const session = await requireRiderTerminal(req)
    const deliveryId = uuidParam(req.params.id, 'Delivery ID')
    const { expectedStatus, toStatus, operationId, failureReason } = transitionBody(req)
    const updated = await applyDeliveryTransition({
      storeId: session.storeId, deliveryId, expectedStatus, toStatus, operationId,
      actorType: 'rider', actorId: session.employeeId, requireRiderId: session.employeeId, failureReason,
    })
    res.json(updated)
  } catch (reason) { sendApiError(res, reason) }
}

terminalDeliveryRouter.get('/mine', myDeliveries)
terminalDeliveryRouter.patch('/:id/status', riderTransition)
