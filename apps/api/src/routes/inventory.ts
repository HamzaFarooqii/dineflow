import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreMember, requireStoreManager, sendApiError, ApiError } from './auth.js'
import { requireCashierCapability } from '../terminal-auth/routes.js'
import { consumeManagerApproval, hashApprovalPayload } from '../terminal-auth/manager-approval.js'
import type { Pool } from 'pg'
import { microCentsToCents, microToString, toMicro, type AllocationPlan } from '../../../../packages/domain/src/stock-allocation.js'
import {
  allowedStockEffects, DEFAULT_WASTAGE_APPROVAL_THRESHOLD_CENTS, defaultStockEffect, isWastageCategory, MAX_WASTAGE_APPROVAL_THRESHOLD_CENTS,
  WASTAGE_CATEGORIES, wastageApprovalPayload, wastageIdentityPayload, wastageRequiresVerifiedApproval,
  type WastageCategory, type WastageOperationFields, type WastageStockEffect,
} from '../../../../packages/domain/src/wastage-category.js'
import {
  commitStockOut, loadBatchSources, loadConsumptionReference, lockIngredient, planCostMicroCents, planStockOut,
  type MovementColumns, type Queryable,
} from '../lib/stock-allocation.js'
import { costSummaryHandler } from '../lib/inventory-cost-contract.js'

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

// --- Auth: owner/manager web session, or a cashier terminal with a verified manager approval ---
//
// Every write also works from a cashier terminal, but the initiating employee needs the
// 'inventory' capability (inventory_manager/manager), and actually changing stock (adding an
// ingredient, receiving a batch, wastage) additionally needs a manager's approval for that exact
// action. Preferred path: manager_approval_token, a short-lived single-use token the terminal
// obtained from POST /pos/manager-approvals by having a manager type their PIN, verified live by
// the server against that employee's own stored PBKDF2 hash (terminal-auth/manager-approval.ts)
// and bound to this store/device/action/payload. Legacy fallback: manager_id + manager_approved_at
// supplied directly by the client, kept only so the currently-shipped terminal UI (which does not
// yet request a token) keeps working -- this never independently proves a PIN was entered for
// this action, only that the referenced id belongs to an active manager. Closing this gap for
// good means updating the Inventory screens to request and send a token instead; see this file's
// endpoint matrix note and the PR's follow-up list.
interface WriterContext { employeeId: string | null; managerId: string | null; managerApprovedAt: string | null }

async function requireTerminalWriter(req: Request, storeId: string, action: string, payload: Record<string, unknown>): Promise<WriterContext> {
  const session = await requireCashierCapability(req, db, 'inventory')
  if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
  const body = req.body as Record<string, unknown>
  const approvalToken = body.manager_approval_token
  if (typeof approvalToken === 'string' && approvalToken) {
    const managerId = await consumeManagerApproval(db, { storeId, deviceId: session.deviceId, action, payload, token: approvalToken })
    return { employeeId: session.employeeId, managerId, managerApprovedAt: new Date().toISOString() }
  }
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
async function requireWriter(req: Request, storeId: string, terminal: boolean, action: string, payload: Record<string, unknown>): Promise<{ userId: string | null } & WriterContext> {
  if (terminal) return { userId: null, ...await requireTerminalWriter(req, storeId, action, payload) }
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
  left join public.terminal_employees mgr on mgr.store_id = i.store_id and mgr.id = i.manager_id
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
      const session = await requireCashierCapability(req, db, 'inventory')
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
    const body = req.body as Record<string, unknown>
    const writer = await requireWriter(req, storeId, terminal, 'inventory.ingredient.create',
      { name: body.name, unit_id: body.unit_id, cost_per_unit_cents: body.cost_per_unit_cents, reorder_threshold: body.reorder_threshold ?? null })
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
    const ingredientId = idParam(req)
    const body = req.body as Record<string, unknown>
    await requireWriter(req, storeId, terminal, 'inventory.ingredient.update',
      { ingredient_id: ingredientId, name: body.name, unit_id: body.unit_id, cost_per_unit_cents: body.cost_per_unit_cents, reorder_threshold: body.reorder_threshold })
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
    const ingredientId = idParam(req)
    await requireWriter(req, storeId, terminal, 'inventory.ingredient.deactivate', { ingredient_id: ingredientId })
    const result = await db.query<{ id: string }>(
      `update public.ingredients set active = false where id = $1 and store_id = $2 and active = true returning id`,
      [ingredientId, storeId],
    )
    if (!result.rowCount) throw new ApiError(404, 'ingredient_not_found', 'Ingredient not found in this store.')
    res.json(await fetchIngredientById(storeId, ingredientId))
  } catch (reason) { sendApiError(res, reason) }
}

