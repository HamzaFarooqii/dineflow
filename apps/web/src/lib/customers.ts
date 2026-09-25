import { looksLikePhone, normalizedPhone } from '../../../../packages/domain/src/customer'
import { accessToken, configuredApiUrl } from './catalog'
import { posDb, type LocalCustomer } from './db'
export { createLocalCustomer, searchLocalCustomers } from './customer-local'

export interface CustomerSummary {
  customer_id: string
  visit_count: number
  lifetime_spend_cents: number
  recent_visits: Array<{ order_id: string; total_cents: number; visited_at: string }>
}
export async function fetchCustomerSummary(storeId: string, customerId: string, terminal: boolean): Promise<CustomerSummary> {
  const query = new URLSearchParams()
  if (!terminal) query.set('store_id', storeId)
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/customers' : '/customers'}/${customerId}/summary?${query}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as CustomerSummary & { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Guest history could not be loaded (${response.status}).`)
  return body
}

type SearchResult = { customers: Array<{ id: string; store_id: string; name: string; phone_normalized: string | null }>; next_cursor: string | null }
export async function searchServerCustomers(storeId: string, rawQuery: string, terminal: boolean, cursor: string | null = null): Promise<SearchResult> {
  const query = new URLSearchParams({ limit: '20' })
  if (looksLikePhone(rawQuery)) {
    const phone = normalizedPhone(rawQuery)
    if (!phone) throw new Error('Enter a phone number with its country code.')
    query.set('phone', `+${phone}`)
  } else {
    const name = rawQuery.trim()
    if (!name) throw new Error('Enter a phone number or guest name to search.')
    query.set('name', name)
  }
  if (!terminal) query.set('store_id', storeId)
  if (cursor) query.set('cursor', cursor)
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/customers' : '/customers'}?${query}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as SearchResult & { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Customer search failed (${response.status}).`)
  await posDb.transaction('rw', posDb.customers, async () => {
    for (const result of body.customers) {
      if (result.store_id !== storeId) continue
      const existing = await posDb.customers.get(result.id)
      if (existing && existing.sync_status !== 'synced') continue
      await posDb.customers.put({ id: result.id, store_id: storeId, name: result.name,
        phone_normalized: result.phone_normalized, client_generated_at: existing?.client_generated_at ?? new Date().toISOString(),
        creating_operation_id: existing?.creating_operation_id ?? null, sync_status: 'synced', failure_reason: null })
    }
  })
  return body
}
