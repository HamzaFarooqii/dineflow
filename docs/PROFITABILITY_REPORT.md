# Profitability report (Day 2, Part 1)

`GET /reports/profitability?store_id=&from=&to=` (`loadProfitabilityReport`,
`apps/api/src/routes/reports.ts`) and the Reports screen's new "Profitability" tab
(`apps/web/src/screens/ReportingScreens.tsx`).

## What it shows

Gross merchandise sales → discounts → merchandise refunds → net merchandise revenue → estimated
cost of goods → gross profit → wastage-adjusted profit, with date selection, KPI cards, a daily
trend table, and tax/tips/service charge shown as separate reference figures. See
`docs/qa/profitability/` for screenshots at 390/768/1440px.

## Formula decisions (exact, not approximate)

- **Gross merchandise sales** = `sum(pos_orders.subtotal_cents)` for orders in range.
- **Discounts** = `sum(pos_orders.discount_cents)` for orders in range.
- **Merchandise refunds** = `sum(pos_refunds.merchandise_cents)` for refunds in range (see refund-event
  policy below) — never derived by excluding whole orders.
- **Net merchandise revenue** = gross − discounts − merchandise refunds. This is the same formula
  `loadDailySummary`'s existing `netSalesCents` already uses — reused, not recomputed a second way,
  so the two reports can never silently disagree.
- **Estimated cost of goods** = Σ (recipe portion cost × quantity sold) per product, using the exact
  `costRecipe`/`foodCostBps` primitives `loadFoodCostReport` already uses. **Never reduced for a
  refund**: refunding a sale does not un-consume the ingredients already used to prepare it
  (`kitchen.ts`'s `consumeRecipeIngredients` runs once, at serve time, and nothing reverses it).
- **Cost coverage** = revenue-weighted share of item revenue backed by a complete cost (recipe or,
  once wired, actual batch cost). Recomputed from range totals for the summary figure, not averaged
  from daily percentages (which would weight a quiet day the same as the busiest one).
- **Wastage value** = same valuation formula `loadInventoryReport`'s existing wastage query uses
  (batch cost when known, else the ingredient's current cost), bucketed by day instead of totaled.
- **Gross profit** = net merchandise revenue − estimated cost of goods.
- **Wastage-adjusted profit** = gross profit − wastage value.
- **Gross margin** = gross profit ÷ net merchandise revenue, in bps; `null` when revenue is ≤ 0 (not
  a divide-by-zero, and not clamped to 0%).
- **Tax / tips / service charge** are computed and returned (net of refund-event reductions in the
  same categories) but are **reference only** — never added into or subtracted from gross profit,
  since their treatment relative to profit has no agreed product decision yet.

## Refund-event policy (explicit)

Revenue, discounts, and units sold are recognized on the calendar day of the **original sale**
(`pos_orders.client_generated_at`, store-timezone bucketed). A refund is recognized — and reduces
net merchandise revenue — on the calendar day of the **refund itself**
(`pos_refunds.created_at`), never restated back onto the sale's day. A refund issued in a later
period than its sale reduces that later period, matching standard POS/accounting practice of never
rewriting an already-closed period. This is also why a day's net revenue (and gross profit) can be
negative — e.g. a quiet day whose only activity is refunding an earlier sale — and that is reported
honestly rather than clamped to zero or hidden.

## The Food Cost report's pre-existing bug, and why this report doesn't copy it

`loadFoodCostReport`'s item-revenue query excludes an order's **entire** item set the moment *any*
refund — even a one-cent partial one — exists on it (`not exists (select ... from pos_refunds ...)`).
That silently undercounts both revenue and cost for the untouched portion of a partially-refunded
order. This report instead: (1) never excludes rows by refund existence, (2) reduces revenue by the
*exact* refunded `merchandise_cents` amount, bucketed by refund date, and (3) leaves cost of goods
entirely unaffected by refund status, since the ingredients were consumed regardless. Fixing
`loadFoodCostReport` itself was out of scope for this task (not inspected/assigned) and is flagged
as a follow-up, not silently patched.

## Cost-adapter integration instructions (for the teammate adding batch-cost facts)

`loadProfitabilityReport(storeId, from, to, actualCostAdapter?)` takes an optional
`ActualCostAdapter`:

```ts
export type ActualCostAdapter = (storeId: string, from: string, to: string) => Promise<Map<string, number> | null>
```

Return a `Map<productId, actualCostPerUnitCents>` for whichever products you have real batch-cost
facts for; return `null` (the default, `noActualCostAdapter`) to mean "not available." Products
present in your map take priority over the recipe estimate and are marked `complete` for coverage
purposes; products absent from it fall back to the recipe estimate. When your adapter returns
non-null, the response's `costBasis` becomes `'actual_batch'` and `actualCostAvailable` becomes
`true` — wire your adapter in by passing it as the 4th argument from whatever route or job calls
`loadProfitabilityReport`; nothing else in this report needs to change.

## Known dependencies and limitations

- **Depends on**: `packages/domain/src/recipe-cost.ts` (unchanged), `packages/domain/src/money.ts`
  (`formatCents` now accepts negative amounts — see below), the existing `reportRange`/
  `calendarDayBoundsUtc` range-validation helpers (366-day cap, from ≤ to).
- **Does not yet integrate**: real batch-cost facts (another developer's independent work, per the
  assignment) — see the adapter above.
- **Does not fix**: `loadFoodCostReport`'s own refund-exclusion bug (flagged above, not in scope).
- **Comparison periods and extra breakdowns** (e.g. per-dish profitability inside this report, a
  "vs. previous period" delta) were explicitly deferred — the assignment calls for correct base
  reconciliation first; this report's dish-level breakdown already exists separately as the Food
  Cost report (`Reports > Food cost`), so this one deliberately stays a reconciliation summary, not
  a duplicate of that table.
- **`formatCents` (`packages/domain/src/money.ts`) was changed** to accept negative cents instead of
  throwing (`boundedInteger(cents, 'Amount', -MAX_CENTS, MAX_CENTS)` in place of a `0` floor). This
  was a latent bug independent of this task — `FoodCostReportView`'s existing
  `dish.grossProfitCents < 0 ? 'report-negative' : ''` styling already anticipated a negative
  value that would have crashed the formatter the moment any dish's cost exceeded its revenue.
  Fixed here because this report legitimately produces negative amounts (a refund-heavy period);
  every other money helper in the file keeps its original `0` floor unchanged.