// Mirrors deactivateIngredient exactly, the other direction -- a separate endpoint rather than an
// `active` field on updateIngredient's generic PATCH, matching deactivate's own precedent.
async function reactivateIngredient(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    const ingredientId = idParam(req)
    await requireWriter(req, storeId, terminal, 'inventory.ingredient.reactivate', { ingredient_id: ingredientId })
    const result = await db.query<{ id: string }>(
      `update public.ingredients set active = true where id = $1 and store_id = $2 and active = false returning id`,
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
  // What has been drawn from this batch by allocation snapshots (consumption + wastage that
  // really deducted stock). Pre-Day-2 draw-downs have no allocation rows, so these can be lower
  // than quantity - remaining_quantity; the UI says so rather than hiding the gap.
  allocation_count: number; consumed_quantity: string; wasted_quantity: string; allocated_cost_cents: string
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
  end as received_by_name,
  coalesce(draw.allocation_count, 0)::int as allocation_count,
  coalesce(draw.consumed_quantity, 0)::text as consumed_quantity,
  coalesce(draw.wasted_quantity, 0)::text as wasted_quantity,
  coalesce(draw.allocated_cost_cents, 0)::text as allocated_cost_cents
  from public.ingredient_batches b
  left join lateral (
    select count(*) as allocation_count,
           sum(a.quantity) filter (where sm2.reason = 'consumption') as consumed_quantity,
           sum(a.quantity) filter (where sm2.reason = 'wastage') as wasted_quantity,
           sum(a.cost_cents) as allocated_cost_cents
    from public.stock_movement_allocations a
    join public.stock_movements sm2 on sm2.store_id = a.store_id and sm2.id = a.stock_movement_id
    where a.store_id = b.store_id and a.batch_id = b.id and sm2.stock_effect is distinct from 'already_consumed'
  ) draw on true
  left join public.stock_movements m on m.store_id = b.store_id and m.batch_id = b.id and m.reason = 'purchase'
  left join public.profiles p on p.id = m.created_by_user_id
  left join public.store_memberships sm on sm.store_id = m.store_id and sm.user_id = m.created_by_user_id
  left join public.terminal_employees mgr on mgr.store_id = m.store_id and mgr.id = m.manager_id`
interface MovementAllocationRow {
  batch_id: string | null; quantity: string; unit_cost_cents: number; cost_cents: string; cost_basis: 'batch' | 'estimated_ingredient_cost'
}
interface StockMovementRow {
  id: string; store_id: string; ingredient_id: string; batch_id: string | null; delta: string; reason: string
  note: string | null; kitchen_ticket_item_id: string | null; created_at: string
  created_by_user_id: string | null; created_by_name: string | null
  wastage_category: WastageCategory | null; stock_effect: WastageStockEffect | null
  approval_method: string | null; approval_required: boolean | null; approval_threshold_cents: number | null
  approved_by_name: string | null
  // Cost visibility (null for purchases/legacy rows with nothing to show). known/estimated are
  // exact decimal cents; cost_source says where they came from -- see docs/inventory-cost-contract.md.
  cost_source: 'allocation_snapshot' | 'legacy_batch_derived' | 'unknown' | null
  known_cost_cents: string | null; estimated_cost_cents: string | null
  allocations: MovementAllocationRow[]
}

const MOVEMENT_SELECT = `
  m.id, m.store_id, m.ingredient_id, m.batch_id, m.delta::text as delta, m.reason, m.note,
  m.kitchen_ticket_item_id, m.created_at, m.created_by_user_id,
  m.wastage_category, m.stock_effect, m.approval_method, m.approval_required, m.approval_threshold_cents,
  mgr.name as approved_by_name,
  cl.cost_source, cl.known_cost_cents::text as known_cost_cents, cl.estimated_cost_cents::text as estimated_cost_cents,
  coalesce((select json_agg(json_build_object('batch_id', a.batch_id, 'quantity', a.quantity::text, 'unit_cost_cents', a.unit_cost_cents,
                                              'cost_cents', a.cost_cents::text, 'cost_basis', a.cost_basis) order by a.sequence)
            from public.stock_movement_allocations a where a.store_id = m.store_id and a.stock_movement_id = m.id), '[]'::json) as allocations,
  case
    when p.full_name is not null and p.full_name <> '' then p.full_name || coalesce(' (' || sm.role || ')', '')
    when mgr.name is not null then mgr.name || ' (manager)'
    else null
  end as created_by_name
  from public.stock_movements m
  left join public.profiles p on p.id = m.created_by_user_id
  left join public.store_memberships sm on sm.store_id = m.store_id and sm.user_id = m.created_by_user_id
  left join public.terminal_employees mgr on mgr.store_id = m.store_id and mgr.id = m.manager_id
  left join public.stock_movement_cost_lines cl on cl.store_id = m.store_id and cl.movement_id = m.id`

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
    const ingredientId = idParam(req)
    const body = req.body as Record<string, unknown>
    const writer = await requireWriter(req, storeId, terminal, 'inventory.batch.receive', {
      ingredient_id: ingredientId, quantity: body.quantity, cost_per_unit_cents: body.cost_per_unit_cents,
      expires_at: body.expires_at ?? null, received_at: body.received_at ?? null, reference: body.reference ?? null,
    })
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
      const session = await requireCashierCapability(req, db, 'inventory')
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
      const session = await requireCashierCapability(req, db, 'inventory')
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
// stock_movements.reason stays 'wastage'; the structured category, the stock effect, the stable
// operation id and the approval evidence are their own columns (202610020001). The free-text note
// is preserved exactly as the caller sent it.
//
// Policies kept from before: explicit wastage beyond available aggregate stock is rejected (422),
// and a terminal can never write without a manager. New in Day 2:
//  * operation_id is required. Same id + same payload replays the original result (200, replayed);
//    same id + different payload is a 409 operation_conflict. Nothing is written twice.
//  * stock can span batches; each allocation snapshots the cost it was taken at.
//  * returned dishes (stock_effect 'already_consumed') are recorded for cost visibility but never
//    deduct stock a second time.
//  * a terminal entry valued at/above the store threshold needs a server-verified approval token;
//    the legacy client-supplied manager evidence is accepted only below it.

export function assertWastageWithinStock(currentStockMicro: bigint, quantityMicro: bigint): void {
  if (quantityMicro > currentStockMicro) {
    throw new ApiError(422, 'validation_failed', `Cannot record wastage of ${microToString(quantityMicro)}: only ${microToString(currentStockMicro)} in stock.`)
  }
}

export interface WastageInput {
  operationId: string
  quantityMicro: bigint
  category: WastageCategory
  stockEffect: WastageStockEffect
  note: string | null
  batchId: string | null
  kitchenTicketItemId: string | null
}

export function parseWastageInput(body: Record<string, unknown>): WastageInput {
  const operationId = String(body.operation_id ?? '')
  if (!UUID_RE.test(operationId)) throw new ApiError(422, 'validation_failed', 'A valid operation_id (UUID) is required so a retry cannot record this wastage twice.')
  const rawQuantity = typeof body.quantity === 'string' ? body.quantity : positiveNumber(body.quantity, 'quantity')
  let quantityMicro: bigint
  try { quantityMicro = toMicro(rawQuantity) } catch { throw new ApiError(422, 'validation_failed', 'quantity must be a positive number.') }
  if (quantityMicro <= 0n) throw new ApiError(422, 'validation_failed', 'quantity must be a positive number of at least 0.000001.')
  if (!isWastageCategory(body.wastage_category)) {
    throw new ApiError(422, 'validation_failed', `wastage_category must be one of: ${WASTAGE_CATEGORIES.join(', ')}.`)
  }
  const category = body.wastage_category
  const stockEffect = body.stock_effect === undefined || body.stock_effect === null ? defaultStockEffect(category) : String(body.stock_effect)
  if (!(allowedStockEffects(category) as readonly string[]).includes(stockEffect)) {
    throw new ApiError(422, 'validation_failed', `Category "${category}" does not allow stock_effect "${stockEffect}".`)
  }
  const note = body.note !== undefined && body.note !== null && String(body.note).trim() !== '' ? nonEmptyText(body.note, 'note', 500) : null
  if (note === null && (category === 'other' || category === 'discrepancy')) {
    throw new ApiError(422, 'validation_failed', `A note is required for the "${category}" category.`)
  }
  const batchId = body.batch_id !== undefined && body.batch_id !== null ? String(body.batch_id) : null
  if (batchId !== null && !UUID_RE.test(batchId)) throw new ApiError(422, 'validation_failed', 'A valid batch_id is required.')
  const kitchenTicketItemId = body.kitchen_ticket_item_id !== undefined && body.kitchen_ticket_item_id !== null ? String(body.kitchen_ticket_item_id) : null
  if (kitchenTicketItemId !== null && !UUID_RE.test(kitchenTicketItemId)) throw new ApiError(422, 'validation_failed', 'A valid kitchen_ticket_item_id is required.')
  if (stockEffect === 'already_consumed') {
    if (kitchenTicketItemId === null) throw new ApiError(422, 'validation_failed', 'Returned-dish wastage must reference the kitchen_ticket_item_id that was served, so its consumed ingredients are not deducted twice.')
    if (batchId !== null) throw new ApiError(422, 'validation_failed', 'batch_id cannot be chosen for returned-dish wastage: it is priced from what the dish originally consumed.')
  } else if (kitchenTicketItemId !== null) {
    throw new ApiError(422, 'validation_failed', 'kitchen_ticket_item_id is only valid for returned-dish (already_consumed) wastage.')
  }
  return { operationId, quantityMicro, category, stockEffect: stockEffect as WastageStockEffect, note, batchId, kitchenTicketItemId }
}

function wastageFields(ingredientId: string, input: WastageInput): WastageOperationFields {
  return {
    ingredientId, quantity: microToString(input.quantityMicro), category: input.category, stockEffect: input.stockEffect,
    note: input.note, batchId: input.batchId, kitchenTicketItemId: input.kitchenTicketItemId,
  }
}

export const WASTAGE_APPROVAL_ACTION = 'inventory.wastage.record'

export type WastageActor =
  | { kind: 'web'; userId: string }
  | {
    kind: 'terminal'; employeeId: string; deviceId: string
    approvalToken: string | null; legacyManagerId: string | null; legacyManagerApprovedAt: string | null
  }

export async function wastageApprovalThresholdCents(client: Queryable, storeId: string): Promise<number> {
  const row = await client.query<{ wastage_approval_threshold_cents: number }>(
    'select wastage_approval_threshold_cents from public.inventory_policies where store_id = $1', [storeId],
  )
  return row.rows[0]?.wastage_approval_threshold_cents ?? DEFAULT_WASTAGE_APPROVAL_THRESHOLD_CENTS
}

function money(microCents: bigint): string { return (microCentsToCents(microCents) / 100).toFixed(2) }

/**
 * Core of POST /inventory/ingredients/:id/wastage and the /pos equivalent. Runs on the CALLER's
 * transaction (begin/commit belong to the caller), which is what lets the HTTP handler and the
 * PGlite tests share it. `approvalPool` is only used to redeem a manager approval token.
 */
export async function recordWastageCore(
  ctx: { client: Queryable; approvalPool: Pick<Pool, 'query'> },
  storeId: string, ingredientId: string, input: WastageInput, actor: WastageActor,
): Promise<{ movementId: string; replayed: boolean }> {
  const { client } = ctx
  const fields = wastageFields(ingredientId, input)
  const payloadHash = hashApprovalPayload(wastageIdentityPayload(fields))

  // Lock order: ingredient row first (also serialises concurrent identical operation ids on the
  // same ingredient), then its batches in picking order, then inserts.
  const ingredient = await lockIngredient(client, storeId, ingredientId)
  if (!ingredient) throw new ApiError(404, 'ingredient_not_found', 'Ingredient not found in this store.')

  const existing = await client.query<{ id: string; payload_hash: string | null }>(
    'select id, payload_hash from public.stock_movements where store_id = $1 and operation_id = $2', [storeId, input.operationId],
  )
  if (existing.rows[0]) {
    if (existing.rows[0].payload_hash === payloadHash) return { movementId: existing.rows[0].id, replayed: true }
    throw new ApiError(409, 'operation_conflict', 'This operation_id was already used for a different wastage entry. Use a new operation_id for a new entry.')
  }
  if (!ingredient.active) throw new ApiError(404, 'ingredient_not_found', 'Ingredient not found in this store.')

  let plan: AllocationPlan
  const deduct = input.stockEffect === 'deduct'
  if (deduct) {
    assertWastageWithinStock(toMicro(ingredient.currentStock), input.quantityMicro)
    const sources = await loadBatchSources(client, storeId, ingredientId, input.batchId)
    if (input.batchId !== null) {
      if (!sources.length) throw new ApiError(422, 'validation_failed', 'The selected batch does not belong to this ingredient or has nothing remaining.')
      if (input.quantityMicro > sources[0].remainingMicro) {
        throw new ApiError(422, 'validation_failed', `Cannot waste ${microToString(input.quantityMicro)} from this batch: only ${microToString(sources[0].remainingMicro)} remaining in it.`)
      }
    }
    plan = planStockOut(sources, input.quantityMicro, ingredient.costPerUnitCents)
  } else {
    const reference = await loadConsumptionReference(client, storeId, ingredientId, input.kitchenTicketItemId as string)
    if (!reference) throw new ApiError(422, 'validation_failed', 'That kitchen item did not consume this ingredient, so there is nothing to re-label as wastage.')
    const reclassifiable = reference.consumedMicro - reference.reclassifiedMicro
    if (input.quantityMicro > reclassifiable) {
      throw new ApiError(422, 'validation_failed', `Only ${microToString(reclassifiable > 0n ? reclassifiable : 0n)} of what that item consumed is still available to record as returned-dish wastage.`)
    }
    plan = planStockOut(reference.sources, input.quantityMicro, ingredient.costPerUnitCents)
  }

  const thresholdCents = await wastageApprovalThresholdCents(client, storeId)
  const costMicro = planCostMicroCents(plan)
  const verifiedRequired = wastageRequiresVerifiedApproval(costMicro, thresholdCents)

  let approval: Pick<MovementColumns, 'createdByUserId' | 'createdByEmployeeId' | 'managerId' | 'managerApprovedAt' | 'approvalMethod'>
  if (actor.kind === 'web') {
    // A signed-in owner/manager is their own authority (requireStoreManager already ran).
    approval = { createdByUserId: actor.userId, approvalMethod: 'web_manager_session' }
  } else if (actor.approvalToken) {
    const managerId = await consumeManagerApproval(ctx.approvalPool as Pool, {
      storeId, deviceId: actor.deviceId, action: WASTAGE_APPROVAL_ACTION, payload: wastageApprovalPayload(fields, input.operationId), token: actor.approvalToken,
    })
    approval = { createdByEmployeeId: actor.employeeId, managerId, managerApprovedAt: new Date().toISOString(), approvalMethod: 'terminal_verified_token' }
  } else if (verifiedRequired) {
    throw new ApiError(403, 'verified_approval_required',
      `This wastage is valued at ${money(costMicro)}, at or above the store's approval threshold of ${(thresholdCents / 100).toFixed(2)}. A manager must enter their PIN so the server can verify it.`)
  } else {
    if (actor.legacyManagerId === null || actor.legacyManagerApprovedAt === null) throw new ApiError(422, 'validation_failed', 'A manager must approve this action from the terminal.')
    const manager = await client.query(
      "select 1 from public.terminal_employees where store_id=$1 and id=$2 and role='manager' and active=true", [storeId, actor.legacyManagerId],
    )
    if (!manager.rowCount) throw new ApiError(422, 'validation_failed', 'Manager approval references an employee who is not an active manager for this store.')
    approval = { createdByEmployeeId: actor.employeeId, managerId: actor.legacyManagerId, managerApprovedAt: actor.legacyManagerApprovedAt, approvalMethod: 'terminal_legacy_evidence' }
  }

  const movementId = await commitStockOut(client, storeId, ingredientId, plan, input.quantityMicro, {
    reason: 'wastage', note: input.note, kitchenTicketItemId: input.kitchenTicketItemId, ...approval,
    wastageCategory: input.category, stockEffect: input.stockEffect, operationId: input.operationId, payloadHash,
    approvalRequired: verifiedRequired, approvalThresholdCents: thresholdCents,
  }, deduct)
  return { movementId, replayed: false }
}

