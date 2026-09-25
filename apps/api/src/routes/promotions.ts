import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreManager, sendApiError, ApiError } from './auth.js'
import { MAX_CENTS } from '../../../../packages/domain/src/money.js'
import { activePromotions, type Promotion as DomainPromotion } from '../../../../packages/domain/src/promotions.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'

export const promotionsRouter = Router()
export const terminalPromotionsRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}

function idParam(req: Request): string {
  const id = String(req.params.id ?? '')
  if (!UUID_RE.test(id)) throw new ApiError(422, 'validation_failed', 'A valid promotion id is required.')
  return id
}

function nonEmptyText(value: unknown, label: string, maxLength: number): string {
  const text = String(value ?? '').trim()
  if (!text || text.length > maxLength) throw new ApiError(422, 'validation_failed', `${label} must be 1–${maxLength} characters.`)
  return text
}

function discountKind(value: unknown): 'percent' | 'fixed' {
  if (value !== 'percent' && value !== 'fixed') throw new ApiError(422, 'validation_failed', 'discount_kind must be "percent" or "fixed".')
  return value
}

// Bounded to MAX_CENTS for 'fixed' so a stored value can never exceed what money.ts's own
// boundedInteger (formatCents, promotions.ts's promotionToLineDiscount) will later accept.
function discountValue(value: unknown, kind: 'percent' | 'fixed'): number {
  const num = Number(value)
  const max = kind === 'percent' ? 10_000 : MAX_CENTS
  if (!Number.isInteger(num) || num <= 0 || num > max) {
    throw new ApiError(422, 'validation_failed', kind === 'percent' ? 'discount_value must be an integer number of basis points between 1 and 10000.' : `discount_value must be a positive integer number of cents, up to ${MAX_CENTS}.`)
  }
  return num
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  const text = String(value)
  if (Number.isNaN(Date.parse(text))) throw new ApiError(422, 'validation_failed', `${label} must be a valid timestamp.`)
  return new Date(text).toISOString()
}

// GET /promotions — full list including inactive ones, for the management screen.
async function listPromotions(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const result = await db.query(
      `select id, store_id, name, discount_kind, discount_value, starts_at, ends_at, active
       from public.promotions where store_id = $1 order by name`,
      [storeId],
    )
    res.json({ promotions: result.rows })
  } catch (reason) { sendApiError(res, reason) }
}

