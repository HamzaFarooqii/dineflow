import type { Request } from 'express'
import { createClient } from '@supabase/supabase-js'
import { db } from '../db.js'

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

export async function requireStoreMember(req: Request, storeId: string) {
  const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1]
  if (!token) throw new ApiError(401, 'authentication_required', 'Sign in to load this store.')
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new ApiError(503, 'server_unavailable', 'API authentication is not configured.')
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.auth.getUser(token)
  if (error || !data.user) throw new ApiError(401, 'authentication_required', 'Your session is no longer valid.')
  const membership = await db.query(
    'select 1 from public.store_memberships where store_id = $1 and user_id = $2 and active = true',
    [storeId, data.user.id],
  )
  if (!membership.rowCount) throw new ApiError(403, 'cross_store_reference', 'You cannot access this store.')
  return data.user.id
}

/** Like requireStoreMember, but also requires the caller's role in this store to be owner or manager. */
export async function requireStoreManager(req: Request, storeId: string): Promise<string> {
  const userId = await requireStoreMember(req, storeId)
  const result = await db.query<{ role: string }>(
    'select role from public.store_memberships where store_id=$1 and user_id=$2 and active=true',
    [storeId, userId],
  )
  if (!['owner', 'manager'].includes(result.rows[0]?.role ?? '')) {
    throw new ApiError(403, 'authorization_failed', 'This action requires an owner or manager role.')
  }
  return userId
}

export function sendApiError(res: import('express').Response, reason: unknown) {
  if (reason instanceof ApiError) res.status(reason.status).json({ status: 'rejected', code: reason.code, message: reason.message })
  else {
    console.error(reason)
    const code = typeof reason === 'object' && reason !== null && 'code' in reason ? String(reason.code) : ''
    if (['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH'].includes(code)) {
      res.status(503).json({ code: 'database_unreachable', message: 'Store database is unreachable. Ask your administrator to check the API database connection.' })
    } else if (code === '42P01') {
      res.status(503).json({ code: 'pos_not_initialized', message: 'POS data is not initialized. Ask your administrator to apply the catalog migration.' })
    } else if (code === '23505') {
      res.status(409).json({ status: 'rejected', code: 'receipt_number_conflict', message: 'A sale already uses this receipt or payment identity. Keep this paid sale for reconciliation.' })
    } else if (['23503', '23514', '22003'].includes(code)) {
      res.status(422).json({ status: 'rejected', code: 'validation_failed', message: 'The sale references invalid catalog data or exceeds database limits. Keep it for reconciliation.' })
    } else {
      res.status(503).json({ code: 'server_unavailable', message: 'The API could not complete this request.' })
    }
  }
}
