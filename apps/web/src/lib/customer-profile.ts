import { accessToken, configuredApiUrl } from './catalog'

export interface PreferenceEvent {
  id: string
  store_id: string
  customer_id: string
  kind: 'favorite' | 'preference'
  label: string
  note: string | null
  action: 'add' | 'remove'
  created_by_user_id: string | null
  created_at: string
}

export interface PreferenceState {
  current: PreferenceEvent[]
  history: PreferenceEvent[]
}

export interface CustomerRecord {
  id: string
  store_id: string
  name: string
  phone_normalized: string | null
  active: boolean
  updated_at: string
}

export interface CustomerMerge {
  id: string
  store_id: string
  source_customer_id: string
  target_customer_id: string
  actor_user_id: string
  reason: string
  created_at: string
}

// Same transport split as loyalty.ts/inventory.ts: a cashier terminal goes to /pos/customers over
// its HttpOnly cookies (read-only here); the management web app goes to /customers with the
// Supabase bearer token, which is also what makes the merge endpoint (management-only) inherently
// require a live, authenticated, online session -- there is no terminal/offline path to it.
async function customerRequest<T>(path: string, storeId: string, terminal: boolean, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const query = new URLSearchParams(terminal ? {} : { store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/customers' : '/customers'}${path}?${query}`, {
    method: init.method ?? 'GET',
    credentials: terminal ? 'include' : 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as T & { message?: string }
  if (!response.ok) throw new Error(parsed.message ?? `Guest profile request failed (${response.status}).`)
  return parsed
}

export async function fetchCustomerProfile(storeId: string, customerId: string): Promise<CustomerRecord> {
  return customerRequest<CustomerRecord>(`/${encodeURIComponent(customerId)}`, storeId, false)
}

export async function updateCustomerProfile(storeId: string, customerId: string, changes: { name?: string; phone_normalized?: string | null }): Promise<CustomerRecord> {
  return customerRequest<CustomerRecord>(`/${encodeURIComponent(customerId)}`, storeId, false, { method: 'PATCH', body: changes })
}

export async function setCustomerActive(storeId: string, customerId: string, active: boolean): Promise<CustomerRecord> {
  return customerRequest<CustomerRecord>(`/${encodeURIComponent(customerId)}/${active ? 'reactivate' : 'deactivate'}`, storeId, false, { method: 'POST' })
}

export async function fetchPreferences(storeId: string, customerId: string, terminal: boolean): Promise<PreferenceState> {
  return customerRequest<PreferenceState>(`/${encodeURIComponent(customerId)}/preferences`, storeId, terminal)
}

export async function addPreference(storeId: string, customerId: string, entry: { kind: 'favorite' | 'preference'; label: string; note?: string }): Promise<PreferenceEvent> {
  return customerRequest<PreferenceEvent>(`/${encodeURIComponent(customerId)}/preferences`, storeId, false, { method: 'POST', body: entry })
}

export async function removePreference(storeId: string, customerId: string, entry: { kind: 'favorite' | 'preference'; label: string }): Promise<PreferenceEvent> {
  return customerRequest<PreferenceEvent>(`/${encodeURIComponent(customerId)}/preferences/remove`, storeId, false, { method: 'POST', body: entry })
}

// Manager-only, online-only. There is deliberately no `terminal` parameter here -- merge is never
// reachable from an offline terminal session; see customer-profile.ts's server-side comment.
export async function mergeCustomers(storeId: string, sourceCustomerId: string, targetCustomerId: string, reason: string): Promise<CustomerMerge> {
  return customerRequest<CustomerMerge>('/merge', storeId, false, { method: 'POST', body: { source_customer_id: sourceCustomerId, target_customer_id: targetCustomerId, reason } })
}
