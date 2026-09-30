import { createHash, randomUUID } from 'node:crypto'
import { Router, type Request, type RequestHandler, type Response } from 'express'
import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { ApiError, requireStoreManager, sendApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'
import { digest, token } from '../terminal-auth/security.js'
import { applyTableStatusTransition } from './floor.js'
import { id as uuidValue, record } from './open-checks.js'
import { qrOrderingEnabled, qrSecurityHooks, type QrPublicContext, type QrStaffContext } from './qr-security-hooks.js'
import { calculateDiscountedLine, calculateServiceCharge, MAX_CENTS } from '../../../../packages/domain/src/money.js'

export const publicQrRouter = Router()
export const qrRouter = Router()
export const terminalQrRouter = Router()

export const QR_SESSION_TTL_MINUTES = 120
export const QR_MODES = ['menu_only', 'menu_and_order', 'waiter_only'] as const
export type QrMode = (typeof QR_MODES)[number]
const MAX_LINES = 30
const MAX_QUANTITY = 20
const MAX_MODIFIERS_PER_LINE = 20
const MAX_NOTE = 300
// A session is only ever valid while a party is at the table. Ordering is narrower still: a check
// can only be opened/appended while the table is seated or already ordering (open-checks.ts rule).
const IN_SERVICE_STATUSES = ['seated', 'ordering', 'served', 'bill_requested']
const ORDERING_STATUSES = ['seated', 'ordering']
const CODE_PATTERN = /^[a-f0-9]{64}$/
const UUID_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Queryable = Pick<PoolClient, 'query'>

// --- shared helpers ---------------------------------------------------------------------------

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const result = await work(client)
    await client.query('commit')
    return result
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    throw reason
  } finally { client.release() }
}

function noStore(_req: Request, res: Response, next: () => void) { res.set('Cache-Control', 'no-store'); next() }

function requireFlag(_req: Request, res: Response, next: () => void) {
  if (!qrOrderingEnabled()) {
    res.status(404).json({ status: 'rejected', code: 'feature_disabled', message: 'QR ordering is not available.' })
    return
  }
  next()
}

function guard(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => { handler(req, res).catch(reason => sendApiError(res, reason)) }
}

function checkStoreId(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!UUID_PARAM.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}
function paramId(req: Request, name = 'id'): string {
  const value = String(req.params[name] ?? '')
  if (!UUID_PARAM.test(value)) throw new ApiError(422, 'validation_failed', `A valid ${name} is required.`)
  return value
}

// --- customer session -------------------------------------------------------------------------

export interface QrSession {
  sessionId: string; storeId: string; tableId: string; tableLabel: string; tableStatus: string
  mode: QrMode; requiresConfirmation: boolean; expiresAt: string
}

// Store and table are read from the server-side session row, never from the request.
export async function resolveQrSession(req: Request): Promise<QrSession> {
  const header = req.headers.authorization ?? ''
  const value = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!CODE_PATTERN.test(value)) throw new ApiError(401, 'session_invalid', 'Scan the QR code on your table to start.')
  const result = await db.query<{
    id: string; store_id: string; table_id: string; session_generation: number; expires_at: Date; expired: boolean; revoked_at: Date | null
    label: string; status: string; active: boolean; qr_code_hash: string | null; table_generation: number; qr_mode: QrMode; qr_require_confirmation: boolean
  }>(
    `select s.id, s.store_id, s.table_id, s.qr_generation as session_generation, s.expires_at, s.expires_at <= now() as expired, s.revoked_at,
            t.label, t.status, t.active, t.qr_code_hash, t.qr_generation as table_generation, t.qr_mode, t.qr_require_confirmation
     from public.qr_sessions s
     join public.restaurant_tables t on t.store_id = s.store_id and t.id = s.table_id
     where s.token_hash = $1`,
    [digest(value)],
  )
  const row = result.rows[0]
  if (!row) throw new ApiError(401, 'session_invalid', 'Scan the QR code on your table to start.')
  if (row.expired) throw new ApiError(401, 'session_expired', 'Your session expired. Scan the QR code on your table again.')
  if (row.revoked_at || !row.qr_code_hash || row.session_generation !== row.table_generation || !row.active || !IN_SERVICE_STATUSES.includes(row.status)) {
    throw new ApiError(401, 'session_revoked', 'This table session has ended. Scan the QR code on your table again.')
  }
  return {
    sessionId: row.id, storeId: row.store_id, tableId: row.table_id, tableLabel: row.label, tableStatus: row.status,
    mode: row.qr_mode, requiresConfirmation: row.qr_require_confirmation, expiresAt: new Date(row.expires_at).toISOString(),
  }
}

