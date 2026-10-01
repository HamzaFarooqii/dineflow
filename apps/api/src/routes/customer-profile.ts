import { Router, type Request, type Response } from 'express'
import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { requireCashierCapability } from '../terminal-auth/routes.js'
import { customerName, normalizedPhone } from '../../../../packages/domain/src/customer.js'
import { ApiError, requireStoreManager, sendApiError } from './auth.js'

// CRM completion (B3): edit, deactivate/reactivate, merge, favorites/preferences.
// Mounted alongside customers.ts's routers at the same '/customers' and '/pos/customers' prefixes
// (a sibling file, not an addition to customers.ts, because customers.ts is the create/search/sync
// surface and this file is the management-only surface -- everything here except the read-only
// preference summary requires requireStoreManager, matching purchasing.ts's convention).
export const customerProfileRouter = Router()
export const terminalCustomerProfileRouter = Router()

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ApiError(422, 'validation_failed', `${label} must be a UUID.`)
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'validation_failed', 'A JSON object is required.')
  return value as Record<string, unknown>
}
function phone(value: unknown): string | null {
  try { return normalizedPhone(value) }
  catch (reason) { throw new ApiError(422, 'validation_failed', reason instanceof Error ? reason.message : 'Invalid phone.') }
}
function name(value: unknown): string {
  try { return customerName(value) }
  catch (reason) { throw new ApiError(422, 'validation_failed', reason instanceof Error ? reason.message : 'Invalid name.') }
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new ApiError(422, 'validation_failed', `${label} is required.`)
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > max) throw new ApiError(422, 'validation_failed', `${label} must be 1 to ${max} characters.`)
  return trimmed
}
function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  const trimmed = String(value).trim()
  if (trimmed.length > max) throw new ApiError(422, 'validation_failed', `${label} must be ${max} characters or fewer.`)
  return trimmed || null
}
function storeIdQuery(req: Request): string { return validUuid(req.query.store_id, 'Store ID') }

async function requireManager(req: Request, storeId: string): Promise<string> {
  return requireStoreManager(req, storeId)
}

interface CustomerRow {
  id: string; store_id: string; name: string; phone_normalized: string | null; active: boolean
  client_generated_at: string; server_received_at: string; updated_at: string
}

async function loadCustomer(storeId: string, customerId: string, client: PoolClient | typeof db = db): Promise<CustomerRow> {
  const result = await client.query<CustomerRow>('select * from public.pos_customers where store_id=$1 and id=$2', [storeId, customerId])
  if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Guest not found.')
  return result.rows[0]
}

// --- Read one profile (so the web UI can show the true current active/deactivated status) -----

async function getCustomer(req: Request, res: Response) {
  try {
    const storeId = storeIdQuery(req)
    await requireManager(req, storeId)
    const customerId = validUuid(req.params.id, 'Customer ID')
    res.json(await loadCustomer(storeId, customerId))
  } catch (reason) { sendApiError(res, reason) }
}

// --- Edit name/phone -------------------------------------------------------------------------