// Manager approval evidence a terminal may send: a verified token (preferred) or the legacy
// manager_id + manager_approved_at pair (accepted below the approval threshold only).
function terminalWastageActor(body: Record<string, unknown>, session: { employeeId: string; deviceId: string }): WastageActor {
  const approvalToken = typeof body.manager_approval_token === 'string' && body.manager_approval_token ? body.manager_approval_token : null
  const managerId = body.manager_id === null || body.manager_id === undefined ? null : String(body.manager_id)
  const managerApprovedAt = body.manager_approved_at === null || body.manager_approved_at === undefined ? null : String(body.manager_approved_at)
  if (managerId !== null && !UUID_RE.test(managerId)) throw new ApiError(422, 'validation_failed', 'A valid manager_id is required.')
  if (managerApprovedAt !== null && Number.isNaN(Date.parse(managerApprovedAt))) throw new ApiError(422, 'validation_failed', 'A valid manager_approved_at is required.')
  if ((managerId === null) !== (managerApprovedAt === null)) throw new ApiError(422, 'validation_failed', 'Manager approval evidence is incomplete.')
  return { kind: 'terminal', employeeId: session.employeeId, deviceId: session.deviceId, approvalToken, legacyManagerId: managerId, legacyManagerApprovedAt: managerApprovedAt }
}

