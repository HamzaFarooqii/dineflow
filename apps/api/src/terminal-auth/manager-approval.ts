import { createHash } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import type { Pool } from 'pg'
import { db } from '../db.js'
import { ApiError, sendApiError } from '../routes/auth.js'
import { requireCashierTerminal } from './routes.js'
import { digest, pinValue, string, token, uuid, verify } from './security.js'

// Canonical hash of "the exact relevant payload" an approval is bound to. Callers on both sides
// (requesting an approval, and later redeeming it) build the SAME plain object -- e.g.
// `{ ingredient_id, quantity, cost_per_unit_cents }` -- and this hashes its JSON serialization.
// Never a client-supplied hash: both requestManagerApproval and consumeManagerApproval compute it
// themselves from data they each already hold, so a client can't approve one payload and redeem
// the token against a different one by simply sending whatever hash it likes.
export function hashApprovalPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex')
}

// Online, server-verified replacement for trusting a client-supplied manager_id +
// manager_approved_at timestamp (the gap this file closes -- see inventory.ts's old
// requireTerminalWriter and open-checks.ts's manager_id checks, which only ever confirmed "this
// id belongs to an active manager", never that a PIN was actually entered for *this* action).
//
// Flow: a manager types their own PIN on the terminal, without switching the active cashier
// session (POST here), verified against the exact PBKDF2 primitive terminal-auth/routes.ts's own
// /auth/login already uses. A single-use, short-lived token comes back, bound to this store,
// device, a named action, and a hash of the exact payload being approved -- consumeManagerApproval
// (below) is how a route redeems it. The PIN itself is never logged or stored; only a hash of the
// random token is kept (terminal-auth/security.ts's own digest/token primitives, same as every
// other terminal credential in this schema).
//
// This is explicitly the ONLINE approval path. A queued sale that was rung up (and its discount
// approved via the offline-cached PIN verifier) while genuinely offline has no live round-trip
// available to obtain one of these tokens -- see orders.ts's own comment on that narrower,
// documented limitation for the register/checkout path specifically.
export const managerApprovalRouter = Router()

const ACTION_PATTERN = /^[a-z][a-z0-9_.]{2,60}$/
const APPROVAL_TTL_MS = 2 * 60 * 1000

interface ManagerRow { id: string; active: boolean; pin_salt: string; pin_hash: string; failed_attempts: number; locked_until: Date | null }

async function requestManagerApproval(req: Request, res: Response) {
  try {
    const session = await requireCashierTerminal(req, db)
    const body = req.body as Record<string, unknown>
    const managerId = uuid(body.manager_id)
    const pin = pinValue(body.pin)
    const action = string(body.action, 'action', ACTION_PATTERN)
    if (body.payload === undefined) throw new ApiError(422, 'validation_failed', 'payload is required.')
    const payloadHash = hashApprovalPayload(body.payload)

    const client = await db.connect()
    let outcome!: { error: ApiError } | { approvalToken: string; expiresAt: Date }
    try {
      await client.query('begin')
      const manager = await client.query<ManagerRow>(
        `select id, active, pin_salt, pin_hash, failed_attempts, locked_until
         from public.terminal_employees where id=$1 and store_id=$2 and role='manager' for update`,
        [managerId, session.storeId],
      )
      const row = manager.rows[0]
      if (!row?.active) {
        outcome = { error: new ApiError(422, 'validation_failed', 'manager_id must reference an active manager for this store.') }
      } else if (row.locked_until && row.locked_until.getTime() > Date.now()) {
        outcome = { error: new ApiError(429, 'pin_locked', 'Too many attempts. Wait 60 seconds and try again.') }
      } else if (!(await verify(pin, row.pin_salt, row.pin_hash))) {
        await client.query(
          "update public.terminal_employees set locked_until=case when failed_attempts=4 then now()+interval '60 seconds' else locked_until end, failed_attempts=(failed_attempts+1)%5 where id=$1",
          [managerId],
        )
        outcome = { error: new ApiError(row.failed_attempts === 4 ? 429 : 401, 'pin_invalid', 'PIN not accepted. After five attempts, approval is locked for 60 seconds.') }
      } else {
        await client.query('update public.terminal_employees set failed_attempts=0, locked_until=null where id=$1', [managerId])
        const approvalToken = token()
        const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS)
        await client.query(
          `insert into public.terminal_manager_approvals (store_id, device_id, manager_id, action, payload_hash, token_hash, expires_at)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [session.storeId, session.deviceId, managerId, action, payloadHash, digest(approvalToken), expiresAt],
        )
        outcome = { approvalToken, expiresAt }
      }
      await client.query('commit')
    } catch (reason) {
      await client.query('rollback').catch(() => undefined)
      throw reason
    } finally { client.release() }
    if ('error' in outcome) {
      if (outcome.error.status === 429) res.set('Retry-After', '60')
      throw outcome.error
    }
    res.status(201).json({ approval_token: outcome.approvalToken, expires_at: outcome.expiresAt.toISOString() })
  } catch (reason) { sendApiError(res, reason) }
}

managerApprovalRouter.post('/', requestManagerApproval)

// Redeemed by a route that needs a genuine, server-verified manager approval for an online
// privileged action. `action` and `payloadHash` must match exactly what requestManagerApproval was
// called with, and store/device must match the session presenting the token -- a token approved
// for one action/payload on one device can't be replayed anywhere else, and changing the payload
// after approval (a different discount amount, a different quantity) invalidates it, since the
// hash it was issued against no longer matches. Single-use: this marks the row consumed in the
// same statement that reads it, so a retried or replayed redemption of the same token fails even
// if the first attempt's caller never learned whether it had succeeded.
export async function consumeManagerApproval(pool: Pool, params: { storeId: string; deviceId: string; action: string; payload: unknown; token: string }): Promise<string> {
  const result = await pool.query<{ manager_id: string }>(
    `update public.terminal_manager_approvals
     set consumed_at = now()
     where store_id=$1 and token_hash=$2 and device_id=$3 and action=$4 and payload_hash=$5
       and consumed_at is null and expires_at > now()
     returning manager_id`,
    [params.storeId, digest(params.token), params.deviceId, params.action, hashApprovalPayload(params.payload)],
  )
  if (!result.rows[0]) throw new ApiError(422, 'approval_invalid', 'This manager approval is invalid, expired, already used, or does not match this action.')
  return result.rows[0].manager_id
}