function publicContext(req: Request, session: QrSession | null): QrPublicContext {
  return { req, storeId: session?.storeId ?? null, tableId: session?.tableId ?? null, sessionId: session?.sessionId ?? null }
}

export async function issueQrSession(code: string) {
  const table = await db.query<{
    id: string; store_id: string; label: string; status: string; active: boolean; qr_generation: number; qr_mode: QrMode; qr_require_confirmation: boolean
    store_name: string; currency: string
  }>(
    `select t.id, t.store_id, t.label, t.status, t.active, t.qr_generation, t.qr_mode, t.qr_require_confirmation, s.name as store_name, s.currency
     from public.restaurant_tables t join public.stores s on s.id = t.store_id
     where t.qr_code_hash = $1`,
    [digest(code)],
  )
  const row = table.rows[0]
  if (!row) throw new ApiError(404, 'qr_invalid', 'This QR code is not valid. Ask staff for help.')
  if (!row.active || !IN_SERVICE_STATUSES.includes(row.status)) {
    throw new ApiError(409, 'table_not_in_service', 'This table is not ready yet. Please ask a member of staff to seat you.')
  }
  const sessionToken = token()
  const inserted = await db.query<{ expires_at: Date }>(
    `insert into public.qr_sessions(store_id, table_id, token_hash, qr_generation, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval) returning expires_at`,
    [row.store_id, row.id, digest(sessionToken), row.qr_generation, String(QR_SESSION_TTL_MINUTES)],
  )
  return {
    session_token: sessionToken, expires_at: new Date(inserted.rows[0].expires_at).toISOString(),
    store_name: row.store_name, currency: row.currency, table_label: row.label, mode: row.qr_mode,
    requires_confirmation: row.qr_require_confirmation,
  }
}

// --- public menu projection -------------------------------------------------------------------

const PRODUCT_ELIGIBLE_SQL = `p.active = true and p.is_available = true
  and (p.unavailable_until is null or p.unavailable_until <= now()) and p.sells_directly = true`

export async function loadPublicMenu(storeId: string) {
  const [categories, products, groups] = await Promise.all([
    db.query<{ id: string; name: string }>('select id, name from public.pos_categories where store_id=$1 and active=true order by name', [storeId]),
    db.query<{ id: string; name: string; category_id: string | null; unit_price_cents: string; image_url: string | null }>(
      `select p.id, p.name, p.category_id, p.unit_price_cents::text, p.image_url
       from public.pos_products p
       where p.store_id = $1 and ${PRODUCT_ELIGIBLE_SQL}
         and not exists (select 1 from public.combos c where c.store_id = p.store_id and c.product_id = p.id)
       order by p.name`, [storeId]),
    db.query<{ product_id: string; group_id: string; group_name: string; selection: 'single' | 'multi'; required: boolean; option_id: string | null; option_name: string | null; price_delta_cents: number | null }>(
      `select pmg.product_id, mg.id as group_id, mg.name as group_name, mg.selection, mg.required,
              mo.id as option_id, mo.name as option_name, mo.price_delta_cents
       from public.product_modifier_groups pmg
       join public.modifier_groups mg on mg.store_id = pmg.store_id and mg.id = pmg.group_id
       left join public.modifier_options mo on mo.store_id = mg.store_id and mo.group_id = mg.id and mo.active = true
       where pmg.store_id = $1 order by pmg.sort_order, mg.name, mo.name`, [storeId]),
  ])
  type Group = { id: string; name: string; selection: 'single' | 'multi'; required: boolean; options: { id: string; name: string; price_delta_cents: number }[] }
  const groupsByProduct = new Map<string, Map<string, Group>>()
  for (const row of groups.rows) {
    const perProduct = groupsByProduct.get(row.product_id) ?? new Map<string, Group>()
    const group = perProduct.get(row.group_id) ?? { id: row.group_id, name: row.group_name, selection: row.selection, required: row.required, options: [] }
    if (row.option_id) group.options.push({ id: row.option_id, name: row.option_name as string, price_delta_cents: row.price_delta_cents as number })
    perProduct.set(row.group_id, group)
    groupsByProduct.set(row.product_id, perProduct)
  }
  const shaped = products.rows.map(product => ({
    id: product.id, name: product.name, category_id: product.category_id, price_cents: Number(product.unit_price_cents),
    image_url: product.image_url, modifier_groups: [...(groupsByProduct.get(product.id)?.values() ?? [])],
  // A required group with no active option can never be satisfied, so the dish is not orderable.
  })).filter(product => !product.modifier_groups.some(group => group.required && group.options.length === 0))
    .map(product => ({ ...product, modifier_groups: product.modifier_groups.filter(group => group.options.length > 0) }))
  return { categories: categories.rows, products: shaped }
}

