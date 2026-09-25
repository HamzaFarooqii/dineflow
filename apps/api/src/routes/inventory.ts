import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreMember, requireStoreManager, sendApiError, ApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'

export const inventoryRouter = Router()
export const terminalInventoryRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}

function idParam(req: Request, name = 'id'): string {
  const id = String(req.params[name] ?? '')
  if (!UUID_RE.test(id)) throw new ApiError(422, 'validation_failed', `A valid ${name} is required.`)
  return id
}

function nonEmptyText(value: unknown, label: string, maxLength: number): string {
  const text = String(value ?? '').trim()
  if (!text || text.length > maxLength) throw new ApiError(422, 'validation_failed', `${label} must be 1–${maxLength} characters.`)
  return text
}

function positiveNumber(value: unknown, label: string): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) throw new ApiError(422, 'validation_failed', `${label} must be a positive number.`)
  return num
}

function nonNegativeInt(value: unknown, label: string): number {
  const num = Number(value)
  if (!Number.isInteger(num) || num < 0) throw new ApiError(422, 'validation_failed', `${label} must be a non-negative integer.`)
  return num
}

function isUniqueViolation(reason: unknown): boolean {
  return Boolean(reason && typeof reason === 'object' && 'code' in reason && (reason as { code?: string }).code === '23505')
}

// --- Auth: owner/manager web session, or a cashier terminal with manager PIN evidence -------
//
// Every write also works from a cashier terminal, but a cashier's own authority stops at
// viewing stock — actually changing it (adding an ingredient, receiving a batch, wastage) needs
// a manager's PIN, verified entirely client-side and never transmitted; only manager_id +
// manager_approved_at cross the wire, exactly like pos_orders' over-authority-discount evidence
// (see orders.ts). The paired-or-both-null check mirrors that same convention.
interface WriterContext { employeeId: string | null; managerId: string | null; managerApprovedAt: string | null }

async function requireTerminalWriter(req: Request, storeId: string): Promise<WriterContext> {
  const session = await requireCashierTerminal(req, db)
  if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
  const body = req.body as Record<string, unknown>
  const managerId = body.manager_id === null || body.manager_id === undefined ? null : String(body.manager_id)
  const managerApprovedAt = body.manager_approved_at === null || body.manager_approved_at === undefined ? null : String(body.manager_approved_at)
  if (managerId !== null && !UUID_RE.test(managerId)) throw new ApiError(422, 'validation_failed', 'A valid manager_id is required.')
  if (managerApprovedAt !== null && Number.isNaN(Date.parse(managerApprovedAt))) throw new ApiError(422, 'validation_failed', 'A valid manager_approved_at is required.')
  if ((managerId === null) !== (managerApprovedAt === null)) throw new ApiError(422, 'validation_failed', 'Manager approval evidence is incomplete.')
  if (managerId === null) throw new ApiError(422, 'validation_failed', 'A manager must approve this action from the terminal.')
  const manager = await db.query(
    "select 1 from public.terminal_employees where store_id=$1 and id=$2 and role='manager' and active=true",
    [storeId, managerId],
  )
  if (!manager.rowCount) throw new ApiError(422, 'validation_failed', 'Manager approval references an employee who is not an active manager for this store.')
  return { employeeId: session.employeeId, managerId, managerApprovedAt }
}

// The web path (owner/manager signed in directly) has no separate "employee"/"manager" —
// the signed-in user is both the actor and the authority, matching requireStoreManager elsewhere.
async function requireWriter(req: Request, storeId: string, terminal: boolean): Promise<{ userId: string | null } & WriterContext> {
  if (terminal) return { userId: null, ...await requireTerminalWriter(req, storeId) }
  const userId = await requireStoreManager(req, storeId)
  return { userId, employeeId: null, managerId: null, managerApprovedAt: null }
}

