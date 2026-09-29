import { accessToken, configuredApiUrl } from './catalog'

export type DeliveryStatus = 'pending' | 'accepted' | 'picked_up' | 'out_for_delivery' | 'delivered' | 'failed'

export interface DeliveryOrder {
  id: string
  store_id: string
  order_id: string
  recipient_name_snapshot: string
  contact_phone_snapshot: string
  address_snapshot: string
  delivery_instructions_snapshot: string | null
  rider_id: string | null
  rider_name?: string | null
  status: DeliveryStatus
  failure_reason: string | null
  receipt_number?: string
  total_cents?: string
  client_generated_at?: string
  created_at: string
  updated_at: string
  accepted_at: string | null
  picked_up_at: string | null
  out_for_delivery_at: string | null
  delivered_at: string | null
  failed_at: string | null
}

export interface DeliveryStatusEvent {
  id: string
  from_status: DeliveryStatus | null
  to_status: DeliveryStatus
  actor_type: 'rider' | 'manager' | 'system'
  actor_id: string | null
  operation_id: string
  note: string | null
  created_at: string
}

export interface DeliveryKpis {
  by_status: Record<DeliveryStatus, number>
  average_time_to_delivered_seconds: number | null
}

// A stale client tried to move a delivery past a status it no longer sits at — same
// "surface it, never silently overwrite" contract as floor.ts's TableStatusConflictError.
export class DeliveryConflictError extends Error {
  constructor(message: string, public currentStatus?: DeliveryStatus) { super(message) }
}

async function deliveryRequest<T>(path: string, storeId: string, method = 'GET', body?: Record<string, unknown>, terminal = false): Promise<T> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/delivery' : '/delivery'}${path}${method === 'GET' && terminal ? '' : `?${query}`}`, {
    method,
    credentials: terminal ? 'include' : 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as T & { message?: string; code?: string; status?: string }
  if (!response.ok) {
    if (response.status === 409) throw new DeliveryConflictError((parsed as { message?: string }).message ?? 'This delivery changed since it was last loaded.', (parsed as { status?: string }).status as DeliveryStatus | undefined)
    throw new Error((parsed as { message?: string }).message ?? `Request failed (${response.status}).`)
  }
  return parsed
}

// --- Owner dispatch -------------------------------------------------------------------------

export async function fetchDispatchList(storeId: string, status?: DeliveryStatus): Promise<DeliveryOrder[]> {
  const query = new URLSearchParams({ store_id: storeId })
  if (status) query.set('status', status)
  const response = await fetch(`${configuredApiUrl()}/delivery?${query}`, {
    credentials: 'same-origin',
    headers: { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { deliveries?: DeliveryOrder[]; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Dispatch list could not be loaded (${response.status}).`)
  return body.deliveries ?? []
}

export async function fetchDispatchKpis(storeId: string): Promise<DeliveryKpis> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}/delivery/kpis?${query}`, {
    credentials: 'same-origin',
    headers: { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as DeliveryKpis & { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Delivery KPIs could not be loaded (${response.status}).`)
  return body
}

export async function fetchDeliveryTimeline(storeId: string, deliveryId: string): Promise<DeliveryStatusEvent[]> {
  const result = await deliveryRequest<{ events: DeliveryStatusEvent[] }>(`/${deliveryId}/events`, storeId)
  return result.events
}

export async function assignRider(storeId: string, deliveryId: string, riderId: string | null): Promise<DeliveryOrder> {
  return deliveryRequest<DeliveryOrder>(`/${deliveryId}/rider`, storeId, 'PATCH', { rider_id: riderId })
}

// Manager-driven transition (e.g. marking a delivery failed by hand). expectedStatus/operationId
// follow the same optimistic-concurrency + idempotency contract as the rider-side one below.
export async function ownerTransitionDelivery(
  storeId: string, deliveryId: string, expectedStatus: DeliveryStatus, status: DeliveryStatus, operationId: string, failureReason?: string,
): Promise<DeliveryOrder> {
  return deliveryRequest<DeliveryOrder>(`/${deliveryId}/status`, storeId, 'PATCH', {
    expected_status: expectedStatus, status, operation_id: operationId, failure_reason: failureReason ?? undefined,
  })
}

// --- Rider terminal ---------------------------------------------------------------------------

export async function fetchMyDeliveries(storeId: string): Promise<DeliveryOrder[]> {
  const response = await fetch(`${configuredApiUrl()}/pos/delivery/mine`, {
    credentials: 'include',
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { deliveries?: DeliveryOrder[]; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Deliveries could not be loaded (${response.status}).`)
  return body.deliveries ?? []
}

// The rider's device always sends the status it believes the delivery is transitioning FROM
// (expectedStatus) plus a fresh operationId it generates once per tap. A 409 here means the
// server's state has moved on since this device last saw it — the caller must show that
// conflict to the rider (e.g. "Someone already marked this delivered — refresh"), never retry
// blindly with the same expectedStatus.
export async function advanceMyDelivery(
  storeId: string, deliveryId: string, expectedStatus: DeliveryStatus, status: DeliveryStatus, operationId: string, failureReason?: string,
): Promise<DeliveryOrder> {
  return deliveryRequest<DeliveryOrder>(`/${deliveryId}/status`, storeId, 'PATCH', {
    expected_status: expectedStatus, status, operation_id: operationId, failure_reason: failureReason ?? undefined,
  }, true)
}

export function newOperationId(): string {
  return crypto.randomUUID()
}