async function createPromotion(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const body = req.body as Record<string, unknown>
    const name = nonEmptyText(body.name, 'Promotion name', 60)
    const kind = discountKind(body.discount_kind)
    const value = discountValue(body.discount_value, kind)
    const startsAt = nullableTimestamp(body.starts_at, 'starts_at')
    const endsAt = nullableTimestamp(body.ends_at, 'ends_at')
    if (startsAt && endsAt && startsAt > endsAt) throw new ApiError(422, 'validation_failed', 'starts_at must be before ends_at.')
    const result = await db.query(
      `insert into public.promotions (store_id, name, discount_kind, discount_value, starts_at, ends_at)
       values ($1,$2,$3,$4,$5,$6)
       returning id, store_id, name, discount_kind, discount_value, starts_at, ends_at, active`,
      [storeId, name, kind, value, startsAt, endsAt],
    )
    res.status(201).json(result.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

interface PromotionRow {
  name: string; discount_kind: 'percent' | 'fixed'; discount_value: number
  starts_at: string | null; ends_at: string | null; active: boolean
}

async function updatePromotion(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const promotionId = idParam(req)
    const body = req.body as Record<string, unknown>
    const existing = await db.query<PromotionRow>(
      'select name, discount_kind, discount_value, starts_at, ends_at, active from public.promotions where id = $1 and store_id = $2',
      [promotionId, storeId],
    )
    if (!existing.rowCount) throw new ApiError(404, 'not_found', 'Promotion not found in this store.')
    if (Object.keys(body).length === 0) throw new ApiError(422, 'validation_failed', 'Nothing to update.')

    // Validate the fully merged row (not just the fields the caller happened to send) before
    // writing anything, so discount_kind/discount_value stay a valid pair even when only one of
    // the two is patched, and an inverted starts_at/ends_at window is rejected before it's ever
    // persisted rather than after.
    const current = existing.rows[0]
    const name = body.name !== undefined ? nonEmptyText(body.name, 'Promotion name', 60) : current.name
    const kind = body.discount_kind !== undefined ? discountKind(body.discount_kind) : current.discount_kind
    const value = body.discount_value !== undefined || body.discount_kind !== undefined
      ? discountValue(body.discount_value ?? current.discount_value, kind)
      : current.discount_value
    const startsAt = body.starts_at !== undefined ? nullableTimestamp(body.starts_at, 'starts_at') : current.starts_at
    const endsAt = body.ends_at !== undefined ? nullableTimestamp(body.ends_at, 'ends_at') : current.ends_at
    if (startsAt && endsAt && startsAt > endsAt) throw new ApiError(422, 'validation_failed', 'starts_at must be before ends_at.')
    const active = body.active !== undefined ? Boolean(body.active) : current.active

    const result = await db.query(
      `update public.promotions set name=$1, discount_kind=$2, discount_value=$3, starts_at=$4, ends_at=$5, active=$6
       where id = $7 and store_id = $8
       returning id, store_id, name, discount_kind, discount_value, starts_at, ends_at, active`,
      [name, kind, value, startsAt, endsAt, active, promotionId, storeId],
    )
    if (!result.rowCount) throw new ApiError(404, 'not_found', 'Promotion not found in this store.')
    res.json(result.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

// Deactivate is a plain PATCH { active: false } via updatePromotion above — a promotion is a
// campaign someone can also re-enable later (unlike a floor table, which is soft-deleted for
// good), so it stays a toggle rather than gaining its own endpoint.

interface PromotionRow {
  id: string; store_id: string; name: string; discount_kind: 'percent' | 'fixed'; discount_value: number
  starts_at: string | null; ends_at: string | null; active: boolean
}

function toDomain(row: PromotionRow): DomainPromotion {
  return {
    id: row.id, storeId: row.store_id, name: row.name, discountKind: row.discount_kind, discountValue: row.discount_value,
    startsAt: row.starts_at ? new Date(row.starts_at) : null, endsAt: row.ends_at ? new Date(row.ends_at) : null, active: row.active,
  }
}

function toRow(promotion: DomainPromotion): PromotionRow {
  return {
    id: promotion.id, store_id: promotion.storeId, name: promotion.name, discount_kind: promotion.discountKind, discount_value: promotion.discountValue,
    starts_at: promotion.startsAt?.toISOString() ?? null, ends_at: promotion.endsAt?.toISOString() ?? null, active: promotion.active,
  }
}

// GET /pos/promotions — terminal-only, read-only, active-and-in-window promotions a cashier can
// apply at checkout. Deliberately not the same endpoint as the management GET /promotions above:
// that one is requireStoreManager-gated (a Supabase web session only) and returns every promotion
// including inactive/scheduled ones for the management screen, neither of which a cashier terminal
// needs or has credentials for.
async function listActivePromotions(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    const session = await requireCashierTerminal(req, db)
    if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    const result = await db.query<PromotionRow>(
      `select id, store_id, name, discount_kind, discount_value, starts_at, ends_at, active
       from public.promotions where store_id = $1 and active = true`,
      [storeId],
    )
    const active = activePromotions(result.rows.map(toDomain), new Date())
    res.json({ promotions: active.map(toRow) })
  } catch (reason) { sendApiError(res, reason) }
}

promotionsRouter.get('/', listPromotions)
promotionsRouter.post('/', createPromotion)
promotionsRouter.patch('/:id', updatePromotion)
terminalPromotionsRouter.get('/', listActivePromotions)
