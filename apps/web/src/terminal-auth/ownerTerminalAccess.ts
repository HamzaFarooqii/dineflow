import { supabase } from '../lib/supabase'

export type OwnerTerminalAccess = 'allowed' | 'mismatch' | 'unknown'

/**
 * Cashier routes ordinarily run without an owner session. When an owner/manager session is
 * present, however, do not show a terminal provisioned for a store that account cannot access.
 * Offline checks remain unknown so a properly provisioned cashier terminal can still operate
 * offline after its owner has left the browser profile.
 */
export async function signedInOwnerTerminalAccess(storeId: string): Promise<OwnerTerminalAccess> {
  if (!supabase || !navigator.onLine) return 'unknown'
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return 'allowed'
  const { data, error } = await supabase.from('store_memberships')
    .select('store_id')
    .eq('user_id', session.user.id)
    .eq('store_id', storeId)
    .eq('active', true)
    .limit(1)
  if (error) return 'unknown'
  return data?.length ? 'allowed' : 'mismatch'
}
