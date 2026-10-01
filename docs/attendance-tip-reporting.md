# Attendance and Sale-Attributed Tips

This document defines the staff-reporting behavior implemented on `feature/hamza/day2-attendance-controls`.

## Potential missed clock-outs

- An open shift is flagged when server time reaches **16 hours (960 minutes)** after clock-in.
- The boundary is inclusive: 959 minutes is not flagged; 960 minutes is flagged.
- Server time is authoritative. Terminal/browser time is not used.
- The flag is advisory only. DineFlow never auto-closes or rewrites a shift.
- A manager must confirm the correct time and use the existing audited correction action. Every correction still requires a reason and writes an immutable audit record.
- No lateness or early-departure flag is inferred because DineFlow has no roster/schedule model.

## Tip definition

The Hours report shows **sale-attributed tips**, not payroll payout or tip-pool entitlement.

1. Payment tenders are aggregated to one gross-tip total per order.
2. Refund tenders are independently aggregated to one refunded-tip total per order.
3. Net attributed tip = gross order tips - refunded order tips.
4. The result is attributed to `pos_orders.employee_id`, the employee recorded on the sale.
5. Orders without an employee remain visible in an **Unattributed sales** bucket.
6. The selected range follows the sale timestamp. A later tip refund remains attached to that original sale, so a historical period can change after a refund.

Aggregating each side before attribution prevents split tenders or multiple refund rows from multiplying a tip.

## CSV allocation

The screen groups tips by employee for the selected sale period. The CSV additionally allocates every tipped order once:

- A tipped sale is assigned to the same employee's closed shift whose half-open interval `[clock-in, clock-out)` contains the sale.
- If corrected shifts overlap, the shift with the latest clock-in wins deterministically.
- A sale with no matching closed shift is emitted as an `unallocated_tip` row.
- A sale with no employee is also emitted as an `unallocated_tip` row.
- Shift tip totals plus unallocated-tip rows exactly equal the screen's sale-period totals.
- Employee period totals are never repeated on every shift.

Worked time remains clock-in to clock-out minus unpaid breaks exactly once. Paid breaks remain in paid time. Open shifts and open breaks are visible but excluded from final duration totals and CSV worked-time totals.

## Reviewer workflow

1. Open **Reports -> Hours worked** as an owner or manager.
2. Confirm closed hours still subtract unpaid breaks and retain paid breaks.
3. Create or inspect a tipped sale with an attributed terminal employee; confirm its net tip appears on that employee row.
4. Refund part of the tip; confirm the employee's net amount decreases once and the refunded amount is disclosed.
5. Inspect a sale without `employee_id`; confirm **Unattributed sales** appears.
6. Inspect an open shift at least 16 hours old; confirm **Possible missed clock-out** and **Needs review** appear, but the shift remains open.
7. Use **Correct...**, provide a reason, and confirm the audited correction flow is unchanged.
8. Export **time & tips CSV**; sum `net_sale_attributed_tip_cents` across shift and unallocated rows and compare it with the screen total.
