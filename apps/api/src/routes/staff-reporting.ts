export interface TipEvent {
  orderId: string
  employeeId: string | null
  employeeName: string | null
  employeeRole: string | null
  soldAt: string
  grossTipCents: number
  refundedTipCents: number
  netTipCents: number
}

export interface EmployeeTipSummary {
  employeeId: string | null
  employeeName: string
  employeeRole: string | null
  orderCount: number
  grossTipCents: number
  refundedTipCents: number
  netTipCents: number
}

export interface TipAllocationShift {
  id: string
  employee_id: string
  clocked_in_at: string
  clocked_out_at: string
}

export interface TipTotals {
  grossTipCents: number
  refundedTipCents: number
  netTipCents: number
}

function addTip(totals: TipTotals, event: TipEvent): void {
  totals.grossTipCents += event.grossTipCents
  totals.refundedTipCents += event.refundedTipCents
  totals.netTipCents += event.netTipCents
}

export function summarizeTipEvents(events: TipEvent[]): EmployeeTipSummary[] {
  const rows = new Map<string, EmployeeTipSummary>()
  for (const event of events) {
    const key = event.employeeId ?? 'unattributed'
    const row = rows.get(key) ?? {
      employeeId: event.employeeId,
      employeeName: event.employeeName ?? 'Unattributed sales',
      employeeRole: event.employeeRole,
      orderCount: 0,
      grossTipCents: 0,
      refundedTipCents: 0,
      netTipCents: 0,
    }
    row.orderCount += 1
    addTip(row, event)
    rows.set(key, row)
  }
  return Array.from(rows.values()).sort((a, b) => b.netTipCents - a.netTipCents || a.employeeName.localeCompare(b.employeeName))
}

// A sale belongs to at most one closed shift: the same employee's latest shift whose
// [clock-in, clock-out) interval contains the sale. This prevents a period total from being
// repeated on every shift. Orders without a matching closed shift remain explicitly unallocated.
export function allocateTipEventsToShifts(events: TipEvent[], shifts: TipAllocationShift[]): {
  byShift: Map<string, TipTotals>
  unallocated: TipEvent[]
} {
  const byShift = new Map<string, TipTotals>()
  const unallocated: TipEvent[] = []
  for (const event of events) {
    const soldAt = Date.parse(event.soldAt)
    const shift = event.employeeId
      ? shifts
        .filter(candidate => candidate.employee_id === event.employeeId
          && Date.parse(candidate.clocked_in_at) <= soldAt
          && soldAt < Date.parse(candidate.clocked_out_at))
        .sort((a, b) => Date.parse(b.clocked_in_at) - Date.parse(a.clocked_in_at))[0]
      : undefined
    if (!shift) { unallocated.push(event); continue }
    const totals = byShift.get(shift.id) ?? { grossTipCents: 0, refundedTipCents: 0, netTipCents: 0 }
    addTip(totals, event)
    byShift.set(shift.id, totals)
  }
  return { byShift, unallocated }
}

export function sumTipTotals(events: TipEvent[]): TipTotals {
  const totals = { grossTipCents: 0, refundedTipCents: 0, netTipCents: 0 }
  for (const event of events) addTip(totals, event)
  return totals
}
