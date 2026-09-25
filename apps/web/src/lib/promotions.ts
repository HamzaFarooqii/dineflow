import { accessToken, configuredApiUrl } from './catalog'

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
