// Restaurant POS Transformation Blueprint (docs/09) — shared table-status contract. Values
// mirror the check constraint on public.restaurant_tables added by
// supabase/migrations/202609210001_restaurant_foundation.sql exactly; do not add a value here
// without a matching migration, and do not add a migration value without updating this file.
//
// This is coarse floor-coordination state only ("is this table free"), not the fine-grained
// preparing/ready/served state of an individual kitchen ticket — that belongs to the Day 2
// Kitchen Display System and hangs off the order, not the table.
export type TableStatus =
  | 'available'
  | 'seated'
  | 'ordering'
  | 'served'
  | 'bill_requested'
  | 'dirty'
  | 'reserved'
  | 'out_of_service'

export const TABLE_STATUSES: readonly TableStatus[] = [
  'available', 'seated', 'ordering', 'served', 'bill_requested', 'dirty', 'reserved', 'out_of_service',
]

export const TABLE_STATUS_LABELS: Record<TableStatus, string> = {
  available: 'Available',
  seated: 'Seated',
  ordering: 'Ordering',
  served: 'Food Served',
  bill_requested: 'Bill Requested',
  dirty: 'Needs Cleaning',
  reserved: 'Reserved',
  out_of_service: 'Out of Service',
}

// Maps each status to one of styles.css's --mise-* semantic token pairs (Section E) — the same
// fill/ink pairing the existing .order-state chip already uses — so Floor table cards and POS
// status chips always draw from one palette instead of each screen picking its own colors.
export type StatusTone = 'success' | 'saffron' | 'info' | 'warning' | 'danger' | 'muted'

export const TABLE_STATUS_TONE: Record<TableStatus, StatusTone> = {
  available: 'success',
  seated: 'info',
  ordering: 'saffron',
  served: 'saffron',
  bill_requested: 'warning',
  dirty: 'muted',
  reserved: 'info',
  out_of_service: 'danger',
}
