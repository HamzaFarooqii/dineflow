import { accessToken, configuredApiUrl } from '../../lib/catalog'
import type { LocalModifierGroup } from '../../lib/db'
import { parseModifierDraft, type ModifierGroupDraft } from './modifier-draft'
export { draftFromModifierGroups, parseModifierDraft, type ModifierGroupDraft, type ModifierOptionDraft } from './modifier-draft'

export async function saveModifierGroups(storeId: string, productId: string, draft: ModifierGroupDraft[]): Promise<LocalModifierGroup[]> {
  const response = await fetch(`${configuredApiUrl()}/catalog/products/${encodeURIComponent(productId)}/modifiers`, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
    body: JSON.stringify({ store_id: storeId, groups: parseModifierDraft(draft) }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { groups?: LocalModifierGroup[]; message?: string }
  if (!response.ok || !body.groups) throw new Error(body.message ?? 'Modifiers could not be saved.')
  return body.groups
}
