import { accessToken, configuredApiUrl } from './catalog'
import type { OutboxEntry } from './db'
import { pushOrdersForStore, retryOrderForStore, type PushReply } from './order-sync-core'

async function sendOrder(entry: OutboxEntry, terminal = false): Promise<PushReply> {
  const entity = entry.entity_type === 'customer' ? 'customers' : 'orders'
  const response = await fetch(`${configuredApiUrl()}${terminal ? `/pos/${entity}` : `/${entity}`}/push`, {
    method: 'POST', credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
    body: entry.payload, signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json().catch(() => ({})) as PushReply['body']
  return { ok: response.ok, status: response.status, body }
}

export function pushPendingOrders(storeId: string, terminal = false): Promise<number> {
  return pushOrdersForStore(storeId, entry => sendOrder(entry, terminal))
}
export function retryOrder(operationId: string, storeId: string, terminal = false): Promise<void> {
  return retryOrderForStore(operationId, storeId, entry => sendOrder(entry, terminal))
}
