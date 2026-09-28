// Open checks (docs/day-plans -- Ahmad's open-check/hold-resume work): a durable, pre-payment
// running tab for a sale that hasn't been paid yet. Values mirror the check constraint on
// public.open_checks.status, added by supabase/migrations/202609280002_open_checks.sql, exactly;
// do not add a value here without a matching migration, and do not add a migration value without
// updating this file. Deliberately has no cross-file import: an open check's running total is
// exactly money.ts's existing calculateDiscountedLine/sumDiscountedLines/calculateServiceCharge,
// with no new formula of its own, so that math is only ever computed where it's actually needed
// (apps/api/src/routes/open-checks.ts) rather than duplicated here.
export type OpenCheckStatus = 'open' | 'closed' | 'voided'

export const OPEN_CHECK_STATUSES: readonly OpenCheckStatus[] = ['open', 'closed', 'voided']

// Forward-only, same shape as KITCHEN_TICKET_ITEM_TRANSITIONS: a check can only leave 'open' by
// closing (paid) or voiding (abandoned); both 'closed' and 'voided' are terminal. The API checks
// every mutation (edit/void/close) against this instead of trusting whatever the client sends.
export const OPEN_CHECK_TRANSITIONS: Record<OpenCheckStatus, readonly OpenCheckStatus[]> = {
  open: ['closed', 'voided'],
  closed: [],
  voided: [],
}

export function canTransitionOpenCheck(from: OpenCheckStatus, to: OpenCheckStatus): boolean {
  return OPEN_CHECK_TRANSITIONS[from].includes(to)
}

// Only an 'open' check accepts new/changed/removed lines -- once closed or voided it's an
// immutable historical record, same principle as pos_orders never becoming a mutable cart.
export function isOpenCheckEditable(status: OpenCheckStatus): boolean {
  return status === 'open'
}
