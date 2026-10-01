import type { StockMovementReason } from '../../../../packages/domain/src/stock-movement-reason'
import type { WastageCategory, WastageStockEffect } from '../../../../packages/domain/src/wastage-category'
import { authenticatedFetch, configuredApiUrl } from './catalog'
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
  updated_at: string
  active_batch_count: number
  nearest_expiry: string | null
}

export interface IngredientBatch {
  id: string
  store_id: string
  ingredient_id: string
  quantity: string
  remaining_quantity: string
  received_at: string
  expires_at: string | null
  cost_per_unit_cents: number
  reference: string | null
  received_by_name: string | null
  // Drawn from this batch by cost-snapshot allocations (Day 2). Draw-downs recorded before
  // snapshots existed are not itemised, so these can be lower than quantity - remaining_quantity.
  allocation_count: number
  consumed_quantity: string
  wasted_quantity: string
  allocated_cost_cents: string
}

export type CostBasis = 'batch' | 'estimated_ingredient_cost'
export interface MovementAllocation {
  batch_id: string | null
  quantity: string
  unit_cost_cents: number
  cost_cents: string
  cost_basis: CostBasis
}
export type ApprovalMethod = 'web_manager_session' | 'terminal_verified_token' | 'terminal_legacy_evidence'

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
  // Day 2. wastage_category/stock_effect are null on rows recorded before categories existed;
  // cost_source 'unknown' means no cost evidence (never priced at today's ingredient cost).
  wastage_category: WastageCategory | null
  stock_effect: WastageStockEffect | null
  approval_method: ApprovalMethod | null
  approval_required: boolean | null
  approval_threshold_cents: number | null
  approved_by_name: string | null
  cost_source: 'allocation_snapshot' | 'legacy_batch_derived' | 'unknown' | null
  known_cost_cents: string | null
  estimated_cost_cents: string | null
  allocations: MovementAllocation[]
}

export interface StockMovementsPage { movements: StockMovement[]; next_cursor: string | null }

// A cashier terminal has no Supabase session — writes go to /pos/inventory over the
// HttpOnly terminal cookies (credentials: 'include', no Authorization header), same as
// floor.ts's/kitchen.ts's terminal fetch functions. A write also needs manager evidence
// (manager_id + manager_approved_at); the PIN itself is verified client-side and never sent —
// see ManagerApprovalModal/verifyOffline.
function managerEvidenceBody(approval: ManagerApprovalEvidence | null): Record<string, unknown> {
  // A server-verified approval token (Day 1) is the strong evidence and wins when present; the
  // legacy manager_id/manager_approved_at pair stays only for the actions that have not moved over.
  if (approval?.approvalToken) return { manager_approval_token: approval.approvalToken }
  return { manager_id: approval?.managerId ?? null, manager_approved_at: approval?.approvedAt ?? null }
}

function inventoryFetch(url: string, terminal: boolean, init: RequestInit = {}): Promise<Response> {
  if (terminal) return fetch(url, { ...init, credentials: 'include' })
  return authenticatedFetch(url, { ...init, credentials: 'same-origin' })
}

async function inventoryRequest<T>(path: string, method: string, storeId: string, terminal: boolean, body?: Record<string, unknown>): Promise<T> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await inventoryFetch(`${configuredApiUrl()}${terminal ? '/pos/inventory' : '/inventory'}${path}?${query}`, terminal, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as T & { message?: string; code?: string }
  if (!response.ok) {
    const message = (parsed as { message?: string }).message
    const code = (parsed as { code?: string }).code ?? null
    if (response.status === 422) throw new WastageValidationError(message ?? 'This entry is invalid.', response.status, code)
    throw new InventoryRequestError(message ?? `Request failed (${response.status}).`, response.status, code)
  }
  return parsed
}

/** A failed inventory request. `code` is the API's machine-readable reason (e.g. operation_conflict). */
export class InventoryRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) { super(message) }
}
export class WastageValidationError extends InventoryRequestError {}