export interface IngredientRow {
  id: string; store_id: string; name: string; unit_id: string
  cost_per_unit_cents: number; current_stock: string; reorder_threshold: string | null; active: boolean
  created_by_user_id: string | null; created_by_name: string | null; updated_at: string
  active_batch_count: number; nearest_expiry: string | null
}

// created_by_name is a display label for who performed the write: a signed-in owner/manager
// ("Full Name (owner)", from profiles + store_memberships) on the web, or the approving manager
// ("Name (manager)", from terminal_employees) on a cashier terminal — the cashier who initiated
// it is tracked in created_by_employee_id but not surfaced here, since the record of interest is
// who authorized the change, not who was standing at the terminal.
//
// active_batch_count/nearest_expiry are computed here (one lateral join per ingredient) rather
// than left for the frontend to derive by fetching every ingredient's batches individually — that
// would be an N+1 fetch for something the list view and the "Expiring Soon" filter both need.
const INGREDIENT_SELECT = `
  i.id, i.store_id, i.name, i.unit_id, i.cost_per_unit_cents, i.current_stock::text as current_stock,
  i.reorder_threshold::text as reorder_threshold, i.active, i.created_by_user_id, i.updated_at,
  coalesce(batch_agg.active_batch_count, 0) as active_batch_count, batch_agg.nearest_expiry,
  case
    when p.full_name is not null and p.full_name <> '' then p.full_name || coalesce(' (' || sm.role || ')', '')
    when mgr.name is not null then mgr.name || ' (manager)'
    else null
  end as created_by_name
  from public.ingredients i
  left join public.profiles p on p.id = i.created_by_user_id
  left join public.store_memberships sm on sm.store_id = i.store_id and sm.user_id = i.created_by_user_id
  left join public.terminal_employees mgr on mgr.id = i.manager_id
  left join lateral (
    select count(*)::int as active_batch_count, min(b.expires_at) as nearest_expiry
    from public.ingredient_batches b
    where b.store_id = i.store_id and b.ingredient_id = i.id and b.remaining_quantity > 0
  ) batch_agg on true`

// --- Ingredients: list + create + update + deactivate ---------------------------------------

async function listIngredients(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    if (terminal) {
      const session = await requireCashierTerminal(req, db)
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }
    const includeInactive = req.query.include_inactive === 'true'
    const result = await db.query<IngredientRow>(
      `select ${INGREDIENT_SELECT}
       where i.store_id = $1 ${includeInactive ? '' : 'and i.active = true'}
       order by i.name`,
      [storeId],
    )
    res.json({ ingredients: result.rows })
  } catch (reason) { sendApiError(res, reason) }
}

async function validateUnit(storeId: string, unitId: string) {
  const result = await db.query('select 1 from public.units where id = $1 and store_id = $2', [unitId, storeId])
  if (!result.rowCount) throw new ApiError(422, 'validation_failed', 'unit_id must reference a unit in this store.')
}

// insert/update RETURNING can't join to profiles/store_memberships, so writes fetch the
// joined, display-ready row in a follow-up select rather than duplicating INGREDIENT_SELECT's
// case expression inline in every statement.
async function fetchIngredientById(storeId: string, ingredientId: string): Promise<IngredientRow> {
  const result = await db.query<IngredientRow>(`select ${INGREDIENT_SELECT} where i.store_id = $1 and i.id = $2`, [storeId, ingredientId])
  return result.rows[0]
}