// --- submission parsing and server-side pricing -----------------------------------------------

export interface SubmittedItem { product_id: string; quantity: number; modifier_option_ids: string[] }
export interface ParsedSubmission { operationId: string; items: SubmittedItem[]; note: string | null; payloadHash: string }

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const extra = Object.keys(value).filter(key => !allowed.includes(key))
  if (extra.length) throw new ApiError(422, 'forbidden_field', `${label} cannot include ${extra.slice(0, 3).join(', ')}. Prices, taxes, discounts and approvals are set by the restaurant.`)
}

export function parseSubmission(raw: unknown): ParsedSubmission {
  const body = record(raw, 'Order')
  exactKeys(body, ['operation_id', 'items', 'note'], 'An order')
  const operationId = uuidValue(body.operation_id, 'Operation ID')
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_LINES) {
    throw new ApiError(422, 'validation_failed', `An order needs 1 to ${MAX_LINES} items.`)
  }
  const items = body.items.map((rawItem, index) => {
    const item = record(rawItem, `Item ${index + 1}`)
    exactKeys(item, ['product_id', 'quantity', 'modifier_option_ids'], `Item ${index + 1}`)
    if (!Number.isSafeInteger(item.quantity) || (item.quantity as number) < 1 || (item.quantity as number) > MAX_QUANTITY) {
      throw new ApiError(422, 'validation_failed', `Item ${index + 1} quantity must be 1 to ${MAX_QUANTITY}.`)
    }
    const rawOptions = item.modifier_option_ids ?? []
    if (!Array.isArray(rawOptions) || rawOptions.length > MAX_MODIFIERS_PER_LINE) throw new ApiError(422, 'validation_failed', `Item ${index + 1} options are invalid.`)
    const options = rawOptions.map(option => uuidValue(option, `Item ${index + 1} option`))
    if (new Set(options).size !== options.length) throw new ApiError(422, 'validation_failed', `Item ${index + 1} repeats an option.`)
    return { product_id: uuidValue(item.product_id, `Item ${index + 1} product`), quantity: item.quantity as number, modifier_option_ids: options.sort() }
  })
  let note: string | null = null
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > MAX_NOTE) throw new ApiError(422, 'validation_failed', `Note must be text up to ${MAX_NOTE} characters.`)
    note = body.note.trim() || null
  }
  const payloadHash = createHash('sha256').update(JSON.stringify({ items, note })).digest('hex')
  return { operationId, items, note, payloadHash }
}

export interface PricedLine {
  item_id: string; product_id: string; name: string; sku: string; unit_price_cents: number; tax_bps: number; quantity: number
  modifiers: { option_id: string; group_name: string; option_name: string; price_delta_cents: number }[]
  subtotal_cents: number; tax_cents: number; total_cents: number
}