async function recordWastage(req: Request, res: Response, terminal = false) {
  const client = await db.connect()
  try {
    const storeId = storeIdParam(req)
    const ingredientId = idParam(req)
    const body = req.body as Record<string, unknown>
    let actor: WastageActor
    if (terminal) {
      const session = await requireCashierCapability(req, db, 'inventory')
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
      actor = terminalWastageActor(body, session)
    } else {
      actor = { kind: 'web', userId: await requireStoreManager(req, storeId) }
    }
    const input = parseWastageInput(body)

    await client.query('begin')
    const result = await recordWastageCore({ client, approvalPool: db }, storeId, ingredientId, input, actor)
    await client.query('commit')
    res.status(result.replayed ? 200 : 201).json({
      movement: await fetchMovementById(storeId, result.movementId),
      ingredient: await fetchIngredientById(storeId, ingredientId),
      replayed: result.replayed,
    })
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    // sendApiError maps a bare 23505 to a receipt-number message; the only unique index a wastage
    // write can trip is the operation id (a same-id request that raced past the ingredient lock).
    if (isUniqueViolation(reason)) sendApiError(res, new ApiError(409, 'operation_conflict', 'This operation_id was already used. Retry to receive the original result.'))
    else sendApiError(res, reason)
  } finally { client.release() }
}

