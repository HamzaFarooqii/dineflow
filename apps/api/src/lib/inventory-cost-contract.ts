// Read-side inventory cost contract (Day 2) for the profitability/reporting layer.
// Contract prose, SQL, worked examples and fixtures: docs/inventory-cost-contract.md.
//
//   loadInventoryCostSummary(queryable, storeId, startUtc, endUtc)  -> InventoryCostSummary
//   GET /inventory/cost-summary?store_id=&start=<ISO instant>&end=<ISO instant>   (owner/manager)
//
// The caller resolves its own reporting period (e.g. a store-timezone business day) into UTC
// instants; the range is [start, end). This module deliberately does not import reports.ts so the
// two workstreams can be connected by the lead without touching each other's files.
import type { Request, Response } from 'express'
import { db } from '../db.js'
import { ApiError, sendApiError } from '../routes/auth.js'
import { requireReportAccess } from '../routes/reports.js'
import {
  summarizeInventoryCost, type CostedReason, type CostLineGroup, type InventoryCostSummary,
} from '../../../../packages/domain/src/inventory-cost-summary.js'
import type { WastageCategory, WastageStockEffect } from '../../../../packages/domain/src/wastage-category.js'
import type { Queryable } from './stock-allocation.js'

export async function loadInventoryCostSummary(client: Queryable, storeId: string, startUtc: string, endUtc: string): Promise<InventoryCostSummary> {
  const groups = await client.query<{
    reason: CostedReason; wastage_category: WastageCategory | null; stock_effect: WastageStockEffect | null
    movement_count: number; known: string; estimated: string; estimated_n: number; unknown_n: number
  }>(
    `select reason, wastage_category, stock_effect,
            count(*)::int as movement_count,
            coalesce(sum(known_cost_cents), 0)::text as known,
            coalesce(sum(estimated_cost_cents), 0)::text as estimated,
            (count(*) filter (where has_estimate))::int as estimated_n,
            (count(*) filter (where unknown_cost))::int as unknown_n
     from public.stock_movement_cost_lines
     where store_id = $1 and created_at >= $2::timestamptz and created_at < $3::timestamptz
     group by reason, wastage_category, stock_effect`,
    [storeId, startUtc, endUtc],
  )
  const first = await client.query<{ effective_from: string | null }>(
    'select min(created_at) as effective_from from public.stock_movement_allocations where store_id = $1', [storeId],
  )
  const effectiveFrom = first.rows[0]?.effective_from ?? null
  return summarizeInventoryCost({
    startUtc, endUtc,
    effectiveFrom: effectiveFrom === null ? null : new Date(effectiveFrom).toISOString(),
    groups: groups.rows.map((row): CostLineGroup => ({
      reason: row.reason, wastageCategory: row.wastage_category, stockEffect: row.stock_effect, movementCount: row.movement_count,
      knownCostCents: row.known, estimatedCostCents: row.estimated, estimatedMovementCount: row.estimated_n, unknownMovementCount: row.unknown_n,
    })),
  })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_RANGE_MS = 366 * 86_400_000

function instantParam(value: unknown, name: string): string {
  const text = String(value ?? '')
  const parsed = Date.parse(text)
  if (!text || Number.isNaN(parsed)) throw new ApiError(400, 'validation_failed', `${name} must be an ISO-8601 instant.`)
  return new Date(parsed).toISOString()
}

export async function costSummaryHandler(req: Request, res: Response) {
  try {
    const storeId = String(req.query.store_id ?? '')
    if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
    await requireReportAccess(req, storeId)
    const start = instantParam(req.query.start, 'start')
    const end = instantParam(req.query.end, 'end')
    if (Date.parse(end) <= Date.parse(start)) throw new ApiError(400, 'validation_failed', 'end must be after start.')
    if (Date.parse(end) - Date.parse(start) > MAX_RANGE_MS) throw new ApiError(400, 'validation_failed', 'The range cannot exceed 366 days.')
    res.json(await loadInventoryCostSummary(db, storeId, start, end))
  } catch (reason) { sendApiError(res, reason) }
}
