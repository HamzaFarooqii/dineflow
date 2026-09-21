import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { ApiError, requireStoreMember, sendApiError } from './auth.js'
import { storeIdParam } from './reports.js'

export const auditRouter = Router()

// Duplicated per-file auth helper, matching this codebase's convention (see reports.ts's
// requireReportAccess) rather than a shared cross-route abstraction.
async function requireAuditAccess(req: Request, storeId: string): Promise<void> {
  const userId = await requireStoreMember(req, storeId)
  const result = await db.query<{ role: string }>('select role from public.store_memberships where store_id=$1 and user_id=$2 and active=true', [storeId, userId])
  if (!['owner', 'manager'].includes(result.rows[0]?.role ?? '')) throw new ApiError(403, 'authorization_failed', 'Activity log access requires an owner or manager role.')
}

export interface AuditLogEntry { id: string; actorId: string; actorName: string | null; action: string; target: string; createdAt: string }

export async function loadAuditLog(storeId: string, limit = 100): Promise<AuditLogEntry[]> {
  const result = await db.query<{ id: string; actor_id: string; actor_name: string | null; action: string; target: string; created_at: string }>(`
    select a.id, a.actor_id, p.full_name as actor_name, a.action, a.target, a.created_at
    from public.audit_log a
    left join public.profiles p on p.id = a.actor_id
    where a.store_id = $1
    order by a.created_at desc, a.id desc
    limit $2`, [storeId, limit])
  return result.rows.map(row => ({ id: row.id, actorId: row.actor_id, actorName: row.actor_name, action: row.action, target: row.target, createdAt: row.created_at }))
}

async function auditLogHandler(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireAuditAccess(req, storeId)
    res.json({ entries: await loadAuditLog(storeId) })
  } catch (reason) { sendApiError(res, reason) }
}
auditRouter.get('/audit-log', (req, res) => void auditLogHandler(req, res))
