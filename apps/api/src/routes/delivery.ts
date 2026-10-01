import { Router, type Request, type Response } from 'express'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { ApiError, requireStoreManager, requireStoreMember, sendApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'
import type { StaffRole } from '../../../../packages/domain/src/staff-role.js'
import { isTicketReadyForHandoff, type KitchenTicketStatus } from '../../../../packages/domain/src/kitchen-ticket-status.js'

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

// --- Proof of delivery -------------------------------------------------------------------------
//
// No SMS/push notification provider exists anywhere in this codebase, so a one-time confirmation
// code -- read aloud to the customer by whoever takes the (phone) delivery order, the one channel
// that already exists here -- stands in for it (docs/DISPATCH_OPERATIONS.md explains the choice
// and its limits). The plaintext code is returned exactly once, by issueDeliveryProof, and never
// stored or re-returned afterward; only its hash is kept (supabase/migrations/
// 202610020002_delivery_proofs.sql).
const PROOF_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours -- long enough for any single delivery shift.
const PROOF_MAX_ATTEMPTS = 5
const PROOF_CODE_RE = /^\d{6}$/
function hashProofCode(code: string): string { return createHash('sha256').update(code).digest('hex') }
function generateProofCode(): string { return randomInt(0, 1_000_000).toString().padStart(6, '0') }

// Secure issuance: a fresh random 6-digit code, hashed before it ever touches storage. Any
// previously active (unconsumed, not-yet-invalidated) proof for this delivery is invalidated
// first -- never more than one code a customer could legitimately be holding at a time, so
// reissuing (e.g. attempts were exhausted, or the customer lost it) can't leave a stale valid
// code floating around alongside the new one.
export async function issueDeliveryProof(client: PoolClient, storeId: string, deliveryOrderId: string): Promise<string> {
  await client.query(
    `update public.delivery_proofs set invalidated_at = now()
     where store_id=$1 and delivery_order_id=$2 and consumed_at is null and invalidated_at is null`,
    [storeId, deliveryOrderId],
  )
  const code = generateProofCode()
  await client.query(
    `insert into public.delivery_proofs (store_id, delivery_order_id, code_hash, max_attempts, expires_at)
     values ($1,$2,$3,$4,$5)`,
    [storeId, deliveryOrderId, hashProofCode(code), PROOF_MAX_ATTEMPTS, new Date(Date.now() + PROOF_TTL_MS)],
  )
  return code
}

// Replay-safe completion: called from applyDeliveryTransition inside the SAME transaction that
// will go on to update delivery_orders and insert the audit event, so a successful verification
// here (consumed_at set) is only ever durable if that later write also succeeds -- a crash or
// error partway through rolls both back together, never leaving "proof consumed, status
// unchanged". A wrong-code or expired attempt, by contrast, commits its own bookkeeping
// (attempt_count / invalidated_at) immediately, via its own explicit commit below, specifically
// so a failed attempt is never silently lost to an unrelated later rollback -- attempt limits only
// mean something if they survive the request that triggered them.
async function consumeDeliveryProofOrThrow(client: PoolClient, storeId: string, deliveryOrderId: string, code: string): Promise<void> {
  if (!PROOF_CODE_RE.test(code)) throw new ApiError(422, 'proof_invalid', 'The proof-of-delivery code must be 6 digits.')
  const active = await client.query<{ id: string; code_hash: string; attempt_count: number; max_attempts: number; expires_at: string }>(
    `select id, code_hash, attempt_count, max_attempts, expires_at from public.delivery_proofs
     where store_id=$1 and delivery_order_id=$2 and consumed_at is null and invalidated_at is null
     order by created_at desc limit 1 for update`,
    [storeId, deliveryOrderId],
  )
  const proof = active.rows[0]
  if (!proof) throw new ApiError(422, 'proof_invalid', 'No active proof-of-delivery code exists for this delivery — ask a manager to reissue one.')
  if (new Date(proof.expires_at).getTime() <= Date.now()) {
    await client.query('update public.delivery_proofs set invalidated_at = now() where store_id=$1 and id=$2', [storeId, proof.id])
    await client.query('commit')
    throw new ApiError(422, 'proof_expired', 'This proof-of-delivery code has expired — ask a manager to reissue one.')
  }
  if (hashProofCode(code) !== proof.code_hash) {
    const nextAttempts = proof.attempt_count + 1
    const exhausted = nextAttempts >= proof.max_attempts
    await client.query(
      `update public.delivery_proofs set attempt_count=$1, invalidated_at = case when $2 then now() else invalidated_at end where store_id=$3 and id=$4`,
      [nextAttempts, exhausted, storeId, proof.id],
    )
    await client.query('commit')
    throw new ApiError(422, 'proof_invalid', exhausted
      ? 'Too many incorrect codes — this code is now locked. Ask a manager to reissue one.'
      : `That code doesn't match. ${proof.max_attempts - nextAttempts} attempt(s) left.`)
  }
  const consumed = await client.query(
    `update public.delivery_proofs set consumed_at = now() where store_id=$1 and id=$2 and consumed_at is null returning id`,
    [storeId, proof.id],
  )
  if (!consumed.rows[0]) throw new ApiError(422, 'proof_invalid', 'This proof-of-delivery code was already used.')
}

// --- Creation: a delivery-type order gets exactly one delivery_orders row, created once at
// checkout time with an immutable snapshot of the recipient/contact/address/instructions as they
// stood at that moment. orders.ts calls this after inserting the order row (same transaction is
// not required -- a delivery order with no delivery_orders row yet is simply not visible on
// dispatch, which is a safe, self-correcting state, not a broken one). Also issues this
// delivery's first proof-of-delivery code in the same transaction -- see issueDeliveryProof.
export async function createDeliveryOrderSnapshot(client: PoolClient, params: {
  storeId: string; orderId: string
  recipientName: string; contactPhone: string; address: string; instructions: string | null
}): Promise<{ deliveryOrderId: string; proofCode: string }> {
  const inserted = await client.query<{ id: string }>(
    `insert into public.delivery_orders (store_id, order_id, recipient_name_snapshot, contact_phone_snapshot, address_snapshot, delivery_instructions_snapshot)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [params.storeId, params.orderId, params.recipientName, params.contactPhone, params.address, params.instructions],
  )
  const deliveryOrderId = inserted.rows[0].id
  const proofCode = await issueDeliveryProof(client, params.storeId, deliveryOrderId)
  return { deliveryOrderId, proofCode }
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

// --- Kitchen readiness + honest ETA, shared by listDispatch and myDeliveries -------------------
//
// "Honest" per the assignment: an ETA only ever comes from an owner/manager's explicit
// delivery_target_minutes (stores.ts), or this store's OWN historical average time-to-delivered
// once it has enough samples to mean anything (MIN_HISTORY_SAMPLE) -- never a single data point,
// never a guess, never another store's numbers. Absent both, estimated_delivery_at is null and
// eta_basis says why, rather than the UI silently showing nothing with no explanation.
interface EtaBasis { durationSeconds: number | null; basis: 'configured' | 'historical_average' | 'unavailable' }
const MIN_HISTORY_SAMPLE = 5

async function loadEtaBasis(storeId: string): Promise<EtaBasis> {
  const store = await db.query<{ delivery_target_minutes: number | null }>(
    'select delivery_target_minutes from public.stores where id=$1', [storeId],
  )
  const configuredMinutes = store.rows[0]?.delivery_target_minutes ?? null
  if (configuredMinutes !== null) return { durationSeconds: configuredMinutes * 60, basis: 'configured' }
  const hist = await db.query<{ avg_seconds: string | null; sample_size: string }>(
    `select avg(extract(epoch from (delivered_at - created_at)))::text as avg_seconds, count(*)::text as sample_size
     from public.delivery_orders where store_id=$1 and status='delivered'`,
    [storeId],
  )
  const sampleSize = Number(hist.rows[0]?.sample_size ?? '0')
  const avgSeconds = hist.rows[0]?.avg_seconds
  if (sampleSize >= MIN_HISTORY_SAMPLE && avgSeconds) return { durationSeconds: Math.round(Number(avgSeconds)), basis: 'historical_average' }
  return { durationSeconds: null, basis: 'unavailable' }
}

// An ETA is only meaningful before the delivery is resolved one way or the other -- a delivered
// or failed row always gets estimated_delivery_at: null, its real outcome already speaks for itself.
const ETA_RELEVANT_STATUSES: ReadonlySet<DeliveryStatus> = new Set(['pending', 'accepted', 'picked_up', 'out_for_delivery'])

type DispatchRow = DeliveryOrderRow & { kitchen_status: KitchenTicketStatus | null }
function withDispatchDerivedFields(rows: DispatchRow[], eta: EtaBasis) {
  return rows.map(row => ({
    ...row,
    // Derived straight from the kitchen's own ticket/item state (packages/domain/src/
    // kitchen-ticket-status.ts), never inferred from the delivery's own age or status -- the same
    // rule applyDeliveryTransition enforces server-side before allowing 'picked_up' (below), just
    // surfaced here so the UI can show/disable ahead of a rejected request rather than after one.
    kitchen_ready: row.kitchen_status !== null && isTicketReadyForHandoff(row.kitchen_status),
    estimated_delivery_at: ETA_RELEVANT_STATUSES.has(row.status) && eta.durationSeconds != null
      ? new Date(new Date(row.created_at).getTime() + eta.durationSeconds * 1000).toISOString()
      : null,
    eta_basis: eta.basis,
  }))
}

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
    const rows = await db.query<DispatchRow>(
      `select ${DELIVERY_COLUMNS_D},
              po.receipt_number, po.total_cents::text as total_cents, po.client_generated_at,
              e.name as rider_name, kt.status as kitchen_status
       from public.delivery_orders d
       join public.pos_orders po on po.store_id = d.store_id and po.id = d.order_id
       left join public.terminal_employees e on e.store_id = d.store_id and e.id = d.rider_id
       left join public.kitchen_tickets kt on kt.store_id = d.store_id and kt.order_id = d.order_id
       where d.store_id = $1 ${statusClause}
       order by po.client_generated_at desc`,
      params,
    )
    const eta = await loadEtaBasis(storeId)
    res.json({ deliveries: withDispatchDerivedFields(rows.rows, eta) })
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
  requireRiderId?: string; failureReason?: string | null; proofCode?: string | null
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
    // Kitchen readiness: derived from the ticket's actual item state (packages/domain/src/
    // kitchen-ticket-status.ts), never from this delivery's own age or status. Deliberately
    // distinguishes "still cooking" from "every item was cancelled" (the no-preparation case) --
    // both block pickup, but the second one is a distinct problem that needs a manager, not a wait.
    if (params.toStatus === 'picked_up') {
      const ticket = await client.query<{ status: KitchenTicketStatus }>(
        'select status from public.kitchen_tickets where store_id=$1 and order_id=$2',
        [params.storeId, row.order_id],
      )
      const ticketStatus = ticket.rows[0]?.status ?? null
      if (!ticketStatus || !isTicketReadyForHandoff(ticketStatus)) {
        throw new ApiError(409, 'kitchen_not_ready', ticketStatus === 'cancelled'
          ? 'Every item on this order was cancelled in the kitchen — resolve with a manager before dispatching.'
          : 'This order is not ready for pickup yet — the kitchen has not finished preparing it.')
      }
    }
    // Proof of delivery: verified (and consumed) in the SAME transaction as the status update
    // below, so a crash between the two can never leave "proof used, status unchanged" — see
    // consumeDeliveryProofOrThrow's own comment on why a failed attempt still commits on its own.
    if (params.toStatus === 'delivered') {
      if (!params.proofCode) throw new ApiError(422, 'validation_failed', 'A proof-of-delivery code is required to complete this delivery.')
      await consumeDeliveryProofOrThrow(client, params.storeId, params.deliveryId, params.proofCode)
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

function transitionBody(req: Request): { expectedStatus: DeliveryStatus; toStatus: DeliveryStatus; operationId: string; failureReason: string | null; proofCode: string | null } {
  const body = req.body as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw new ApiError(422, 'validation_failed', 'A JSON object is required.')
  const { expected_status, status, operation_id, failure_reason, proof_code } = body
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
  // Required for BOTH actor types: a manager driving this by hand still needs the customer to
  // read the code off the phone, same as a rider standing at the door -- there is no "manager
  // override" path that bypasses proof of delivery, since that would defeat its entire purpose.
  if (status === 'delivered') {
    if (typeof proof_code !== 'string' || !PROOF_CODE_RE.test(proof_code)) {
      throw new ApiError(422, 'validation_failed', 'proof_code (6 digits) is required to mark a delivery delivered.')
    }
  } else if (proof_code !== undefined && proof_code !== null) {
    throw new ApiError(422, 'validation_failed', 'proof_code may only be supplied when marking a delivery delivered.')
  }
  return {
    expectedStatus: expected_status, toStatus: status, operationId: operation_id,
    failureReason: (failure_reason as string | undefined) ?? null, proofCode: (proof_code as string | undefined) ?? null,
  }
}

// Owner/manager transition: can drive the same lifecycle by hand (e.g. marking a delivery failed
// after a phone call with the rider) but never needs the "assigned to me" restriction a rider's
// own endpoint enforces below.
async function ownerTransition(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    const actorId = await requireStoreManager(req, storeId)
    const deliveryId = uuidParam(req.params.id, 'Delivery ID')
    const { expectedStatus, toStatus, operationId, failureReason, proofCode } = transitionBody(req)
    const updated = await applyDeliveryTransition({
      storeId, deliveryId, expectedStatus, toStatus, operationId, actorType: 'manager', actorId, failureReason, proofCode,
    })
    res.json(updated)
  } catch (reason) { sendApiError(res, reason) }
}

// --- Owner dispatch: reissue a proof-of-delivery code ----------------------------------------
//
// For when the original is lost (customer can't find it) or locked out (PROOF_MAX_ATTEMPTS
// exhausted). Manager-only, like assignRider -- not available once the delivery is already
// resolved, since there is nothing left to prove at that point.
async function reissueProof(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const deliveryId = uuidParam(req.params.id, 'Delivery ID')
    const client = await db.connect()
    try {
      await client.query('begin')
      const current = await client.query<{ status: DeliveryStatus }>(
        'select status from public.delivery_orders where store_id=$1 and id=$2 for update',
        [storeId, deliveryId],
      )
      if (!current.rows[0]) throw new ApiError(404, 'not_found', 'Delivery not found in this store.')
      if (current.rows[0].status === 'delivered' || current.rows[0].status === 'failed') {
        throw new ApiError(409, 'invalid_transition', `Cannot reissue a proof code for a delivery that is already ${current.rows[0].status}.`)
      }
      const proofCode = await issueDeliveryProof(client, storeId, deliveryId)
      await client.query('commit')
      res.status(201).json({ proof_code: proofCode })
    } catch (reason) { await client.query('rollback').catch(() => undefined); throw reason }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
}

deliveryRouter.get('/', listDispatch)
deliveryRouter.get('/kpis', dispatchKpis)
deliveryRouter.get('/:id/events', statusTimeline)
deliveryRouter.post('/:id/proof/reissue', reissueProof)
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
    const rows = await db.query<DispatchRow>(
      `select ${DELIVERY_COLUMNS_D},
              po.receipt_number, po.order_type, kt.status as kitchen_status
       from public.delivery_orders d
       join public.pos_orders po on po.store_id = d.store_id and po.id = d.order_id
       left join public.kitchen_tickets kt on kt.store_id = d.store_id and kt.order_id = d.order_id
       where d.store_id = $1 and d.rider_id = $2
         and (d.status not in ('delivered','failed') or d.updated_at > now() - interval '1 day')
       order by d.created_at asc`,
      [session.storeId, session.employeeId],
    )
    const eta = await loadEtaBasis(session.storeId)
    res.json({ deliveries: withDispatchDerivedFields(rows.rows, eta) })
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
    const { expectedStatus, toStatus, operationId, failureReason, proofCode } = transitionBody(req)
    const updated = await applyDeliveryTransition({
      storeId: session.storeId, deliveryId, expectedStatus, toStatus, operationId,
      actorType: 'rider', actorId: session.employeeId, requireRiderId: session.employeeId, failureReason, proofCode,
    })
    res.json(updated)
  } catch (reason) { sendApiError(res, reason) }
}

terminalDeliveryRouter.get('/mine', myDeliveries)
terminalDeliveryRouter.patch('/:id/status', riderTransition)