// Every price, tax rate and modifier delta comes from the catalog rows read here.
export async function priceSubmission(client: Queryable, storeId: string, items: SubmittedItem[]): Promise<PricedLine[]> {
  const productIds = [...new Set(items.map(item => item.product_id))]
  const products = await client.query<{
    id: string; name: string; sku: string; unit_price_cents: string; tax_bps: number; eligible: boolean; is_combo: boolean
  }>(
    `select p.id, p.name, p.sku, p.unit_price_cents::text, coalesce(t.rate_bps, 0) as tax_bps,
            (${PRODUCT_ELIGIBLE_SQL}) as eligible,
            exists (select 1 from public.combos c where c.store_id = p.store_id and c.product_id = p.id) as is_combo
     from public.pos_products p
     left join public.pos_tax_rates t on t.store_id = p.store_id and t.id = p.tax_rate_id
     where p.store_id = $1 and p.id = any($2::uuid[])`,
    [storeId, productIds],
  )
  const productById = new Map(products.rows.map(row => [row.id, row]))
  const groups = await client.query<{ product_id: string; group_id: string; group_name: string; selection: 'single' | 'multi'; required: boolean; option_id: string | null; option_name: string | null; price_delta_cents: number | null }>(
    `select pmg.product_id, mg.id as group_id, mg.name as group_name, mg.selection, mg.required,
            mo.id as option_id, mo.name as option_name, mo.price_delta_cents
     from public.product_modifier_groups pmg
     join public.modifier_groups mg on mg.store_id = pmg.store_id and mg.id = pmg.group_id
     left join public.modifier_options mo on mo.store_id = mg.store_id and mo.group_id = mg.id and mo.active = true
     where pmg.store_id = $1 and pmg.product_id = any($2::uuid[])`,
    [storeId, productIds],
  )
  return items.map((item, index) => {
    const label = `Item ${index + 1}`
    const product = productById.get(item.product_id)
    if (!product) throw new ApiError(422, 'unknown_item', `${label} is not on this menu.`)
    if (product.is_combo) throw new ApiError(422, 'combo_unavailable_via_qr', `${product.name} cannot be ordered from your phone yet. Please ask staff.`)
    if (!product.eligible) throw new ApiError(422, 'item_unavailable', `${product.name} is not available right now.`)
    const rows = groups.rows.filter(row => row.product_id === product.id)
    const optionToGroup = new Map(rows.filter(row => row.option_id).map(row => [row.option_id as string, row]))
    const counts = new Map<string, number>()
    const modifiers = item.modifier_option_ids.map(optionId => {
      const option = optionToGroup.get(optionId)
      if (!option) throw new ApiError(422, 'unknown_item', `${product.name} has an option that is not available.`)
      counts.set(option.group_id, (counts.get(option.group_id) ?? 0) + 1)
      return { option_id: optionId, group_name: option.group_name, option_name: option.option_name as string, price_delta_cents: option.price_delta_cents as number }
    })
    for (const group of new Map(rows.map(row => [row.group_id, row])).values()) {
      const count = counts.get(group.group_id) ?? 0
      if (group.required && count === 0) throw new ApiError(422, 'validation_failed', `${product.name} needs a ${group.group_name} choice.`)
      if (group.selection === 'single' && count > 1) throw new ApiError(422, 'validation_failed', `${product.name} allows one ${group.group_name} choice.`)
    }
    const unitPrice = Number(product.unit_price_cents) + modifiers.reduce((sum, modifier) => sum + modifier.price_delta_cents, 0)
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0 || unitPrice > MAX_CENTS) throw new ApiError(422, 'validation_failed', `${product.name} has an invalid price.`)
    let line: ReturnType<typeof calculateDiscountedLine>
    try { line = calculateDiscountedLine(unitPrice, item.quantity, product.tax_bps, null) }
    catch { throw new ApiError(422, 'validation_failed', `${label} exceeds the supported amount.`) }
    return {
      item_id: randomUUID(), product_id: product.id, name: product.name, sku: product.sku, unit_price_cents: unitPrice, tax_bps: product.tax_bps,
      quantity: item.quantity, modifiers, subtotal_cents: line.subtotalCents, tax_cents: line.taxCents, total_cents: line.totalCents,
    }
  })
}

// --- submission lifecycle ---------------------------------------------------------------------

interface SubmissionRow {
  id: string; store_id: string; session_id: string; table_id: string; operation_id: string; payload_hash: string
  status: 'pending' | 'confirmed' | 'rejected'; lines: PricedLine[]; customer_note: string | null
  subtotal_cents: string; tax_cents: string; check_id: string | null; decided_at: Date | null; auto_confirmed: boolean; created_at: Date
}
const SUBMISSION_COLUMNS = `id, store_id, session_id, table_id, operation_id, payload_hash, status, lines, customer_note,
  subtotal_cents::text, tax_cents::text, check_id, decided_at, auto_confirmed, created_at`

type Actor = { employeeId: string | null; userId: string | null; auto: boolean }

// Customer-facing view: only that session's own submission, no ids of staff, checks or tables.
const CUSTOMER_STATUS = { pending: 'awaiting_confirmation', confirmed: 'added_to_check', rejected: 'declined' } as const
function customerView(row: SubmissionRow) {
  return {
    id: row.id, status: CUSTOMER_STATUS[row.status], created_at: new Date(row.created_at).toISOString(),
    decided_at: row.decided_at ? new Date(row.decided_at).toISOString() : null, note: row.customer_note,
    items: row.lines.map(line => ({ name: line.name, quantity: line.quantity, modifiers: line.modifiers.map(modifier => modifier.option_name), total_cents: line.total_cents })),
    subtotal_cents: Number(row.subtotal_cents), tax_cents: Number(row.tax_cents),
  }
}

async function lockTable(client: Queryable, storeId: string, tableId: string) {
  const result = await client.query<{ status: string; active: boolean; qr_mode: QrMode; qr_require_confirmation: boolean; qr_generation: number; label: string }>(
    'select status, active, qr_mode, qr_require_confirmation, qr_generation, label from public.restaurant_tables where store_id=$1 and id=$2 for update',
    [storeId, tableId])
  if (!result.rows[0]) throw new ApiError(404, 'table_not_found', 'Table not found in this store.')
  return result.rows[0]
}

