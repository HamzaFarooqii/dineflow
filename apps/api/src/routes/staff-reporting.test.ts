import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'

const { isPotentiallyMissedClockOut, POTENTIAL_MISSED_CLOCK_OUT_MINUTES } = await import('./shifts.js')
const { minutesBetween } = await import('./timekeeping.js')
const { allocateTipEventsToShifts, summarizeTipEvents, sumTipTotals } = await import('./staff-reporting.js')
type TipEvent = import('./staff-reporting.js').TipEvent

test('missed clock-out warning uses the documented inclusive 16-hour server-time boundary', () => {
  const serverNow = '2026-09-30T16:00:00.000Z'
  assert.equal(POTENTIAL_MISSED_CLOCK_OUT_MINUTES, 960)
  assert.equal(isPotentiallyMissedClockOut('2026-09-30T00:01:00.000Z', serverNow), false)
  assert.equal(isPotentiallyMissedClockOut('2026-09-30T00:00:00.000Z', serverNow), true)
  assert.equal(isPotentiallyMissedClockOut('2026-10-01T00:00:00.000Z', serverNow), false)
})

test('overnight and DST-spanning shifts use actual elapsed instants', () => {
  assert.equal(minutesBetween('2026-09-30T20:00:00.000Z', '2026-10-01T04:00:00.000Z'), 480)
  // America/New_York spring-forward: 01:00 EST to 09:00 EDT is seven elapsed hours.
  assert.equal(minutesBetween('2026-03-08T06:00:00.000Z', '2026-03-08T13:00:00.000Z'), 420)
})

const events: TipEvent[] = [
  {
    orderId: 'order-one', employeeId: 'employee-a', employeeName: 'Ayesha', employeeRole: 'cashier',
    soldAt: '2026-09-30T10:00:00.000Z', grossTipCents: 500, refundedTipCents: 125, netTipCents: 375,
  },
  {
    orderId: 'order-two', employeeId: 'employee-a', employeeName: 'Ayesha', employeeRole: 'cashier',
    soldAt: '2026-09-30T12:00:00.000Z', grossTipCents: 300, refundedTipCents: 0, netTipCents: 300,
  },
  {
    orderId: 'order-three', employeeId: null, employeeName: null, employeeRole: null,
    soldAt: '2026-09-30T13:00:00.000Z', grossTipCents: 200, refundedTipCents: 0, netTipCents: 200,
  },
  {
    orderId: 'order-four', employeeId: 'employee-a', employeeName: 'Ayesha', employeeRole: 'cashier',
    soldAt: '2026-09-30T19:00:00.000Z', grossTipCents: 100, refundedTipCents: 25, netTipCents: 75,
  },
]

test('employee summaries subtract aggregated tip refunds once and keep an unattributed bucket', () => {
  const rows = summarizeTipEvents(events)
  const ayesha = rows.find(row => row.employeeId === 'employee-a')
  const unattributed = rows.find(row => row.employeeId === null)

  assert.deepEqual(ayesha, {
    employeeId: 'employee-a', employeeName: 'Ayesha', employeeRole: 'cashier', orderCount: 3,
    grossTipCents: 900, refundedTipCents: 150, netTipCents: 750,
  })
  assert.deepEqual(unattributed, {
    employeeId: null, employeeName: 'Unattributed sales', employeeRole: null, orderCount: 1,
    grossTipCents: 200, refundedTipCents: 0, netTipCents: 200,
  })
})

test('tips allocate to one matching shift across multiple shifts and CSV totals retain parity', () => {
  const shifts = [
    { id: 'shift-one', employee_id: 'employee-a', clocked_in_at: '2026-09-30T08:00:00.000Z', clocked_out_at: '2026-09-30T12:00:00.000Z' },
    { id: 'shift-two', employee_id: 'employee-a', clocked_in_at: '2026-09-30T12:00:00.000Z', clocked_out_at: '2026-09-30T16:00:00.000Z' },
  ]
  const allocation = allocateTipEventsToShifts(events, shifts)

  assert.deepEqual(allocation.byShift.get('shift-one'), {
    grossTipCents: 500, refundedTipCents: 125, netTipCents: 375,
  })
  // The half-open boundary assigns the 12:00 sale to shift two, never both shifts.
  assert.deepEqual(allocation.byShift.get('shift-two'), {
    grossTipCents: 300, refundedTipCents: 0, netTipCents: 300,
  })
  assert.deepEqual(allocation.unallocated.map(event => event.orderId), ['order-three', 'order-four'])

  const screenTotals = sumTipTotals(events)
  const exportedTotals = { grossTipCents: 0, refundedTipCents: 0, netTipCents: 0 }
  for (const totals of allocation.byShift.values()) {
    exportedTotals.grossTipCents += totals.grossTipCents
    exportedTotals.refundedTipCents += totals.refundedTipCents
    exportedTotals.netTipCents += totals.netTipCents
  }
  for (const event of allocation.unallocated) {
    exportedTotals.grossTipCents += event.grossTipCents
    exportedTotals.refundedTipCents += event.refundedTipCents
    exportedTotals.netTipCents += event.netTipCents
  }
  assert.deepEqual(exportedTotals, screenTotals)
})
