// Database side of Day 2's batch allocation (pure maths: packages/domain/src/stock-allocation.ts).
// Shared by KDS consumption (routes/kitchen.ts) and explicit wastage (routes/inventory.ts) so the
// two can never disagree about how stock leaves an ingredient.
//
// LOCK ORDER (every writer, no exceptions, so concurrent consumption/wastage/receiving cannot
// deadlock): 1) the ingredient row, 2) that ingredient's batch rows in physical picking order
// (expires_at asc nulls last, received_at asc, id asc), 3) inserts. Callers touching several
// ingredients in one transaction visit them in ascending ingredient id.
import type { PoolClient } from 'pg'
import {
  allocateAcrossSources, microCentsToString, microToString, singleCoveringBatchId, toMicro, totalCostMicroCents,
  type AllocationPlan, type AllocationSource,
} from '../../../../packages/domain/src/stock-allocation.js'
import type { WastageCategory, WastageStockEffect } from '../../../../packages/domain/src/wastage-category.js'

export type Queryable = Pick<PoolClient, 'query'>

export interface LockedIngredient { currentStock: string; costPerUnitCents: number; unitId: string; active: boolean }

export async function lockIngredient(client: Queryable, storeId: string, ingredientId: string): Promise<LockedIngredient | null> {
  const row = await client.query<{ current_stock: string; cost_per_unit_cents: number; unit_id: string; active: boolean }>(
    'select current_stock::text as current_stock, cost_per_unit_cents, unit_id, active from public.ingredients where store_id = $1 and id = $2 for update',
    [storeId, ingredientId],
  )
  const found = row.rows[0]
  return found ? { currentStock: found.current_stock, costPerUnitCents: found.cost_per_unit_cents, unitId: found.unit_id, active: found.active } : null
}

/**
 * Batches that can still supply stock, locked in physical picking order. `onlyBatchId` restricts to
 * one batch (explicit selection); the store AND ingredient filters mean a batch from another store
 * or another ingredient simply is not found.
 */
export async function loadBatchSources(client: Queryable, storeId: string, ingredientId: string, onlyBatchId: string | null = null): Promise<AllocationSource[]> {
  const result = await client.query<{ id: string; remaining_quantity: string; cost_per_unit_cents: number }>(
    `select id, remaining_quantity::text as remaining_quantity, cost_per_unit_cents
     from public.ingredient_batches
     where store_id = $1 and ingredient_id = $2 and remaining_quantity > 0 and ($3::uuid is null or id = $3)
     order by expires_at asc nulls last, received_at asc, id asc
     for update`,
    [storeId, ingredientId, onlyBatchId],
  )
  return result.rows.map(row => ({
    sourceId: row.id, batchId: row.id, remainingMicro: toMicro(row.remaining_quantity),
    unitCostCents: row.cost_per_unit_cents, basis: 'batch' as const,
  }))
}

export function planStockOut(sources: readonly AllocationSource[], quantityMicro: bigint, ingredientCostCents: number): AllocationPlan {
  return allocateAcrossSources(sources, quantityMicro, ingredientCostCents)
}

export interface MovementColumns {
  reason: 'consumption' | 'wastage'
  note?: string | null
  kitchenTicketItemId?: string | null
  createdByUserId?: string | null
  createdByEmployeeId?: string | null
  managerId?: string | null
  managerApprovedAt?: string | null
  wastageCategory?: WastageCategory | null
  stockEffect?: WastageStockEffect | null
  operationId?: string | null
  payloadHash?: string | null
  approvalMethod?: 'web_manager_session' | 'terminal_verified_token' | 'terminal_legacy_evidence' | null
  approvalRequired?: boolean | null
  approvalThresholdCents?: number | null
}

/**
 * Writes the movement, its allocation rows, and (for a real deduction) the batch and aggregate
 * stock changes -- all on the caller's transaction, so they commit or roll back together.
 * `deduct: false` is the already-consumed wastage path: the movement and its allocations are
 * recorded for cost visibility but no stock moves (delta 0).
 */