// Appends a pending submission to the table's open check (creating the check when the table has
// none). Caller holds the restaurant_tables row lock, which serializes every append per table and
// makes "one open check per table" race-free. Appending never replaces existing lines, so staff
// lines and other phones' lines are untouched. No kitchen ticket is created here: that still only
// happens when staff close the check (closeOpenCheckCore -> createPaidOrder).
async function appendToOpenCheck(client: PoolClient, submission: SubmissionRow, tableStatus: string, actor: Actor): Promise<string> {
  const storeId = submission.store_id
  if (tableStatus === 'seated') {
    const moved = await applyTableStatusTransition(storeId, submission.table_id, 'seated', 'ordering', null, client)
    if (!moved) throw new ApiError(409, 'table_not_accepting_orders', 'This table changed. Please try again.')
  } else if (tableStatus !== 'ordering') {
    throw new ApiError(409, 'table_not_accepting_orders', 'This table is not taking orders right now. Please ask staff.')
  }
  const existing = await client.query<{ id: string }>(
    `select id from public.open_checks where store_id=$1 and table_id=$2 and status='open' for update`, [storeId, submission.table_id])
  let checkId = existing.rows[0]?.id
  if (!checkId) {
    const created = await client.query<{ id: string }>(
      `insert into public.open_checks(store_id, order_type, table_id, employee_id) values ($1,'dine_in',$2,$3) returning id`,
      [storeId, submission.table_id, actor.employeeId])
    checkId = created.rows[0].id
  }
  for (const line of submission.lines) {
    await client.query(
      `insert into public.open_check_items(id,store_id,check_id,product_id,snapshot_name,snapshot_sku,snapshot_price_cents,snapshot_tax_bps,
         catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents,qr_submission_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,0,$10,$11,$12,$13)`,
      [line.item_id, storeId, checkId, line.product_id, line.name, line.sku, line.unit_price_cents, line.tax_bps, line.quantity,
        line.subtotal_cents, line.tax_cents, line.total_cents, submission.id])
    for (const modifier of line.modifiers) {
      await client.query(
        `insert into public.open_check_item_modifiers(store_id,check_item_id,snapshot_group_name,snapshot_option_name,price_delta_cents,option_id)
         values ($1,$2,$3,$4,$5,$6)`,
        [storeId, line.item_id, modifier.group_name, modifier.option_name, modifier.price_delta_cents, modifier.option_id])
    }
  }
  const sums = await client.query<{ subtotal: string; discount: string; tax: string }>(
    `select coalesce(sum(subtotal_cents),0)::text as subtotal, coalesce(sum(discount_applied_cents),0)::text as discount, coalesce(sum(tax_cents),0)::text as tax
     from public.open_check_items where store_id=$1 and check_id=$2`, [storeId, checkId])
  const store = await client.query<{ service_charge_bps: number }>('select service_charge_bps from public.stores where id=$1', [storeId])
  const subtotal = Number(sums.rows[0].subtotal), discount = Number(sums.rows[0].discount), tax = Number(sums.rows[0].tax)
  const serviceCharge = calculateServiceCharge(subtotal - discount, store.rows[0].service_charge_bps)
  const total = subtotal - discount + tax + serviceCharge
  if (total > MAX_CENTS) throw new ApiError(422, 'validation_failed', 'This check is too large to add to.')
  await client.query(
    `update public.open_checks set version = version + 1, subtotal_cents=$3, discount_cents=$4, tax_cents=$5, service_charge_cents=$6, total_cents=$7, updated_at=now()
     where store_id=$1 and id=$2`,
    [storeId, checkId, subtotal, discount, tax, serviceCharge, total])
  await client.query(
    `update public.qr_submissions set status='confirmed', check_id=$3, decided_at=now(), decided_by_employee_id=$4, decided_by_user_id=$5, auto_confirmed=$6
     where store_id=$1 and id=$2`,
    [storeId, submission.id, checkId, actor.employeeId, actor.userId, actor.auto])
  return checkId
}

