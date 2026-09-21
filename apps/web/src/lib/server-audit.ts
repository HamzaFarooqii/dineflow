import { requireSupabase } from './supabase'

export class ServerAuditError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

// Mirrors server-reports.ts's request() (Supabase session -> Authorization: Bearer -> fetch).
async function request<T>(path: string): Promise<T> {
  const { data } = await requireSupabase().auth.getSession()
  const session = data.session
  if (!session) throw new Error('Sign in with your owner or manager email account.')
  const response = await fetch(`/api${path}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ code: 'server_unavailable', message: 'Activity log service unavailable.' })) as { code: string; message: string }
    throw new ServerAuditError(response.status, error.code, error.message)
  }
  return await response.json() as T
}

export interface ServerAuditEntry {
  id: string
  actorId: string
  actorName: string | null
  action: string
  target: string
  createdAt: string
}

export function fetchAuditLog(storeId: string): Promise<ServerAuditEntry[]> {
  return request<{ entries: ServerAuditEntry[] }>(`/audit-log?store_id=${encodeURIComponent(storeId)}`).then(result => result.entries)
}