async function createIngredient(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    const writer = await requireWriter(req, storeId, terminal)
    const body = req.body as Record<string, unknown>
    const name = nonEmptyText(body.name, 'Ingredient name', 120)
    const unitId = String(body.unit_id ?? '')
    if (!UUID_RE.test(unitId)) throw new ApiError(422, 'validation_failed', 'A valid unit_id is required.')
    await validateUnit(storeId, unitId)
    const costPerUnitCents = nonNegativeInt(body.cost_per_unit_cents, 'cost_per_unit_cents')
    const reorderThreshold = body.reorder_threshold !== undefined && body.reorder_threshold !== null
      ? positiveNumber(body.reorder_threshold, 'reorder_threshold')
      : null
    const inserted = await db.query<{ id: string }>(
      `insert into public.ingredients (store_id, name, unit_id, cost_per_unit_cents, reorder_threshold,
                                        created_by_user_id, created_by_employee_id, manager_id, manager_approved_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [storeId, name, unitId, costPerUnitCents, reorderThreshold, writer.userId, writer.employeeId, writer.managerId, writer.managerApprovedAt],
    )
    res.status(201).json(await fetchIngredientById(storeId, inserted.rows[0].id))
  } catch (reason) {
    if (isUniqueViolation(reason)) sendApiError(res, new ApiError(409, 'name_conflict', 'An ingredient with this name already exists.'))
    else sendApiError(res, reason)
  }
}

async function updateIngredient(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    await requireWriter(req, storeId, terminal)
    const ingredientId = idParam(req)
    const body = req.body as Record<string, unknown>
    const updates: string[] = []
    const values: unknown[] = []
    let index = 1
    if (body.name !== undefined) { updates.push(`name = $${index++}`); values.push(nonEmptyText(body.name, 'Ingredient name', 120)) }
    if (body.unit_id !== undefined) {
      const unitId = String(body.unit_id)
      if (!UUID_RE.test(unitId)) throw new ApiError(422, 'validation_failed', 'A valid unit_id is required.')
      await validateUnit(storeId, unitId)
      updates.push(`unit_id = $${index++}`); values.push(unitId)
    }
    if (body.cost_per_unit_cents !== undefined) { updates.push(`cost_per_unit_cents = $${index++}`); values.push(nonNegativeInt(body.cost_per_unit_cents, 'cost_per_unit_cents')) }
    if (body.reorder_threshold !== undefined) {
      const reorderThreshold = body.reorder_threshold === null ? null : positiveNumber(body.reorder_threshold, 'reorder_threshold')
      updates.push(`reorder_threshold = $${index++}`); values.push(reorderThreshold)
    }
    if (!updates.length) throw new ApiError(422, 'validation_failed', 'Nothing to update.')
    updates.push('updated_at = now()')
    values.push(ingredientId, storeId)
    const result = await db.query<{ id: string }>(
      `update public.ingredients set ${updates.join(', ')} where id = $${index++} and store_id = $${index} returning id`,
      values,
    )
    if (!result.rowCount) throw new ApiError(404, 'ingredient_not_found', 'Ingredient not found in this store.')
    res.json(await fetchIngredientById(storeId, ingredientId))
  } catch (reason) {
    if (isUniqueViolation(reason)) sendApiError(res, new ApiError(409, 'name_conflict', 'An ingredient with this name already exists.'))
    else sendApiError(res, reason)
  }
}

async function deactivateIngredient(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    await requireWriter(req, storeId, terminal)
    const ingredientId = idParam(req)
    const result = await db.query<{ id: string }>(
      `update public.ingredients set active = false where id = $1 and store_id = $2 and active = true returning id`,
      [ingredientId, storeId],
    )
    if (!result.rowCount) throw new ApiError(404, 'ingredient_not_found', 'Ingredient not found in this store.')
    res.json(await fetchIngredientById(storeId, ingredientId))
  } catch (reason) { sendApiError(res, reason) }
}

// --- Batches: record an incoming purchase ----------------------------------------------------
//
// One transaction: insert the batch, insert a matching stock_movements row (reason='purchase',
// positive delta), and bump ingredients.current_stock — current_stock is a denormalized column
// with no trigger behind it, so every write path that changes stock must update it in the same
// transaction as its stock_movements insert, or the two drift out of sync.

interface BatchRow {
  id: string; store_id: string; ingredient_id: string; quantity: string; remaining_quantity: string
  received_at: string; expires_at: string | null; cost_per_unit_cents: number; reference: string | null
  received_by_name: string | null
}

// received_by_name is read off the batch's own originating purchase movement (stock_movements
// where batch_id = this batch and reason = 'purchase') rather than duplicating created_by
// columns onto ingredient_batches itself -- that movement already carries the same
// created_by_user_id/created_by_employee_id attribution every other write in this module uses.
const BATCH_SELECT = `
  b.id, b.store_id, b.ingredient_id, b.quantity::text as quantity, b.remaining_quantity::text as remaining_quantity,
  b.received_at, b.expires_at, b.cost_per_unit_cents, b.reference,
  case
    when p.full_name is not null and p.full_name <> '' then p.full_name || coalesce(' (' || sm.role || ')', '')
    when mgr.name is not null then mgr.name || ' (manager)'
    else null
  end as received_by_name
  from public.ingredient_batches b
  left join public.stock_movements m on m.store_id = b.store_id and m.batch_id = b.id and m.reason = 'purchase'
  left join public.profiles p on p.id = m.created_by_user_id
  left join public.store_memberships sm on sm.store_id = m.store_id and sm.user_id = m.created_by_user_id
  left join public.terminal_employees mgr on mgr.id = m.manager_id`
interface StockMovementRow {
  id: string; store_id: string; ingredient_id: string; batch_id: string | null; delta: string; reason: string
  note: string | null; kitchen_ticket_item_id: string | null; created_at: string
  created_by_user_id: string | null; created_by_name: string | null
}

const MOVEMENT_SELECT = `
  m.id, m.store_id, m.ingredient_id, m.batch_id, m.delta::text as delta, m.reason, m.note,
  m.kitchen_ticket_item_id, m.created_at, m.created_by_user_id,
  case
    when p.full_name is not null and p.full_name <> '' then p.full_name || coalesce(' (' || sm.role || ')', '')
    when mgr.name is not null then mgr.name || ' (manager)'
    else null
  end as created_by_name
  from public.stock_movements m
  left join public.profiles p on p.id = m.created_by_user_id
  left join public.store_memberships sm on sm.store_id = m.store_id and sm.user_id = m.created_by_user_id
  left join public.terminal_employees mgr on mgr.id = m.manager_id`

async function fetchMovementById(storeId: string, movementId: string): Promise<StockMovementRow> {
  const result = await db.query<StockMovementRow>(`select ${MOVEMENT_SELECT} where m.store_id = $1 and m.id = $2`, [storeId, movementId])
  return result.rows[0]
}

async function fetchBatchById(storeId: string, batchId: string): Promise<BatchRow> {
  const result = await db.query<BatchRow>(`select ${BATCH_SELECT} where b.store_id = $1 and b.id = $2`, [storeId, batchId])
  return result.rows[0]
}

async function recordBatch(req: Request, res: Response, terminal = false) {
  const client = await db.connect()
  try {
    const storeId = storeIdParam(req)
    const writer = await requireWriter(req, storeId, terminal)
    const ingredientId = idParam(req)
    const body = req.body as Record<string, unknown>
    const quantity = positiveNumber(body.quantity, 'quantity')
    const costPerUnitCents = nonNegativeInt(body.cost_per_unit_cents, 'cost_per_unit_cents')
    const expiresAt = body.expires_at !== undefined && body.expires_at !== null ? String(body.expires_at) : null
    if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) throw new ApiError(422, 'validation_failed', 'expires_at must be a valid date.')
    const receivedAt = body.received_at !== undefined && body.received_at !== null ? String(body.received_at) : null
    if (receivedAt !== null && Number.isNaN(Date.parse(receivedAt))) throw new ApiError(422, 'validation_failed', 'received_at must be a valid date.')
    const reference = body.reference !== undefined && body.reference !== null ? nonEmptyText(body.reference, 'reference', 200) : null

    await client.query('begin')
    const ingredient = await client.query('select 1 from public.ingredients where id = $1 and store_id = $2 and active = true for update', [ingredientId, storeId])
    if (!ingredient.rowCount) throw new ApiError(404, 'ingredient_not_found', 'Ingredient not found in this store.')

    const batch = await client.query<{ id: string }>(
      `insert into public.ingredient_batches (store_id, ingredient_id, quantity, remaining_quantity, cost_per_unit_cents, expires_at, received_at, reference)
       values ($1,$2,$3,$3,$4,$5, coalesce($6::timestamptz, now()), $7)
       returning id`,
      [storeId, ingredientId, quantity, costPerUnitCents, expiresAt, receivedAt, reference],
    )
    const movementInsert = await client.query<{ id: string }>(
      `insert into public.stock_movements (store_id, ingredient_id, batch_id, delta, reason,
                                            created_by_user_id, created_by_employee_id, manager_id, manager_approved_at)
       values ($1,$2,$3,$4,'purchase',$5,$6,$7,$8) returning id`,
      [storeId, ingredientId, batch.rows[0].id, quantity, writer.userId, writer.employeeId, writer.managerId, writer.managerApprovedAt],
    )
    await client.query(`update public.ingredients set current_stock = current_stock + $1, updated_at = now() where id = $2 and store_id = $3`, [quantity, ingredientId, storeId])
    await client.query('commit')
    res.status(201).json({
      batch: await fetchBatchById(storeId, batch.rows[0].id),
      movement: await fetchMovementById(storeId, movementInsert.rows[0].id),
      ingredient: await fetchIngredientById(storeId, ingredientId),
    })
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    sendApiError(res, reason)
  } finally { client.release() }
}

// Batches received so far, most recent first. Without this the UI's batch list (and its expiry
// highlighting) could only ever show what was added in the current browser session — it never
// survived a reselect or a reload, even though the rows were safely in the database all along.
async function listBatches(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    if (terminal) {
      const session = await requireCashierTerminal(req, db)
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }
    const ingredientId = idParam(req)
    const result = await db.query<BatchRow>(
      `select ${BATCH_SELECT} where b.store_id = $1 and b.ingredient_id = $2 order by b.received_at desc, b.id desc`,
      [storeId, ingredientId],
    )
    res.json({ batches: result.rows })
  } catch (reason) { sendApiError(res, reason) }
}

// --- Stock movement ledger ---------------------------------------------------------------------

interface MovementsCursor { time: string; id: string }
function movementsCursorParam(req: Request): MovementsCursor | null {
  const value = req.query.before
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length > 160) throw new ApiError(400, 'validation_failed', 'Invalid before cursor.')
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw new ApiError(400, 'validation_failed', 'Invalid before cursor.') }
  const row = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const { time, id } = row
  if (typeof time !== 'string' || Number.isNaN(Date.parse(time)) || typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new ApiError(400, 'validation_failed', 'Invalid before cursor.')
  }
  return { time, id }
}

function movementsLimitParam(req: Request): number {
  const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit)
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) throw new ApiError(400, 'validation_failed', 'Limit must be 1 to 200.')
  return rawLimit
}

async function listMovements(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    if (terminal) {
      const session = await requireCashierTerminal(req, db)
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }
    const ingredientId = idParam(req)
    const limit = movementsLimitParam(req)
    const cursor = movementsCursorParam(req)
    const result = await db.query<StockMovementRow>(
      `select ${MOVEMENT_SELECT}
       where m.store_id = $1 and m.ingredient_id = $2
         and ($3::timestamptz is null or (m.created_at, m.id) < ($3::timestamptz, $4::uuid))
       order by m.created_at desc, m.id desc limit $5`,
      [storeId, ingredientId, cursor?.time ?? null, cursor?.id ?? null, limit + 1],
    )
    const page = result.rows.slice(0, limit)
    const last = page.at(-1)
    res.json({
      movements: page,
      next_cursor: result.rows.length > limit && last
        ? Buffer.from(JSON.stringify({ time: last.created_at, id: last.id })).toString('base64url')
        : null,
    })
  } catch (reason) { sendApiError(res, reason) }
}

// --- Wastage entry ------------------------------------------------------------------------------
//
// Physical stock can never go negative, so a wastage entry that would push current_stock below
// zero is a hard 422 rather than being allowed through — it's most likely a data-entry mistake.

export function assertWastageWithinStock(currentStock: number, quantity: number): void {
  if (quantity > currentStock) {
    throw new ApiError(422, 'validation_failed', `Cannot record wastage of ${quantity}: only ${currentStock} in stock.`)
  }
}

// Batch association is a refinement on top of the ingredient-level accounting above, not a
// replacement for it: current_stock (and assertWastageWithinStock) stays the source of truth for
// "is this wastage even possible." A wastage entry is only tied to a specific batch when a single
// batch can fully account for the wasted quantity -- splitting one entry across several batches
// would mean inventing multi-batch accounting this schema was never designed for, so a quantity
// that spans more than the best-matching batch's remaining stock is recorded at the ingredient
// level only (batch_id stays null), exactly like every wastage entry worked before batch tracking
// existed. Auto-selection is FEFO (soonest expiry first), falling back to FIFO (oldest received)
// for batches with no expiry date -- the safest default for a restaurant trying to waste the
// stock most at risk of spoiling first.
export async function selectWastageBatch(client: import('pg').PoolClient, storeId: string, ingredientId: string, quantity: number, explicitBatchId: string | null): Promise<string | null> {
  if (explicitBatchId !== null) {
    const batch = await client.query<{ remaining_quantity: string }>(
      'select remaining_quantity::text as remaining_quantity from public.ingredient_batches where id=$1 and store_id=$2 and ingredient_id=$3 for update',
      [explicitBatchId, storeId, ingredientId],
    )
    if (!batch.rows[0]) throw new ApiError(422, 'validation_failed', 'The selected batch does not belong to this ingredient.')
    const remaining = Number(batch.rows[0].remaining_quantity)
    if (quantity > remaining) throw new ApiError(422, 'validation_failed', `Cannot waste ${quantity} from this batch: only ${remaining} remaining in it.`)
    return explicitBatchId
  }
  const candidate = await client.query<{ id: string; remaining_quantity: string }>(
    `select id, remaining_quantity::text as remaining_quantity from public.ingredient_batches
     where store_id=$1 and ingredient_id=$2 and remaining_quantity > 0
     order by expires_at asc nulls last, received_at asc
     limit 1 for update`,
    [storeId, ingredientId],
  )
  if (!candidate.rows[0] || quantity > Number(candidate.rows[0].remaining_quantity)) return null
  return candidate.rows[0].id
}

async function recordWastage(req: Request, res: Response, terminal = false) {
  const client = await db.connect()
  try {
    const storeId = storeIdParam(req)
    const writer = await requireWriter(req, storeId, terminal)
    const ingredientId = idParam(req)
    const body = req.body as Record<string, unknown>
    const quantity = positiveNumber(body.quantity, 'quantity')
    const note = body.note !== undefined && body.note !== null ? nonEmptyText(body.note, 'note', 500) : null
    const explicitBatchId = body.batch_id !== undefined && body.batch_id !== null ? String(body.batch_id) : null
    if (explicitBatchId !== null && !UUID_RE.test(explicitBatchId)) throw new ApiError(422, 'validation_failed', 'A valid batch_id is required.')

    await client.query('begin')
    const ingredient = await client.query<{ current_stock: string }>(
      'select current_stock::text as current_stock from public.ingredients where id = $1 and store_id = $2 and active = true for update',
      [ingredientId, storeId],
    )
    if (!ingredient.rowCount) throw new ApiError(404, 'ingredient_not_found', 'Ingredient not found in this store.')
    const currentStock = Number(ingredient.rows[0].current_stock)
    assertWastageWithinStock(currentStock, quantity)
    const batchId = await selectWastageBatch(client, storeId, ingredientId, quantity, explicitBatchId)

    const movementInsert = await client.query<{ id: string }>(
      `insert into public.stock_movements (store_id, ingredient_id, batch_id, delta, reason, note,
                                            created_by_user_id, created_by_employee_id, manager_id, manager_approved_at)
       values ($1,$2,$3,$4,'wastage',$5,$6,$7,$8,$9) returning id`,
      [storeId, ingredientId, batchId, -quantity, note, writer.userId, writer.employeeId, writer.managerId, writer.managerApprovedAt],
    )
    if (batchId) {
      await client.query('update public.ingredient_batches set remaining_quantity = remaining_quantity - $1 where id = $2 and store_id = $3', [quantity, batchId, storeId])
    }
    await client.query(`update public.ingredients set current_stock = current_stock - $1, updated_at = now() where id = $2 and store_id = $3`, [quantity, ingredientId, storeId])
    await client.query('commit')
    res.status(201).json({
      movement: await fetchMovementById(storeId, movementInsert.rows[0].id),
      ingredient: await fetchIngredientById(storeId, ingredientId),
    })
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    sendApiError(res, reason)
  } finally { client.release() }
}

// Store-wide summary for the Inventory overview cards. Total-ingredient count, low-stock count,
// and inventory value are all computed client-side from the already-loaded ingredient list (no
// new data needed there); expiring-batch count is the one figure that genuinely can't be, since
// batches are only ever fetched per-ingredient -- this is a real, if small, new read rather than
// an N+1 fetch-every-ingredient's-batches workaround.
// '3 days' mirrors packages/domain/src/batch-status.ts's EXPIRING_SOON_WINDOW_MS -- change both
// together. An already-expired batch also satisfies this (its expires_at is in the past), which
// is intentional: both need the same manager attention.
export async function countExpiringBatches(storeId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*) from public.ingredient_batches
     where store_id = $1 and remaining_quantity > 0 and expires_at is not null and expires_at <= now() + interval '3 days'`,
    [storeId],
  )
  return Number(result.rows[0].count)
}