export async function submitQrOrder(session: QrSession, parsed: ParsedSubmission) {
  return inTransaction(async client => {
    // Table lock first: serializes concurrent phones, and every re-check below sees committed state.
    const table = await lockTable(client, session.storeId, session.tableId)
    const existing = await client.query<SubmissionRow>(
      `select ${SUBMISSION_COLUMNS} from public.qr_submissions where store_id=$1 and session_id=$2 and operation_id=$3`,
      [session.storeId, session.sessionId, parsed.operationId])
    if (existing.rows[0]) {
      if (existing.rows[0].payload_hash !== parsed.payloadHash) throw new ApiError(409, 'operation_id_conflict', 'This order ID was already used for a different order.')
      return { replayed: true, submission: customerView(existing.rows[0]) }
    }
    // Mode/state are re-read under the lock, so a manager's change takes effect on the very next request.
    if (!table.active || !IN_SERVICE_STATUSES.includes(table.status)) throw new ApiError(401, 'session_revoked', 'This table session has ended. Scan the QR code on your table again.')
    const live = await client.query<{ qr_generation: number; qr_code_hash: string | null }>(
      'select qr_generation, qr_code_hash from public.restaurant_tables where store_id=$1 and id=$2', [session.storeId, session.tableId])
    const sessionRow = await client.query<{ qr_generation: number; revoked_at: Date | null }>('select qr_generation, revoked_at from public.qr_sessions where store_id=$1 and id=$2', [session.storeId, session.sessionId])
    if (sessionRow.rows[0].revoked_at || !live.rows[0].qr_code_hash || live.rows[0].qr_generation !== sessionRow.rows[0].qr_generation) {
      throw new ApiError(401, 'session_revoked', 'This table session has ended. Scan the QR code on your table again.')
    }
    if (table.qr_mode !== 'menu_and_order') throw new ApiError(403, 'ordering_disabled', 'Ordering from your phone is not available at this table. Please ask staff.')
    if (!ORDERING_STATUSES.includes(table.status)) throw new ApiError(409, 'table_not_accepting_orders', 'This table is not taking new orders from your phone right now. Please ask staff.')

    const lines = await priceSubmission(client, session.storeId, parsed.items)
    const subtotal = lines.reduce((sum, line) => sum + line.subtotal_cents, 0)
    const tax = lines.reduce((sum, line) => sum + line.tax_cents, 0)
    const inserted = await client.query<SubmissionRow>(
      `insert into public.qr_submissions(store_id, session_id, table_id, operation_id, payload_hash, lines, customer_note, subtotal_cents, tax_cents)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) returning ${SUBMISSION_COLUMNS}`,
      [session.storeId, session.sessionId, session.tableId, parsed.operationId, parsed.payloadHash, JSON.stringify(lines), parsed.note, subtotal, tax])
    let row = inserted.rows[0]
    if (!table.qr_require_confirmation) {
      await appendToOpenCheck(client, row, table.status, { employeeId: null, userId: null, auto: true })
      row = (await client.query<SubmissionRow>(`select ${SUBMISSION_COLUMNS} from public.qr_submissions where store_id=$1 and id=$2`, [session.storeId, row.id])).rows[0]
    }
    return { replayed: false, submission: customerView(row) }
  })
}

export async function listSessionSubmissions(session: QrSession) {
  const rows = await db.query<SubmissionRow>(
    `select ${SUBMISSION_COLUMNS} from public.qr_submissions where store_id=$1 and session_id=$2 order by created_at desc limit 50`,
    [session.storeId, session.sessionId])
  return rows.rows.map(customerView)
}

// --- staff side -------------------------------------------------------------------------------

function staffView(row: SubmissionRow & { table_label: string; table_status: string }) {
  return {
    id: row.id, table_id: row.table_id, table_label: row.table_label, table_status: row.table_status, status: row.status,
    note: row.customer_note, auto_confirmed: row.auto_confirmed, created_at: new Date(row.created_at).toISOString(),
    decided_at: row.decided_at ? new Date(row.decided_at).toISOString() : null, check_id: row.check_id,
    items: row.lines.map(line => ({ name: line.name, quantity: line.quantity, modifiers: line.modifiers.map(modifier => modifier.option_name), total_cents: line.total_cents })),
    subtotal_cents: Number(row.subtotal_cents), tax_cents: Number(row.tax_cents),
  }
}

export async function listStaffSubmissions(storeId: string, status: 'pending' | 'confirmed' | 'rejected') {
  const rows = await db.query<SubmissionRow & { table_label: string; table_status: string }>(
    `select ${SUBMISSION_COLUMNS.split(',').map(column => `s.${column.trim()}`).join(', ')}, t.label as table_label, t.status as table_status
     from public.qr_submissions s join public.restaurant_tables t on t.store_id = s.store_id and t.id = s.table_id
     where s.store_id=$1 and s.status=$2 order by s.created_at ${status === 'pending' ? 'asc' : 'desc'} limit 100`,
    [storeId, status])
  return rows.rows.map(staffView)
}

async function loadForDecision(client: PoolClient, storeId: string, submissionId: string): Promise<SubmissionRow> {
  // Lock order is table then submission everywhere (submitQrOrder locks the table first).
  const peek = await client.query<{ table_id: string }>('select table_id from public.qr_submissions where store_id=$1 and id=$2', [storeId, submissionId])
  if (!peek.rows[0]) throw new ApiError(404, 'not_found', 'Submission not found in this store.')
  const table = await lockTable(client, storeId, peek.rows[0].table_id)
  const locked = await client.query<SubmissionRow>(`select ${SUBMISSION_COLUMNS} from public.qr_submissions where store_id=$1 and id=$2 for update`, [storeId, submissionId])
  ;(locked.rows[0] as SubmissionRow & { tableStatus?: string }).tableStatus = table.status
  return locked.rows[0]
}

