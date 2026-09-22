import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreMember, sendApiError, ApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'

export const floorRouter = Router()
export const terminalFloorRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}

// GET /floor and GET /pos/floor — read-only floor plan (active areas + active tables) for a
// store. No write path yet: no open-ticket layer exists to legitimately change a table's status
// (Restaurant POS Transformation Blueprint, docs/09, Section 4). Table status is set by the
// migration default ('available') until that layer is built.
async function getFloorPlan(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    if (terminal) {
      const session = await requireCashierTerminal(req, db)
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreMember(req, storeId)
    }
    const areas = await db.query(
      'select id, store_id, name, sort_order from public.floor_areas where store_id = $1 and active = true order by sort_order, name',
      [storeId],
    )
    const tables = await db.query(
      'select id, store_id, floor_area_id, label, seats, status from public.restaurant_tables where store_id = $1 and active = true order by label',
      [storeId],
    )
    res.json({ areas: areas.rows, tables: tables.rows })
  } catch (reason) { sendApiError(res, reason) }
}

floorRouter.get('/', (req, res) => getFloorPlan(req, res))
terminalFloorRouter.get('/', (req, res) => getFloorPlan(req, res, true))
