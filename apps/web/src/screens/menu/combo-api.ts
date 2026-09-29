import { authenticatedFetch, configuredApiUrl } from '../../lib/catalog'
import type { LocalCombo } from '../../lib/db'

export interface ComboGroupDraft {
  name: string
  min_select: number
  max_select: number
  options: { component_product_id: string; price_delta_cents: number }[]
}

export async function saveCombo(storeId: string, productId: string, pricingMode: 'fixed' | 'derived', groups: ComboGroupDraft[]): Promise<LocalCombo> {
  const response = await authenticatedFetch(`${configuredApiUrl()}/catalog/products/${encodeURIComponent(productId)}/combo`, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store_id: storeId, pricing_mode: pricingMode, groups }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as (Partial<LocalCombo> & { message?: string })
  if (!response.ok || !body.groups) throw new Error(body.message ?? 'Combo could not be saved.')
  return { product_id: productId, pricing_mode: pricingMode, groups: body.groups }
}

export async function deleteCombo(storeId: string, productId: string): Promise<void> {
  const response = await authenticatedFetch(`${configuredApiUrl()}/catalog/products/${encodeURIComponent(productId)}/combo?store_id=${encodeURIComponent(storeId)}`, {
    method: 'DELETE', credentials: 'same-origin', signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok && response.status !== 204) {
    const body = await response.json().catch(() => ({})) as { message?: string }
    throw new Error(body.message ?? 'Combo could not be removed.')
  }
}