export async function confirmQrSubmission(storeId: string, submissionId: string, actor: Actor) {
  return inTransaction(async client => {
    const row = await loadForDecision(client, storeId, submissionId)
    if (row.status === 'confirmed') return { status: 'confirmed' as const, check_id: row.check_id as string, replayed: true }
    if (row.status === 'rejected') throw new ApiError(409, 'submission_rejected', 'This order was already declined.')
    const tableStatus = (row as SubmissionRow & { tableStatus: string }).tableStatus
    const checkId = await appendToOpenCheck(client, row, tableStatus, actor)
    return { status: 'confirmed' as const, check_id: checkId, replayed: false }
  })
}

export async function rejectQrSubmission(storeId: string, submissionId: string, actor: Actor) {
  return inTransaction(async client => {
    const row = await loadForDecision(client, storeId, submissionId)
    if (row.status === 'rejected') return { status: 'rejected' as const, replayed: true }
    if (row.status === 'confirmed') throw new ApiError(409, 'submission_confirmed', 'This order was already added to the check.')
    await client.query(
      `update public.qr_submissions set status='rejected', decided_at=now(), decided_by_employee_id=$3, decided_by_user_id=$4 where store_id=$1 and id=$2`,
      [storeId, submissionId, actor.employeeId, actor.userId])
    return { status: 'rejected' as const, replayed: false }
  })
}

// --- manager table controls -------------------------------------------------------------------

export async function listQrTables(storeId: string) {
  const rows = await db.query(
    `select id, label, status, active, qr_code_hash is not null as qr_enabled, qr_mode, qr_require_confirmation, qr_generation, qr_rotated_at
     from public.restaurant_tables where store_id=$1 and active=true order by label`, [storeId])
  return rows.rows
}

// Generates or rotates: the raw code is returned once and never stored. Bumping qr_generation and
// revoking sessions in the same transaction means no old session survives a rotation.
export async function rotateQrCode(storeId: string, tableId: string) {
  const code = token()
  return inTransaction(async client => {
    const updated = await client.query(
      `update public.restaurant_tables set qr_code_hash=$3, qr_generation=qr_generation+1, qr_rotated_at=now(), updated_at=now()
       where store_id=$1 and id=$2 and active=true returning id, label, qr_mode, qr_require_confirmation, qr_generation`,
      [storeId, tableId, digest(code)])
    if (!updated.rows[0]) throw new ApiError(404, 'table_not_found', 'Table not found in this store.')
    await client.query('update public.qr_sessions set revoked_at=now() where store_id=$1 and table_id=$2 and revoked_at is null', [storeId, tableId])
    return { ...updated.rows[0], code }
  })
}

export async function revokeQrCode(storeId: string, tableId: string) {
  return inTransaction(async client => {
    const updated = await client.query(
      `update public.restaurant_tables set qr_code_hash=null, qr_generation=qr_generation+1, qr_rotated_at=now(), updated_at=now()
       where store_id=$1 and id=$2 returning id`, [storeId, tableId])
    if (!updated.rows[0]) throw new ApiError(404, 'table_not_found', 'Table not found in this store.')
    await client.query('update public.qr_sessions set revoked_at=now() where store_id=$1 and table_id=$2 and revoked_at is null', [storeId, tableId])
    return { status: 'revoked' as const }
  })
}

export async function updateQrSettings(storeId: string, tableId: string, body: unknown) {
  const input = record(body, 'Settings')
  exactKeys(input, ['mode', 'require_confirmation'], 'Settings')
  const mode = input.mode === undefined ? null : input.mode
  if (mode !== null && !QR_MODES.includes(mode as QrMode)) throw new ApiError(422, 'validation_failed', 'Mode is invalid.')
  if (input.require_confirmation !== undefined && typeof input.require_confirmation !== 'boolean') throw new ApiError(422, 'validation_failed', 'require_confirmation must be true or false.')
  const require = input.require_confirmation === undefined ? null : input.require_confirmation
  if (mode === null && require === null) throw new ApiError(422, 'validation_failed', 'Nothing to change.')
  // Sessions stay valid: mode and confirmation are read live on every request.
  const updated = await db.query(
    `update public.restaurant_tables set qr_mode=coalesce($3, qr_mode), qr_require_confirmation=coalesce($4, qr_require_confirmation), updated_at=now()
     where store_id=$1 and id=$2 and active=true returning id, label, qr_mode, qr_require_confirmation`,
    [storeId, tableId, mode, require])
  if (!updated.rows[0]) throw new ApiError(404, 'table_not_found', 'Table not found in this store.')
  return updated.rows[0]
}

