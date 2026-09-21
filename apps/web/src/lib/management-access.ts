import { activeStoreId } from './catalog'
import { posDb } from './db'
import { requireSupabase } from './supabase'

export interface FinancialAccess { storeId: string; role: 'owner' | 'manager' }

function isFinancialRole(role: unknown): role is FinancialAccess['role'] {
  return role === 'owner' || role === 'manager'
}

export async function resolveFinancialAccess(): Promise<FinancialAccess> {
  const client = requireSupabase()
  const { data: sessionResult } = await client.auth.getSession()
  const user = sessionResult.session?.user
  if (!user) throw new Error('Sign in to view reporting.')
  const key = `financial_access:${user.id}`
  if (!navigator.onLine) {
    const cached = await posDb.sync_metadata.get(key)
    if (!cached) throw new Error('Connect once to validate reporting access.')
    const parsed = JSON.parse(cached.value) as FinancialAccess & { validatedAt: string }
    if (!isFinancialRole(parsed.role) || Date.now() - Date.parse(parsed.validatedAt) >= 7 * 24 * 60 * 60 * 1000) {
      throw new Error('Offline reporting authorization has expired. Connect to validate access.')
    }
    return { storeId: parsed.storeId, role: parsed.role }
  }
  const storeId = await activeStoreId()
  const { data, error } = await client.from('store_memberships').select('role').eq('user_id', user.id)
    .eq('store_id', storeId).eq('active', true).limit(1)
  if (error) throw error
  const role = data?.[0]?.role
  if (!isFinancialRole(role)) {
    await posDb.sync_metadata.delete(key)
    throw new Error('Detailed financial reporting is currently available to store owners and managers only.')
  }
  await posDb.sync_metadata.put({ key, value: JSON.stringify({ storeId, role, validatedAt: new Date().toISOString() }) })
  return { storeId, role }
}