async function updateCustomer(req: Request, res: Response) {
  try {
    const storeId = storeIdQuery(req)
    await requireManager(req, storeId)
    const customerId = validUuid(req.params.id, 'Customer ID')
    const body = object(req.body)
    const updates: string[] = []
    const values: unknown[] = []
    let index = 1
    if (body.name !== undefined) { updates.push(`name=$${index++}`); values.push(name(body.name)) }
    if (body.phone_normalized !== undefined) { updates.push(`phone_normalized=$${index++}`); values.push(body.phone_normalized === null ? null : phone(body.phone_normalized)) }
    if (!updates.length) throw new ApiError(422, 'validation_failed', 'Nothing to update.')
    updates.push('updated_at=now()')
    values.push(customerId, storeId)
    const result = await db.query<CustomerRow>(
      `update public.pos_customers set ${updates.join(', ')} where id=$${index++} and store_id=$${index} returning *`,
      values,
    )
    if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Guest not found.')
    res.json(result.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

// --- Deactivate / reactivate (soft delete only -- never a hard delete) -----------------------

async function setActive(req: Request, res: Response, active: boolean) {
  try {
    const storeId = storeIdQuery(req)
    await requireManager(req, storeId)
    const customerId = validUuid(req.params.id, 'Customer ID')
    const result = await db.query<CustomerRow>(
      'update public.pos_customers set active=$1, updated_at=now() where id=$2 and store_id=$3 returning *',
      [active, customerId, storeId],
    )
    if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Guest not found.')
    res.json(result.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

// --- Favorites / preferences (append-only, author-attributed) ----------------------------------

interface PreferenceEventRow {
  id: string; store_id: string; customer_id: string; kind: 'favorite' | 'preference'
  label: string; note: string | null; action: 'add' | 'remove'
  created_by_user_id: string | null; created_at: string
}

export async function loadPreferenceState(storeId: string, customerId: string) {
  const history = await db.query<PreferenceEventRow>(
    `select * from public.customer_preference_events where store_id=$1 and customer_id=$2 order by created_at desc`,
    [storeId, customerId],
  )
  // Current state = the latest event per (kind, label); only entries whose latest event is
  // still 'add' are currently active -- a later 'remove' retires an entry without erasing it.
  // history is newest-first, so the first row seen per (kind, label) is the latest.
  const seen = new Set<string>()
  const currentEntries = history.rows.filter(row => {
    const key = `${row.kind}:${row.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return row.action === 'add'
  })
  return { current: currentEntries, history: history.rows }
}

async function listPreferences(req: Request, res: Response, terminal = false) {
  try {
    const storeId = terminal ? (await requireCashierCapability(req, db, 'register')).storeId : storeIdQuery(req)
    if (!terminal) await requireManager(req, storeId)
    const customerId = validUuid(req.params.id, 'Customer ID')
    await loadCustomer(storeId, customerId)
    const { current, history } = await loadPreferenceState(storeId, customerId)
    res.json({ current, history: terminal ? [] : history })
  } catch (reason) { sendApiError(res, reason) }
}

async function addPreference(req: Request, res: Response) {
  try {
    const storeId = storeIdQuery(req)
    const actorUserId = await requireManager(req, storeId)
    const customerId = validUuid(req.params.id, 'Customer ID')
    await loadCustomer(storeId, customerId)
    const body = object(req.body)
    const kind = body.kind === 'favorite' || body.kind === 'preference' ? body.kind : null
    if (!kind) throw new ApiError(422, 'validation_failed', 'kind must be "favorite" or "preference".')
    const label = text(body.label, 'Label', 120)
    const note = optionalText(body.note, 'Note', 500)
    const result = await db.query<PreferenceEventRow>(
      `insert into public.customer_preference_events(store_id,customer_id,kind,label,note,action,created_by_user_id)
       values ($1,$2,$3,$4,$5,'add',$6) returning *`,
      [storeId, customerId, kind, label, note, actorUserId],
    )
    res.status(201).json(result.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

async function removePreference(req: Request, res: Response) {
  try {
    const storeId = storeIdQuery(req)
    const actorUserId = await requireManager(req, storeId)
    const customerId = validUuid(req.params.id, 'Customer ID')
    await loadCustomer(storeId, customerId)
    const body = object(req.body)
    const kind = body.kind === 'favorite' || body.kind === 'preference' ? body.kind : null
    if (!kind) throw new ApiError(422, 'validation_failed', 'kind must be "favorite" or "preference".')
    const label = text(body.label, 'Label', 120)
    const result = await db.query<PreferenceEventRow>(
      `insert into public.customer_preference_events(store_id,customer_id,kind,label,note,action,created_by_user_id)
       values ($1,$2,$3,$4,$5,'remove',$6) returning *`,
      [storeId, customerId, kind, label, optionalText(body.note, 'Note', 500), actorUserId],
    )
    res.status(201).json(result.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

// --- Merge -------------------------------------------------------------------------------------
// Owner/manager-only endpoint on the (online, Supabase-authenticated) management router only --
// it is never exposed on terminalCustomerProfileRouter, so an offline terminal session can never
// trigger it. requireStoreManager itself calls the Supabase auth API to validate the bearer
// token, so a merge additionally can't proceed without a live network round-trip -- there is no
// cached/offline credential path for it, unlike terminal device sessions.

interface MergeRow {
  id: string; store_id: string; source_customer_id: string; target_customer_id: string
  actor_user_id: string; reason: string; created_at: string
}

// Core merge transaction, exported so it's directly testable against PGlite without going
// through express/Supabase auth -- mirrors purchasing.ts's receivePurchaseOrderCore split.
export async function mergeCustomersCore(client: PoolClient, storeId: string, sourceId: string, targetId: string, actorUserId: string, reason: string): Promise<MergeRow> {
    if (sourceId === targetId) throw new ApiError(422, 'validation_failed', 'A guest cannot be merged into itself.')
    // Lock both profiles so a concurrent merge/edit can't race the balance and order moves below.
    const rows = await client.query<CustomerRow>(
      'select * from public.pos_customers where store_id=$1 and id in ($2,$3) for update',
      [storeId, sourceId, targetId],
    )
    const source = rows.rows.find(row => row.id === sourceId)
    const target = rows.rows.find(row => row.id === targetId)
    if (!source || !target) throw new ApiError(404, 'not_found', 'Both guests must belong to this store.')
    if (!target.active) throw new ApiError(409, 'invalid_merge_target', 'The target guest profile is deactivated. Reactivate it, or choose a different target.')

    // A guest can be a *source* only once (enforced below); it also must never be used as a
    // *target* once it has itself been merged away, or balance/orders would land on a dead-end
    // profile with no further recovery path.
    const existingMerge = await client.query(
      'select source_customer_id from public.customer_merges where store_id=$1 and source_customer_id in ($2,$3)',
      [storeId, sourceId, targetId],
    )
    if (existingMerge.rows.some(row => row.source_customer_id === sourceId)) throw new ApiError(409, 'already_merged', 'This guest has already been merged into another profile.')
    if (existingMerge.rows.some(row => row.source_customer_id === targetId)) throw new ApiError(409, 'invalid_merge_target', 'The target guest has itself already been merged into another profile. Merge into that profile instead.')

    const merge = await client.query<MergeRow>(
      `insert into public.customer_merges(store_id,source_customer_id,target_customer_id,actor_user_id,reason)
       values ($1,$2,$3,$4,$5) returning *`,
      [storeId, sourceId, targetId, actorUserId, reason],
    )

    // Move the loyalty ledger balance, exactly once (the unique (store_id, source_customer_id)
    // constraint on customer_merges above is what makes a second attempt impossible).
    const sourceAccount = await client.query<{ id: string; points_balance: number; lifetime_points: number }>(
      'select id,points_balance,lifetime_points from public.loyalty_accounts where store_id=$1 and customer_id=$2 for update',
      [storeId, sourceId],
    )
    if (sourceAccount.rows[0] && (sourceAccount.rows[0].points_balance > 0 || sourceAccount.rows[0].lifetime_points > 0)) {
      const src = sourceAccount.rows[0]
      let targetAccount = await client.query<{ id: string }>(
        'select id from public.loyalty_accounts where store_id=$1 and customer_id=$2 for update',
        [storeId, targetId],
      )
      if (!targetAccount.rows[0]) {
        targetAccount = await client.query<{ id: string }>(
          'insert into public.loyalty_accounts(store_id,customer_id) values ($1,$2) returning id',
          [storeId, targetId],
        )
      }
      const targetAccountId = targetAccount.rows[0].id
      await client.query(
        'update public.loyalty_accounts set points_balance=points_balance+$1, lifetime_points=lifetime_points+$2 where store_id=$3 and id=$4',
        [src.points_balance, src.lifetime_points, storeId, targetAccountId],
      )
      await client.query(
        `insert into public.loyalty_point_ledger(store_id,account_id,delta,reason,created_by_user_id) values ($1,$2,$3,'adjustment',$4)`,
        [storeId, targetAccountId, src.points_balance, actorUserId],
      )
      await client.query('update public.loyalty_accounts set points_balance=0, lifetime_points=0 where store_id=$1 and id=$2', [storeId, src.id])
      await client.query(
        `insert into public.loyalty_point_ledger(store_id,account_id,delta,reason,created_by_user_id) values ($1,$2,$3,'adjustment',$4)`,
        [storeId, src.id, -src.points_balance, actorUserId],
      )
    }

    // Move order associations, exactly once (no row can match customer_id=source after this).
    await client.query('update public.pos_orders set customer_id=$1 where store_id=$2 and customer_id=$3', [targetId, storeId, sourceId])

    // Carry the source guest's still-current favorites/preferences onto the target as new,
    // actor-attributed 'add' events -- the original events on the source stay untouched (this is
    // an append, not a move, preserving the immutable history on both profiles) and an entry the
    // target already has isn't duplicated.
    const sourcePreferences = await client.query<{ kind: 'favorite' | 'preference'; label: string; note: string | null }>(
      `select kind,label,note from (
         select distinct on (kind,label) kind,label,note,action from public.customer_preference_events
         where store_id=$1 and customer_id=$2 order by kind,label,created_at desc
       ) latest where action='add'`,
      [storeId, sourceId],
    )
    const targetPreferences = await client.query<{ kind: string; label: string }>(
      `select distinct on (kind,label) kind,label from public.customer_preference_events
       where store_id=$1 and customer_id=$2 order by kind,label,created_at desc`,
      [storeId, targetId],
    )
    const targetCurrent = new Set(targetPreferences.rows.map(row => `${row.kind}:${row.label}`))
    for (const entry of sourcePreferences.rows) {
      if (targetCurrent.has(`${entry.kind}:${entry.label}`)) continue
      await client.query(
        `insert into public.customer_preference_events(store_id,customer_id,kind,label,note,action,created_by_user_id)
         values ($1,$2,$3,$4,$5,'add',$6)`,
        [storeId, targetId, entry.kind, entry.label, entry.note, actorUserId],
      )
    }

    // The source profile is retired, never deleted -- its order/loyalty history stays intact.
    await client.query('update public.pos_customers set active=false, updated_at=now() where store_id=$1 and id=$2', [storeId, sourceId])

    return merge.rows[0]
}

async function mergeCustomers(req: Request, res: Response) {
  const client = await db.connect()
  try {
    const storeId = storeIdQuery(req)
    const actorUserId = await requireManager(req, storeId)
    const body = object(req.body)
    const sourceId = validUuid(body.source_customer_id, 'source_customer_id')
    const targetId = validUuid(body.target_customer_id, 'target_customer_id')
    const reason = text(body.reason, 'Merge reason', 500)
    await client.query('begin')
    const merge = await mergeCustomersCore(client, storeId, sourceId, targetId, actorUserId, reason)
    await client.query('commit')
    res.status(201).json(merge)
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    sendApiError(res, reason)
  } finally { client.release() }
}

customerProfileRouter.get('/:id', (req, res) => void getCustomer(req, res))
customerProfileRouter.patch('/:id', (req, res) => void updateCustomer(req, res))
customerProfileRouter.post('/:id/deactivate', (req, res) => void setActive(req, res, false))
customerProfileRouter.post('/:id/reactivate', (req, res) => void setActive(req, res, true))
customerProfileRouter.get('/:id/preferences', (req, res) => void listPreferences(req, res))
customerProfileRouter.post('/:id/preferences', (req, res) => void addPreference(req, res))
customerProfileRouter.post('/:id/preferences/remove', (req, res) => void removePreference(req, res))
customerProfileRouter.post('/merge', (req, res) => void mergeCustomers(req, res))

// Terminal (offline-capable POS) surface: read-only compact summary for the guest picker only.
// Deliberately no merge, edit, deactivate, or write route here -- see mergeCustomers's comment.
terminalCustomerProfileRouter.get('/:id/preferences', (req, res) => void listPreferences(req, res, true))