// --- HTTP: public -----------------------------------------------------------------------------

publicQrRouter.use(requireFlag, noStore)

publicQrRouter.post('/sessions', guard(async (req, res) => {
  await qrSecurityHooks.sessionIssuance(publicContext(req, null))
  const body = record(req.body, 'Request')
  exactKeys(body, ['code'], 'Request')
  if (typeof body.code !== 'string' || !CODE_PATTERN.test(body.code)) throw new ApiError(404, 'qr_invalid', 'This QR code is not valid. Ask staff for help.')
  res.status(201).json(await issueQrSession(body.code))
}))

publicQrRouter.get('/menu', guard(async (req, res) => {
  const session = await resolveQrSession(req)
  await qrSecurityHooks.statusPolling(publicContext(req, session))
  if (session.mode === 'waiter_only') throw new ApiError(403, 'menu_disabled', 'Please ask a member of staff for a menu at this table.')
  const menu = await loadPublicMenu(session.storeId)
  res.json({
    table_label: session.tableLabel, mode: session.mode, requires_confirmation: session.requiresConfirmation, expires_at: session.expiresAt,
    ordering_available: session.mode === 'menu_and_order' && ORDERING_STATUSES.includes(session.tableStatus), ...menu,
  })
}))

publicQrRouter.post('/orders', guard(async (req, res) => {
  const session = await resolveQrSession(req)
  await qrSecurityHooks.orderSubmission(publicContext(req, session))
  const result = await submitQrOrder(session, parseSubmission(req.body))
  res.status(result.replayed ? 200 : 201).json(result)
}))

publicQrRouter.get('/orders', guard(async (req, res) => {
  const session = await resolveQrSession(req)
  await qrSecurityHooks.statusPolling(publicContext(req, session))
  res.json({ orders: await listSessionSubmissions(session) })
}))

// --- HTTP: staff (manager + terminal) ---------------------------------------------------------

async function staffAccess(req: Request, terminal: boolean, action: QrStaffContext['action']) {
  const storeId = checkStoreId(req)
  let actor: QrStaffContext['actor']
  if (terminal) {
    const terminalSession = await requireCashierTerminal(req, db)
    if (terminalSession.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    actor = { kind: 'terminal', employeeId: terminalSession.employeeId }
  } else {
    actor = { kind: 'manager', userId: await requireStoreManager(req, storeId) }
  }
  await qrSecurityHooks.staffConfirmation({ req, storeId, action, actor })
  return { storeId, actor: { employeeId: actor.kind === 'terminal' ? actor.employeeId : null, userId: actor.kind === 'manager' ? actor.userId : null, auto: false } }
}

function staffRoutes(router: Router, terminal: boolean) {
  router.use(noStore)
  router.get('/submissions', guard(async (req, res) => {
    const { storeId } = await staffAccess(req, terminal, 'list')
    const status = String(req.query.status ?? 'pending')
    if (status !== 'pending' && status !== 'confirmed' && status !== 'rejected') throw new ApiError(422, 'validation_failed', 'Status is invalid.')
    res.json({ submissions: await listStaffSubmissions(storeId, status) })
  }))
  router.post('/submissions/:id/confirm', guard(async (req, res) => {
    const { storeId, actor } = await staffAccess(req, terminal, 'confirm')
    res.json(await confirmQrSubmission(storeId, paramId(req), actor))
  }))
  router.post('/submissions/:id/reject', guard(async (req, res) => {
    const { storeId, actor } = await staffAccess(req, terminal, 'reject')
    res.json(await rejectQrSubmission(storeId, paramId(req), actor))
  }))
}
staffRoutes(qrRouter, false)
staffRoutes(terminalQrRouter, true)

qrRouter.get('/tables', guard(async (req, res) => {
  const storeId = checkStoreId(req)
  await requireStoreManager(req, storeId)
  res.json({ tables: await listQrTables(storeId) })
}))
qrRouter.post('/tables/:id/code', guard(async (req, res) => {
  const storeId = checkStoreId(req)
  await requireStoreManager(req, storeId)
  res.status(201).json(await rotateQrCode(storeId, paramId(req)))
}))
qrRouter.delete('/tables/:id/code', guard(async (req, res) => {
  const storeId = checkStoreId(req)
  await requireStoreManager(req, storeId)
  res.json(await revokeQrCode(storeId, paramId(req)))
}))
qrRouter.patch('/tables/:id/settings', guard(async (req, res) => {
  const storeId = checkStoreId(req)
  await requireStoreManager(req, storeId)
  res.json(await updateQrSettings(storeId, paramId(req), req.body))
}))
