import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreManager, sendApiError, ApiError } from './auth.js'

export const promotionsRouter = Router()

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

function discountValue(value: unknown, kind: 'percent' | 'fixed'): number {
  const num = Number(value)
  const max = kind === 'percent' ? 10_000 : Number.MAX_SAFE_INTEGER
  if (!Number.isInteger(num) || num <= 0 || num > max) {
    throw new ApiError(422, 'validation_failed', kind === 'percent' ? 'discount_value must be an integer number of basis points between 1 and 10000.' : 'discount_value must be a positive integer number of cents.')
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

async function updatePromotion(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const promotionId = idParam(req)
    const body = req.body as Record<string, unknown>
    const existing = await db.query<{ discount_kind: 'percent' | 'fixed' }>(
      'select discount_kind from public.promotions where id = $1 and store_id = $2', [promotionId, storeId],
    )
    if (!existing.rowCount) throw new ApiError(404, 'not_found', 'Promotion not found in this store.')
    const updates: string[] = []
    const values: unknown[] = []
    let index = 1
    let kind = existing.rows[0].discount_kind
    if (body.name !== undefined) { updates.push(`name = $${index++}`); values.push(nonEmptyText(body.name, 'Promotion name', 60)) }
    if (body.discount_kind !== undefined) { kind = discountKind(body.discount_kind); updates.push(`discount_kind = $${index++}`); values.push(kind) }
    if (body.discount_value !== undefined) { updates.push(`discount_value = $${index++}`); values.push(discountValue(body.discount_value, kind)) }
    if (body.starts_at !== undefined) { updates.push(`starts_at = $${index++}`); values.push(nullableTimestamp(body.starts_at, 'starts_at')) }
    if (body.ends_at !== undefined) { updates.push(`ends_at = $${index++}`); values.push(nullableTimestamp(body.ends_at, 'ends_at')) }
    if (body.active !== undefined) { updates.push(`active = $${index++}`); values.push(Boolean(body.active)) }
    if (!updates.length) throw new ApiError(422, 'validation_failed', 'Nothing to update.')
    values.push(promotionId, storeId)
    const result = await db.query(
      `update public.promotions set ${updates.join(', ')} where id = $${index++} and store_id = $${index}
       returning id, store_id, name, discount_kind, discount_value, starts_at, ends_at, active`,
      values,
    )
    if (!result.rowCount) throw new ApiError(404, 'not_found', 'Promotion not found in this store.')
    const row = result.rows[0]
    if (row.starts_at && row.ends_at && row.starts_at > row.ends_at) throw new ApiError(422, 'validation_failed', 'starts_at must be before ends_at.')
    res.json(row)
  } catch (reason) { sendApiError(res, reason) }
}

// Deactivate is a plain PATCH { active: false } via updatePromotion above — a promotion is a
// campaign someone can also re-enable later (unlike a floor table, which is soft-deleted for
// good), so it stays a toggle rather than gaining its own endpoint.

promotionsRouter.get('/', listPromotions)
promotionsRouter.post('/', createPromotion)
promotionsRouter.patch('/:id', updatePromotion)