// --- Wastage approval policy ----------------------------------------------------------------------

async function getWastagePolicy(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    if (terminal) {
      const session = await requireCashierCapability(req, db, 'inventory')
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }
    const stored = await db.query<{ wastage_approval_threshold_cents: number }>('select wastage_approval_threshold_cents from public.inventory_policies where store_id = $1', [storeId])
    res.json({
      wastage_approval_threshold_cents: stored.rows[0]?.wastage_approval_threshold_cents ?? DEFAULT_WASTAGE_APPROVAL_THRESHOLD_CENTS,
      is_default: !stored.rows[0],
    })
  } catch (reason) { sendApiError(res, reason) }
}

async function putWastagePolicy(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    const userId = await requireStoreManager(req, storeId)
    const threshold = nonNegativeInt((req.body as Record<string, unknown>).wastage_approval_threshold_cents, 'wastage_approval_threshold_cents')
    if (threshold > MAX_WASTAGE_APPROVAL_THRESHOLD_CENTS) throw new ApiError(422, 'validation_failed', `wastage_approval_threshold_cents cannot exceed ${MAX_WASTAGE_APPROVAL_THRESHOLD_CENTS}.`)
    await db.query(
      `insert into public.inventory_policies (store_id, wastage_approval_threshold_cents, updated_by_user_id) values ($1,$2,$3)
       on conflict (store_id) do update set wastage_approval_threshold_cents = excluded.wastage_approval_threshold_cents, updated_at = now(), updated_by_user_id = excluded.updated_by_user_id`,
      [storeId, threshold, userId],
    )
    res.json({ wastage_approval_threshold_cents: threshold, is_default: false })
  } catch (reason) { sendApiError(res, reason) }
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
      const session = await requireCashierCapability(req, db, 'inventory')
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
inventoryRouter.patch('/ingredients/:id/reactivate', (req, res) => reactivateIngredient(req, res))
inventoryRouter.post('/ingredients/:id/batches', (req, res) => recordBatch(req, res))
inventoryRouter.get('/ingredients/:id/batches', (req, res) => listBatches(req, res))
inventoryRouter.get('/ingredients/:id/movements', (req, res) => listMovements(req, res))
inventoryRouter.post('/ingredients/:id/wastage', (req, res) => recordWastage(req, res))
inventoryRouter.get('/wastage-policy', (req, res) => getWastagePolicy(req, res))
inventoryRouter.put('/wastage-policy', (req, res) => putWastagePolicy(req, res))
inventoryRouter.get('/cost-summary', (req, res) => costSummaryHandler(req, res))
inventoryRouter.get('/summary', (req, res) => getExpiringBatchCount(req, res))

terminalInventoryRouter.get('/ingredients', (req, res) => listIngredients(req, res, true))
terminalInventoryRouter.post('/ingredients', (req, res) => createIngredient(req, res, true))
terminalInventoryRouter.patch('/ingredients/:id', (req, res) => updateIngredient(req, res, true))
terminalInventoryRouter.patch('/ingredients/:id/deactivate', (req, res) => deactivateIngredient(req, res, true))
terminalInventoryRouter.patch('/ingredients/:id/reactivate', (req, res) => reactivateIngredient(req, res, true))
terminalInventoryRouter.post('/ingredients/:id/batches', (req, res) => recordBatch(req, res, true))
terminalInventoryRouter.get('/ingredients/:id/batches', (req, res) => listBatches(req, res, true))
terminalInventoryRouter.get('/ingredients/:id/movements', (req, res) => listMovements(req, res, true))
terminalInventoryRouter.post('/ingredients/:id/wastage', (req, res) => recordWastage(req, res, true))
terminalInventoryRouter.get('/wastage-policy', (req, res) => getWastagePolicy(req, res, true))
terminalInventoryRouter.get('/summary', (req, res) => getExpiringBatchCount(req, res, true))