export async function commitStockOut(client: Queryable, storeId: string, ingredientId: string, plan: AllocationPlan, quantityMicro: bigint, columns: MovementColumns, deduct = true): Promise<string> {
  const deltaText = deduct ? `-${microToString(quantityMicro)}` : '0'
  const movement = await client.query<{ id: string }>(
    `insert into public.stock_movements (store_id, ingredient_id, batch_id, delta, reason, note, kitchen_ticket_item_id,
        created_by_user_id, created_by_employee_id, manager_id, manager_approved_at,
        wastage_category, stock_effect, operation_id, payload_hash, approval_method, approval_required, approval_threshold_cents)
     values ($1,$2,$3,$4::numeric,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
    [storeId, ingredientId, deduct ? singleCoveringBatchId(plan, quantityMicro) : null, deltaText, columns.reason, columns.note ?? null,
      columns.kitchenTicketItemId ?? null, columns.createdByUserId ?? null, columns.createdByEmployeeId ?? null,
      columns.managerId ?? null, columns.managerApprovedAt ?? null, columns.wastageCategory ?? null, columns.stockEffect ?? null,
      columns.operationId ?? null, columns.payloadHash ?? null, columns.approvalMethod ?? null, columns.approvalRequired ?? null,
      columns.approvalThresholdCents ?? null],
  )
  const movementId = movement.rows[0].id
  let sequence = 1
  for (const allocation of plan.allocations) {
    await client.query(
      `insert into public.stock_movement_allocations (store_id, stock_movement_id, ingredient_id, batch_id, sequence, quantity,
          unit_cost_cents, cost_cents, cost_basis, source_allocation_id)
       values ($1,$2,$3,$4,$5,$6::numeric,$7,$8::numeric,$9,$10)`,
      [storeId, movementId, ingredientId, allocation.batchId, sequence++, microToString(allocation.quantityMicro),
        allocation.unitCostCents, microCentsToString(allocation.costMicroCents), allocation.basis, allocation.sourceId && !deduct ? allocation.sourceId : null],
    )
    if (deduct && allocation.batchId) {
      await client.query(
        'update public.ingredient_batches set remaining_quantity = remaining_quantity - $1::numeric where store_id = $2 and id = $3 and ingredient_id = $4',
        [microToString(allocation.quantityMicro), storeId, allocation.batchId, ingredientId],
      )
    }
  }
  if (deduct) {
    await client.query(
      'update public.ingredients set current_stock = current_stock - $1::numeric, updated_at = now() where store_id = $2 and id = $3',
      [microToString(quantityMicro), storeId, ingredientId],
    )
  }
  return movementId
}

export function planCostMicroCents(plan: AllocationPlan): bigint {
  return totalCostMicroCents(plan.allocations)
}

// --- Already-consumed wastage (returned dishes) --------------------------------------------------

export interface ConsumptionReference { consumedMicro: bigint; reclassifiedMicro: bigint; sources: AllocationSource[] }

/**
 * What a served kitchen item consumed of one ingredient, how much of that has already been
 * re-labelled as returned-dish wastage, and the priced sources to draw the next re-labelling from.
 * Locks the consumption movement row so two concurrent returns of the same item serialise.
 * Returns null when that item never consumed that ingredient in this store.
 */
export async function loadConsumptionReference(client: Queryable, storeId: string, ingredientId: string, kitchenTicketItemId: string): Promise<ConsumptionReference | null> {
  const consumption = await client.query<{ id: string; delta: string; batch_id: string | null }>(
    `select id, delta::text as delta, batch_id from public.stock_movements
     where store_id = $1 and ingredient_id = $2 and kitchen_ticket_item_id = $3 and reason = 'consumption' for update`,
    [storeId, ingredientId, kitchenTicketItemId],
  )
  const movement = consumption.rows[0]
  if (!movement) return null
  const consumedMicro = -toMicro(movement.delta)
  const reclassified = await client.query<{ quantity: string }>(
    `select coalesce(sum(a.quantity), 0)::text as quantity
     from public.stock_movements w
     join public.stock_movement_allocations a on a.store_id = w.store_id and a.stock_movement_id = w.id
     where w.store_id = $1 and w.ingredient_id = $2 and w.kitchen_ticket_item_id = $3 and w.reason = 'wastage' and w.stock_effect = 'already_consumed'`,
    [storeId, ingredientId, kitchenTicketItemId],
  )
  const reclassifiedMicro = toMicro(reclassified.rows[0].quantity)

  const allocations = await client.query<{ id: string; batch_id: string | null; remaining: string; unit_cost_cents: number; cost_basis: 'batch' | 'estimated_ingredient_cost' }>(
    `select a.id, a.batch_id, a.unit_cost_cents, a.cost_basis,
            (a.quantity - coalesce((select sum(r.quantity) from public.stock_movement_allocations r
                                    where r.store_id = a.store_id and r.source_allocation_id = a.id), 0))::text as remaining
     from public.stock_movement_allocations a
     where a.store_id = $1 and a.stock_movement_id = $2
     order by a.sequence`,
    [storeId, movement.id],
  )
  if (allocations.rows.length) {
    return {
      consumedMicro, reclassifiedMicro,
      sources: allocations.rows.map(row => ({
        sourceId: row.id, batchId: row.batch_id, remainingMicro: toMicro(row.remaining), unitCostCents: row.unit_cost_cents, basis: row.cost_basis,
      })),
    }
  }
  // Pre-Day-2 consumption has no allocation rows. If it recorded a batch, that batch's immutable
  // cost is real evidence; otherwise the whole quantity is priced as an explicit estimate by the caller.
  if (movement.batch_id) {
    const batch = await client.query<{ cost_per_unit_cents: number }>(
      'select cost_per_unit_cents from public.ingredient_batches where store_id = $1 and id = $2', [storeId, movement.batch_id],
    )
    return {
      consumedMicro, reclassifiedMicro,
      sources: [{ sourceId: '', batchId: movement.batch_id, remainingMicro: consumedMicro - reclassifiedMicro, unitCostCents: batch.rows[0].cost_per_unit_cents, basis: 'batch' }],
    }
  }
  return { consumedMicro, reclassifiedMicro, sources: [] }
}
