import { requireSupabase } from '../lib/supabase'

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
export async function request<T>(path: string, data?: unknown, manager = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (manager) {
    const { data: { session } } = await requireSupabase().auth.getSession()
    if (!session) throw new Error('Sign in with your owner or manager email account.')
    headers.Authorization = `Bearer ${session.access_token}`
  }
  const response = await fetch(`/api${path}`, { method: data === undefined ? 'GET' : 'POST', headers, credentials: 'same-origin', body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15_000) })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ code: 'server_unavailable', message: 'Terminal service unavailable.' })) as { code: string; message: string }
    throw new ApiError(response.status, error.code, error.message)
  }
  return response.status === 204 ? undefined as T : await response.json() as T
}