export async function fetchIngredients(storeId: string, terminal = false, includeInactive = false): Promise<Ingredient[]> {
  const query = new URLSearchParams({ store_id: storeId })
  if (includeInactive) query.set('include_inactive', 'true')
  const response = await inventoryFetch(`${configuredApiUrl()}${terminal ? '/pos/inventory' : '/inventory'}/ingredients?${query}`, terminal, {
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
export async function reactivateIngredient(storeId: string, ingredientId: string, terminal = false, approval: ManagerApprovalEvidence | null = null): Promise<Ingredient> {
  return inventoryRequest<Ingredient>(`/ingredients/${ingredientId}/reactivate`, 'PATCH', storeId, terminal, terminal ? managerEvidenceBody(approval) : undefined)
}

export async function recordIngredientBatch(storeId: string, ingredientId: string, input: { quantity: number; cost_per_unit_cents: number; expires_at?: string | null; received_at?: string | null; reference?: string | null }, terminal = false, approval: ManagerApprovalEvidence | null = null): Promise<{ batch: IngredientBatch; movement: StockMovement; ingredient: Ingredient }> {
  return inventoryRequest(`/ingredients/${ingredientId}/batches`, 'POST', storeId, terminal, { ...input, ...(terminal ? managerEvidenceBody(approval) : {}) })
}

export async function fetchIngredientBatches(storeId: string, ingredientId: string, terminal = false): Promise<IngredientBatch[]> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await inventoryFetch(`${configuredApiUrl()}${terminal ? '/pos/inventory' : '/inventory'}/ingredients/${ingredientId}/batches?${query}`, terminal, {
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { batches?: IngredientBatch[]; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Batches could not be loaded (${response.status}).`)
  return body.batches ?? []
}

export async function fetchStockMovements(storeId: string, ingredientId: string, terminal = false, before?: string | null, limit = 50): Promise<StockMovementsPage> {
  const query = new URLSearchParams({ store_id: storeId, limit: String(limit) })
  if (before) query.set('before', before)
  const response = await inventoryFetch(`${configuredApiUrl()}${terminal ? '/pos/inventory' : '/inventory'}/ingredients/${ingredientId}/movements?${query}`, terminal, {
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as Partial<StockMovementsPage> & { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Stock movements could not be loaded (${response.status}).`)
  return { movements: body.movements ?? [], next_cursor: body.next_cursor ?? null }
}

export interface WastageInput {
  /** Stable per attempt: a retry of the same entry reuses it, so it can only ever be recorded once. */
  operation_id: string
  quantity: number
  wastage_category: WastageCategory
  stock_effect?: WastageStockEffect
  note?: string | null
  batch_id?: string | null
  kitchen_ticket_item_id?: string | null
}

export async function recordWastage(storeId: string, ingredientId: string, input: WastageInput, terminal = false, approval: ManagerApprovalEvidence | null = null): Promise<{ movement: StockMovement; ingredient: Ingredient; replayed: boolean }> {
  return inventoryRequest(`/ingredients/${ingredientId}/wastage`, 'POST', storeId, terminal, { ...input, ...(terminal ? managerEvidenceBody(approval) : {}) })
}

export interface WastagePolicy { wastage_approval_threshold_cents: number; is_default: boolean }

export async function fetchWastagePolicy(storeId: string, terminal = false): Promise<WastagePolicy> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await inventoryFetch(`${configuredApiUrl()}${terminal ? '/pos/inventory' : '/inventory'}/wastage-policy?${query}`, terminal, { signal: AbortSignal.timeout(15_000) })
  const body = await response.json().catch(() => ({})) as Partial<WastagePolicy> & { message?: string }
  if (!response.ok) throw new Error(body.message ?? `The wastage approval policy could not be loaded (${response.status}).`)
  return { wastage_approval_threshold_cents: body.wastage_approval_threshold_cents ?? 0, is_default: body.is_default ?? true }
}

/**
 * Asks the server to verify a manager's PIN for ONE exact action and payload (POST /pos/manager-approvals,
 * Day 1) and returns the single-use approval token. The PIN goes to the server and is never stored here.
 */
export async function requestManagerApprovalToken(managerId: string, pin: string, action: string, payload: unknown): Promise<{ token: string; expiresAt: string }> {
  const response = await fetch(`${configuredApiUrl()}/pos/manager-approvals`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manager_id: managerId, pin, action, payload }), signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { approval_token?: string; expires_at?: string; message?: string }
  if (!response.ok || !body.approval_token) throw new Error(body.message ?? `The manager PIN could not be verified (${response.status}).`)
  return { token: body.approval_token, expiresAt: body.expires_at ?? '' }
}

export async function fetchExpiringBatchCount(storeId: string, terminal = false): Promise<number> {
  const query = new URLSearchParams({ store_id: storeId })
  const response = await inventoryFetch(`${configuredApiUrl()}${terminal ? '/pos/inventory' : '/inventory'}/summary?${query}`, terminal, {
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as { expiring_batches_count?: number; message?: string }
  if (!response.ok) throw new Error(body.message ?? `Inventory summary could not be loaded (${response.status}).`)
  return body.expiring_batches_count ?? 0
}
