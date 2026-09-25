import { accessToken, configuredApiUrl } from './catalog'
import { activePromotions } from '../../../../packages/domain/src/promotions'

export interface Promotion {
  id: string
  store_id: string
  name: string
  discount_kind: 'percent' | 'fixed'
  discount_value: number
  starts_at: string | null
  ends_at: string | null
  active: boolean
}

async function promotionsRequest<T>(path: string, method: string, storeId: string, body?: Record<string, unknown>): Promise<T> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}/promotions${path}?${query}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as T & { message?: string }
  if (!response.ok) throw new Error((parsed as { message?: string }).message ?? `Request failed (${response.status}).`)
  return parsed
}

export async function fetchPromotions(storeId: string): Promise<Promotion[]> {
  const result = await promotionsRequest<{ promotions: Promotion[] }>('', 'GET', storeId)
  return result.promotions
}

function toDomain(promotion: Promotion) {
  return {
    id: promotion.id, storeId: promotion.store_id, name: promotion.name,
    discountKind: promotion.discount_kind, discountValue: promotion.discount_value,
    startsAt: promotion.starts_at ? new Date(promotion.starts_at) : null,
    endsAt: promotion.ends_at ? new Date(promotion.ends_at) : null, active: promotion.active,
  }
}

// Only the promotions a cashier can actually apply right now — active and within their window
// (packages/domain/src/promotions.ts's activePromotions). The web register (owner/manager,
// always a Supabase session) reuses the management GET and filters client-side; a cashier
// terminal has no Supabase session and no access to the management endpoint at all, so it goes
// through the dedicated read-only /pos/promotions route instead (Day 4 checkout-wiring gap: the
// management screen was owner/manager-only by design, but nothing let a terminal even *read*
// promotions to apply one until this).
export async function fetchActivePromotions(storeId: string, terminal: boolean): Promise<Promotion[]> {
  if (!terminal) {
    const all = await fetchPromotions(storeId)
    const eligible = new Set(activePromotions(all.map(toDomain), new Date()).map(promotion => promotion.id))
    return all.filter(promotion => eligible.has(promotion.id))
  }
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}/pos/promotions?${query}`, {
    credentials: 'include',
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as { promotions?: Promotion[]; message?: string }
  if (!response.ok) throw new Error(parsed.message ?? `Request failed (${response.status}).`)
  return parsed.promotions ?? []
}

export interface PromotionInput {
  name: string
  discount_kind: 'percent' | 'fixed'
  discount_value: number
  starts_at: string | null
  ends_at: string | null
}

export async function createPromotion(storeId: string, input: PromotionInput): Promise<Promotion> {
  return promotionsRequest<Promotion>('', 'POST', storeId, { ...input })
}

export async function updatePromotion(storeId: string, promotionId: string, patch: Partial<PromotionInput> & { active?: boolean }): Promise<Promotion> {
  return promotionsRequest<Promotion>(`/${promotionId}`, 'PATCH', storeId, patch)
}
