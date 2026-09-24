// Restaurant POS Transformation Blueprint (docs/09) — shared stock-movement-reason contract.
// Values mirror the check constraint on public.stock_movements added by
// supabase/migrations/202609240002_ingredient_inventory.sql exactly; do not add a value here
// without a matching migration, and do not add a migration value without updating this file.
export type StockMovementReason =
  | 'purchase'
  | 'consumption'
  | 'wastage'
  | 'adjustment'

export const STOCK_MOVEMENT_REASONS: readonly StockMovementReason[] = [
  'purchase', 'consumption', 'wastage', 'adjustment',
]

export const STOCK_MOVEMENT_REASON_LABELS: Record<StockMovementReason, string> = {
  purchase: 'Purchase',
  consumption: 'Consumption',
  wastage: 'Wastage',
  adjustment: 'Adjustment',
}

// Maps each reason to one of styles.css's --mise-* semantic token pairs (Section E), matching
// the tone convention already used by table-status.ts, so the inventory screen's chips draw
// from the same palette as the rest of the app.
export type StatusTone = 'success' | 'saffron' | 'info' | 'warning' | 'danger' | 'muted'

export const STOCK_MOVEMENT_REASON_TONE: Record<StockMovementReason, StatusTone> = {
  purchase: 'success',
  consumption: 'info',
  wastage: 'warning',
  adjustment: 'muted',
}
