import { customerName, looksLikePhone, normalizedPhone } from '../../../../packages/domain/src/customer'
import { posDb, type LocalCustomer, type OutboxEntry } from './db'

export async function createLocalCustomer(storeId: string, rawName: string, rawPhone: string): Promise<LocalCustomer> {
  const name = customerName(rawName), phone = normalizedPhone(rawPhone)
  if (!storeId) throw new Error('Select a store before creating a customer.')
  const id = crypto.randomUUID(), operationId = crypto.randomUUID(), now = new Date().toISOString()
  const customer: LocalCustomer = { id, store_id: storeId, name, phone_normalized: phone,
    client_generated_at: now, creating_operation_id: operationId, sync_status: 'pending', failure_reason: null }
  const payload = { operation_id: operationId, entity_type: 'customer', schema_version: 1,
    customer: { id, store_id: storeId, name, phone_normalized: phone, client_generated_at: now } }
  const outbox: OutboxEntry = { store_id: storeId, operation_id: operationId, order_id: '', entity_type: 'customer',
    depends_on: [], status: 'pending', failure_reason: null, failure_kind: null, reason_code: null,
    attempt_count: 0, lease_owner: null, lease_expires_at: null, accepted_checkpoint: null,
    next_attempt_at: now, created_at: now, payload: JSON.stringify(payload) }
  await posDb.transaction('rw', posDb.customers, posDb.outbox, async () => {
    await posDb.customers.add(customer)
    await posDb.outbox.add(outbox)
  })
  return customer
}

export async function searchLocalCustomers(storeId: string, rawQuery: string): Promise<LocalCustomer[]> {
  const text = rawQuery.trim()
  if (!text) return []
  const all = await posDb.customers.where('store_id').equals(storeId).toArray()
  if (looksLikePhone(text)) {
    const phone = normalizedPhone(rawQuery)
    if (!phone) return []
    return all.filter(customer => customer.phone_normalized?.startsWith(phone)).sort((a, b) => a.name.localeCompare(b.name))
  }
  const needle = text.toLowerCase()
  return all.filter(customer => customer.name.toLowerCase().includes(needle)).sort((a, b) => a.name.localeCompare(b.name))
}
