import { createHash } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireCashierTerminal, requireDeviceTerminal } from '../terminal-auth/routes.js'
import { customerName, normalizedPhone } from '../../../../packages/domain/src/customer.js'
import { ApiError, requireStoreMember, sendApiError } from './auth.js'

export const customersRouter = Router()
export const terminalCustomersRouter = Router()
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
function storedPhone(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !/^[1-9][0-9]{3,14}$/.test(value)) throw new ApiError(422, 'validation_failed', 'Normalized phone must be 4 to 15 international digits.')
  return value
}
function name(value: unknown): string {
  try { return customerName(value) }
  catch (reason) { throw new ApiError(422, 'validation_failed', reason instanceof Error ? reason.message : 'Invalid name.') }
}
function nameSearchTerm(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  if (!text) return null
  if (text.length > 30) throw new ApiError(422, 'validation_failed', 'Name search must be 30 characters or fewer.')
  return text
}
function iso(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new ApiError(422, 'validation_failed', 'Creation time must be a UTC ISO timestamp.')
  return value
}
function parseCreate(raw: unknown) {
  const operation = object(raw), customer = object(operation.customer)
  if (operation.entity_type !== 'customer' || operation.schema_version !== 1) throw new ApiError(422, 'validation_failed', 'Customer operation version is invalid.')
  const operationId = validUuid(operation.operation_id, 'Operation ID')
  return { operationId, customer: { id: validUuid(customer.id, 'Customer ID'), storeId: validUuid(customer.store_id, 'Store ID'),
    name: name(customer.name), phone: storedPhone(customer.phone_normalized), generatedAt: iso(customer.client_generated_at) } }
}
async function ownerStore(req: Request, storeId: string): Promise<void> {
  const userId = await requireStoreMember(req, storeId)
  const result = await db.query<{ role: string }>('select role from public.store_memberships where store_id=$1 and user_id=$2 and active=true', [storeId, userId])
  if (!['owner', 'manager'].includes(result.rows[0]?.role ?? '')) throw new ApiError(403, 'authorization_failed', 'Management customer access is required.')
}
function cursor(value: unknown): { id: string } | null {
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length > 160) throw new ApiError(400, 'validation_failed', 'Invalid customer cursor.')
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw new ApiError(400, 'validation_failed', 'Invalid customer cursor.') }
  const row = object(parsed)
  return { id: validUuid(row.id, 'Cursor ID') }
}
async function search(req: Request, res: Response, terminal = false) {
  try {
    const storeId = terminal ? (await requireCashierTerminal(req, db)).storeId : validUuid(req.query.store_id, 'Store ID')
    if (!terminal) await ownerStore(req, storeId)
    if (terminal && req.query.store_id !== undefined && req.query.store_id !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    const phoneTerm = phone(req.query.phone)
    const nameTerm = nameSearchTerm(req.query.name)
    if (!phoneTerm && !nameTerm) throw new ApiError(400, 'search_required', 'Enter a phone number or a guest name to search.')
    const rawLimit = req.query.limit === undefined ? 20 : Number(req.query.limit)
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) throw new ApiError(400, 'validation_failed', 'Limit must be 1 to 50.')
    const after = cursor(req.query.cursor)
    // Escape name search's own wildcard characters so a guest named e.g. "50% Off" can't turn
    // into an unintended ILIKE pattern -- phone search has no such characters to worry about.
    const namePattern = nameTerm ? `${nameTerm.replace(/[%_\\]/g, char => `\\${char}`)}%` : null
    const result = phoneTerm
      ? await db.query<{ id: string; name: string; phone_normalized: string | null }>(`
          select id,name,phone_normalized from public.pos_customers
          where store_id=$1 and phone_normalized like $2 and ($3::uuid is null or id > $3::uuid)
          order by id limit $4`, [storeId, `${phoneTerm}%`, after?.id ?? null, rawLimit + 1])
      : await db.query<{ id: string; name: string; phone_normalized: string | null }>(`
          select id,name,phone_normalized from public.pos_customers
          where store_id=$1 and name ilike $2 and ($3::uuid is null or id > $3::uuid)
          order by id limit $4`, [storeId, namePattern, after?.id ?? null, rawLimit + 1])
    const page = result.rows.slice(0, rawLimit)
    const last = page.at(-1)
    res.json({ customers: page.map(({ id, name: customerName, phone_normalized }) => ({ id, store_id: storeId, name: customerName, phone_normalized })),
      next_cursor: result.rows.length > rawLimit && last ? Buffer.from(JSON.stringify({ id: last.id })).toString('base64url') : null })
  } catch (reason) { sendApiError(res, reason) }
}
async function push(req: Request, res: Response, terminal = false) {
  try {
    const input = parseCreate(req.body)
    const storeId = terminal ? (await requireDeviceTerminal(req, db)).storeId : input.customer.storeId
    if (storeId !== input.customer.storeId) throw new ApiError(403, 'cross_store_reference', 'Customer belongs to a different store.')
    if (!terminal) await ownerStore(req, storeId)
    const canonical = { operation_id: input.operationId, entity_type: 'customer', schema_version: 1, customer: input.customer }
    const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query('insert into public.pos_sync_feed_state(store_id) values ($1) on conflict do nothing', [storeId])
      await client.query('select last_position from public.pos_sync_feed_state where store_id=$1 for update', [storeId])
      const replay = await client.query('select entity_type,payload_hash,result_json from public.pos_operation_ledger where store_id=$1 and operation_id=$2', [storeId, input.operationId])
      if (replay.rows[0]) {
        if (replay.rows[0].entity_type !== 'customer' || replay.rows[0].payload_hash !== hash) throw new ApiError(409, 'operation_id_conflict', 'This operation ID has different content.')
        await client.query('commit')
        res.json({ ...replay.rows[0].result_json, status: 'replayed' })
        return
      }
      // Idempotency: if the same UUID already exists for the same store, treat as a successful replay.
      // This happens when the client retries a push that previously timed-out or was partially committed.
      const existing = await client.query<{ store_id: string }>(
        'select store_id from public.pos_customers where id=$1',
        [input.customer.id]
      )
      if (existing.rows[0]) {
        if (existing.rows[0].store_id !== storeId)
          throw new ApiError(409, 'customer_id_conflict', 'This customer ID exists in a different store.')
        // Same store — treat as idempotent success so dependent orders can proceed
        await client.query('commit')
        const cp = await db.query<{ pos: string }>(
          'select last_position::text as pos from public.pos_sync_feed_state where store_id=$1',
          [storeId]
        )
        res.json({ status: 'replayed', operation_id: input.operationId,
          customer_id: input.customer.id,
          accepted_checkpoint: cp.rows[0]?.pos ?? '0' })
        return
      }
      await client.query(`insert into public.pos_customers(id,store_id,name,phone_normalized,client_generated_at)
        values ($1,$2,$3,$4,$5)`, [input.customer.id, storeId, input.customer.name, input.customer.phone, input.customer.generatedAt])
      const position = (BigInt((await client.query('select last_position::text from public.pos_sync_feed_state where store_id=$1', [storeId])).rows[0].last_position) + 1n).toString()
      await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
        values ($1,$2,'customer',$3,$4)`, [storeId, position, input.customer.id,
        { id: input.customer.id, store_id: storeId, name: input.customer.name, phone_normalized: input.customer.phone }])
      await client.query('update public.pos_sync_feed_state set last_position=$2 where store_id=$1', [storeId, position])
      const result = { status: 'accepted', operation_id: input.operationId, customer_id: input.customer.id, accepted_checkpoint: position }
      await client.query(`insert into public.pos_operation_ledger(store_id,operation_id,entity_type,payload_hash,status,result_json,accepted_checkpoint)
        values ($1,$2,'customer',$3,'accepted',$4,$5)`, [storeId, input.operationId, hash, result, position])
      await client.query('commit')
      res.json(result)
    } catch (reason) {
      await client.query('rollback')
      if (typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === '23505') {
        throw new ApiError(409, 'customer_id_conflict', 'A customer or operation already uses this identity.')
      }
      throw reason
    }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
}
export interface CustomerSummary {
  customer_id: string
  visit_count: number
  lifetime_spend_cents: number
  recent_visits: Array<{ order_id: string; total_cents: number; visited_at: string }>
}

// Visit history + lifetime spend for a guest, computed on read from pos_orders
// (docs/day-plans/day4.md, Bisma's half: "aggregated from the existing pos_orders table ... don't
// add a duplicate running-total column"). Same reasoning as reports.ts's loadDailySummary
// deriving totals from source rows rather than trusting a cached counter. Exported so it's
// directly testable against PGlite, mirroring loadDailySummary's own test.
export async function loadCustomerSummary(storeId: string, customerId: string): Promise<CustomerSummary> {
  // Refunded orders are excluded, same convention as floor.ts's current-order lookup and
  // reports.ts's loadDailySummary -- pos_orders.total_cents stays at the original charged
  // amount even after a full refund, so a refunded visit must not count toward guest value.
  const notRefunded = `not exists (select 1 from public.pos_refunds pr where pr.store_id = po.store_id and pr.order_id = po.id)`
  const [totals, visits] = await Promise.all([
    db.query<{ visit_count: string; lifetime_spend_cents: string }>(
      `select count(*)::text as visit_count, coalesce(sum(total_cents),0)::text as lifetime_spend_cents
       from public.pos_orders po where store_id=$1 and customer_id=$2 and ${notRefunded}`,
      [storeId, customerId],
    ),
    db.query<{ id: string; total_cents: string; client_generated_at: string }>(
      `select id, total_cents::text as total_cents, client_generated_at
       from public.pos_orders po where store_id=$1 and customer_id=$2 and ${notRefunded}
       order by client_generated_at desc limit 10`,
      [storeId, customerId],
    ),
  ])
  return {
    customer_id: customerId,
    visit_count: Number(totals.rows[0]?.visit_count ?? 0),
    lifetime_spend_cents: Number(totals.rows[0]?.lifetime_spend_cents ?? 0),
    recent_visits: visits.rows.map(row => ({ order_id: row.id, total_cents: Number(row.total_cents), visited_at: row.client_generated_at })),
  }
}

async function summary(req: Request, res: Response, terminal = false) {
  try {
    const storeId = terminal ? (await requireCashierTerminal(req, db)).storeId : validUuid(req.query.store_id, 'Store ID')
    if (!terminal) await ownerStore(req, storeId)
    const customerId = validUuid(req.params.id, 'Customer ID')
    res.json(await loadCustomerSummary(storeId, customerId))
  } catch (reason) { sendApiError(res, reason) }
}

customersRouter.get('/', (req, res) => void search(req, res))
customersRouter.post('/push', (req, res) => void push(req, res))
customersRouter.get('/:id/summary', (req, res) => void summary(req, res))
terminalCustomersRouter.get('/', (req, res) => void search(req, res, true))
terminalCustomersRouter.post('/push', (req, res) => void push(req, res, true))
terminalCustomersRouter.get('/:id/summary', (req, res) => void summary(req, res, true))
