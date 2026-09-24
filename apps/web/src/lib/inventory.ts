import type { StockMovementReason } from '../../../../packages/domain/src/stock-movement-reason'
import { accessToken, configuredApiUrl } from './catalog'
import type { ManagerApprovalEvidence } from '../terminal-auth/ManagerApprovalModal'

export interface Ingredient {
  id: string
  store_id: string
  name: string
  unit_id: string
  cost_per_unit_cents: number
  current_stock: string
  reorder_threshold: string | null
  active: boolean
  created_by_user_id: string | null
  created_by_name: string | null
}

export interface IngredientBatch {
  id: string
  store_id: string
  ingredient_id: string
  quantity: string
  received_at: string
  expires_at: string | null
  cost_per_unit_cents: number
}

export interface StockMovement {
  id: string
  store_id: string
  ingredient_id: string
  batch_id: string | null
  delta: string
  reason: StockMovementReason
  note: string | null
  kitchen_ticket_item_id: string | null
  created_at: string
  created_by_user_id: string | null
  created_by_name: string | null
}

export interface StockMovementsPage { movements: StockMovement[]; next_cursor: string | null }

// A cashier terminal has no Supabase session — writes go to /pos/inventory over the
// HttpOnly terminal cookies (credentials: 'include', no Authorization header), same as
// floor.ts's/kitchen.ts's terminal fetch functions. A write also needs manager evidence
// (manager_id + manager_approved_at); the PIN itself is verified client-side and never sent —
// see ManagerApprovalModal/verifyOffline.
function managerEvidenceBody(approval: ManagerApprovalEvidence | null): Record<string, unknown> {
  return { manager_id: approval?.managerId ?? null, manager_approved_at: approval?.approvedAt ?? null }
}

async function inventoryRequest<T>(path: string, method: string, storeId: string, terminal: boolean, body?: Record<string, unknown>): Promise<T> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/inventory' : '/inventory'}${path}?${query}`, {
    method,
    credentials: terminal ? 'include' : 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as T & { message?: string; code?: string }
  if (!response.ok) {
    if (response.status === 422) throw new WastageValidationError((parsed as { message?: string }).message ?? 'This entry is invalid.')
    throw new Error((parsed as { message?: string }).message ?? `Request failed (${response.status}).`)
  }
  return parsed
}

export class WastageValidationError extends Error {}

export async function fetchIngredients(storeId: string, terminal = false, includeInactive = false): Promise<Ingredient[]> {
  const query = new URLSearchParams({ store_id: storeId })
  if (includeInactive) query.set('include_inactive', 'true')
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/inventory' : '/inventory'}/ingredients?${query}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? {} : { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { ingredients?: Ingredient[]; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Ingredients could not be loaded (${response.status}).`)
  return body.ingredients ?? []
}

export async function createIngredient(storeId: string, input: { name: string; unit_id: string; cost_per_unit_cents: number; reorder_threshold?: number | null }, terminal = false, approval: ManagerApprovalEvidence | null = null): Promise<Ingredient> {
  return inventoryRequest<Ingredient>('/ingredients', 'POST', storeId, terminal, { ...input, ...(terminal ? managerEvidenceBody(approval) : {}) })
}
export async function updateIngredient(storeId: string, ingredientId: string, patch: Partial<{ name: string; unit_id: string; cost_per_unit_cents: number; reorder_threshold: number | null }>, terminal = false, approval: ManagerApprovalEvidence | null = null): Promise<Ingredient> {
  return inventoryRequest<Ingredient>(`/ingredients/${ingredientId}`, 'PATCH', storeId, terminal, { ...patch, ...(terminal ? managerEvidenceBody(approval) : {}) })
}
export async function deactivateIngredient(storeId: string, ingredientId: string, terminal = false, approval: ManagerApprovalEvidence | null = null): Promise<Ingredient> {
  return inventoryRequest<Ingredient>(`/ingredients/${ingredientId}/deactivate`, 'PATCH', storeId, terminal, terminal ? managerEvidenceBody(approval) : undefined)
}

export async function recordIngredientBatch(storeId: string, ingredientId: string, input: { quantity: number; cost_per_unit_cents: number; expires_at?: string | null; received_at?: string | null }, terminal = false, approval: ManagerApprovalEvidence | null = null): Promise<{ batch: IngredientBatch; movement: StockMovement; ingredient: Ingredient }> {
  return inventoryRequest(`/ingredients/${ingredientId}/batches`, 'POST', storeId, terminal, { ...input, ...(terminal ? managerEvidenceBody(approval) : {}) })
}

export async function fetchIngredientBatches(storeId: string, ingredientId: string, terminal = false): Promise<IngredientBatch[]> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/inventory' : '/inventory'}/ingredients/${ingredientId}/batches?${query}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? {} : { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { batches?: IngredientBatch[]; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Batches could not be loaded (${response.status}).`)
  return body.batches ?? []
}

export async function fetchStockMovements(storeId: string, ingredientId: string, terminal = false, before?: string | null, limit = 50): Promise<StockMovementsPage> {
  const query = new URLSearchParams({ store_id: storeId, limit: String(limit) })
  if (before) query.set('before', before)
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/inventory' : '/inventory'}/ingredients/${ingredientId}/movements?${query}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? {} : { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as Partial<StockMovementsPage> & { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Stock movements could not be loaded (${response.status}).`)
  return { movements: body.movements ?? [], next_cursor: body.next_cursor ?? null }
}

export async function recordWastage(storeId: string, ingredientId: string, input: { quantity: number; note?: string | null }, terminal = false, approval: ManagerApprovalEvidence | null = null): Promise<{ movement: StockMovement; ingredient: Ingredient }> {
  return inventoryRequest(`/ingredients/${ingredientId}/wastage`, 'POST', storeId, terminal, { ...input, ...(terminal ? managerEvidenceBody(approval) : {}) })
}