async function getExpiringBatchCount(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    if (terminal) {
      const session = await requireCashierTerminal(req, db)
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }
    res.json({ expiring_batches_count: await countExpiringBatches(storeId) })
  } catch (reason) { sendApiError(res, reason) }
}

inventoryRouter.get('/ingredients', (req, res) => listIngredients(req, res))
inventoryRouter.post('/ingredients', (req, res) => createIngredient(req, res))
inventoryRouter.patch('/ingredients/:id', (req, res) => updateIngredient(req, res))
inventoryRouter.patch('/ingredients/:id/deactivate', (req, res) => deactivateIngredient(req, res))
inventoryRouter.post('/ingredients/:id/batches', (req, res) => recordBatch(req, res))
inventoryRouter.get('/ingredients/:id/batches', (req, res) => listBatches(req, res))
inventoryRouter.get('/ingredients/:id/movements', (req, res) => listMovements(req, res))
inventoryRouter.post('/ingredients/:id/wastage', (req, res) => recordWastage(req, res))
inventoryRouter.get('/summary', (req, res) => getExpiringBatchCount(req, res))

terminalInventoryRouter.get('/ingredients', (req, res) => listIngredients(req, res, true))
terminalInventoryRouter.post('/ingredients', (req, res) => createIngredient(req, res, true))
terminalInventoryRouter.patch('/ingredients/:id', (req, res) => updateIngredient(req, res, true))
terminalInventoryRouter.patch('/ingredients/:id/deactivate', (req, res) => deactivateIngredient(req, res, true))
terminalInventoryRouter.post('/ingredients/:id/batches', (req, res) => recordBatch(req, res, true))
terminalInventoryRouter.get('/ingredients/:id/batches', (req, res) => listBatches(req, res, true))
terminalInventoryRouter.get('/ingredients/:id/movements', (req, res) => listMovements(req, res, true))
terminalInventoryRouter.post('/ingredients/:id/wastage', (req, res) => recordWastage(req, res, true))
terminalInventoryRouter.get('/summary', (req, res) => getExpiringBatchCount(req, res, true))
