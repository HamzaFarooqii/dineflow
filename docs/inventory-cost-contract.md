# Inventory cost contract (Day 2)

Read-side contract for the profitability / reporting layer, plus the valuation and wastage rules
behind it. Code: `packages/domain/src/inventory-cost-summary.ts` (pure),
`apps/api/src/lib/inventory-cost-contract.ts` (SQL + endpoint), view `public.stock_movement_cost_lines`
(migration `202610020001_wastage_categories_batch_valuation.sql`).

> **Status of the migration:** written and tested against PGlite only. See the PR / `APPLIED.md`
> for whether it has been applied to the shared database. Until it is, the endpoint and the new
> wastage/consumption code paths cannot run against that database.

## 1. Two different questions: picking order vs. valuation

| | Question | Rule |
|---|---|---|
| **Physical picking order** | Which shelf stock is used first? | Earliest `expires_at` first (no expiry last), then oldest `received_at`, then `id`. This is *earliest-expiry-first*, **not FIFO**. The `id` tie-break is new and makes the order total. |
| **Accounting valuation** | What does a movement cost? | Each unit is costed at the **purchase cost of the batch it was allocated from**, snapshotted when the stock moves. Valuation method name: `batch_pick_order` (policy version 1). It is **not** FIFO, LIFO or weighted-average costing: a unit taken from a later-received batch costs that batch's price even if older stock exists. |

Both consumption (KDS "served") and explicit wastage use the same allocator
(`packages/domain/src/stock-allocation.ts` + `apps/api/src/lib/stock-allocation.ts`).

### Allocation rows

`stock_movements` stays **one row per business event** (so the consumption idempotency key and every
existing reader keep working). The per-batch truth is in append-only `stock_movement_allocations`:
`quantity`, `unit_cost_cents` (snapshot), exact `cost_cents` (fractional cents kept), `cost_basis`.

* `stock_movements.batch_id` is set only when **one batch covered the whole quantity** (identical to
  pre-Day-2 behaviour). A movement spanning batches, or partly uncovered, has `batch_id = null`.
* Quantity no batch can cover becomes an allocation with `cost_basis = 'estimated_ingredient_cost'`,
  **no batch**, priced at `ingredients.cost_per_unit_cents` *at that moment* (snapshotted). It is never
  attributed to a batch that did not supply it.
* Allocations cannot be updated (trigger). `ingredient_batches.cost_per_unit_cents` cannot be changed
  (trigger), so a batch's cost is evidence that cannot drift. Ingredient price edits and
  `ingredient_cost_history` are untouched and never rewrite history.
* Quantities are handled as integer micro-units (6 dp) and costs as exact micro-cents; whole cents are
  rounded **once**, in the read model, half-up.

### Unit conversion

A recipe line's unit is converted to the ingredient's stored unit exactly once with `convertQuantity`
(same-unit, or same-kind units that both carry a `factor_to_base`). Unrelated units are **skipped**, never
guessed 1:1. The converted quantity is rounded to 6 dp; everything afterwards is exact integer arithmetic.
Batches and cost-per-unit are always in the ingredient's stored unit. Wastage is entered in the
ingredient's stored unit. A recipe listing the same ingredient twice consumes their sum once.

### Stock policies (unchanged)

* Served-item consumption may take aggregate stock **negative**; it is never blocked.
* Explicit wastage beyond aggregate stock is **rejected (422)**.
* Batch coverage can be short of aggregate stock (stock received before batch tracking, earlier
  negative-stock consumption). The uncovered part is labelled `estimated_ingredient_cost`.

### Locking

Every writer: **(1)** ingredient row `FOR UPDATE`, **(2)** that ingredient's batches `FOR UPDATE` in picking
order, **(3)** inserts. A transaction touching several ingredients visits them in ascending id. Purchase
receiving inserts new batch rows and updates the ingredient last, so it cannot form a cycle.
*Limit:* PGlite is a single connection, so the "concurrent" tests prove behaviour of the second request
after the first commits (the case the locks exist to make safe) but cannot demonstrate real lock
contention; that needs real Postgres under load (not run here).

## 2. Structured wastage

`stock_movements.reason` stays `'wastage'`. New columns: `wastage_category`, `stock_effect`,
`operation_id`, `payload_hash`, `approval_method`, `approval_required`, `approval_threshold_cents`.
The free-text `note` is preserved exactly as sent. **Historical wastage rows are not rewritten**:
`wastage_category` stays null (the "structured" check is `NOT VALID` — enforced for new rows only) and the
read model reports them as `uncategorised`.

Categories: `spoiled, expired, damaged, prep_waste, overproduction, staff_meal, complimentary,
incorrect_order, returned_order, discrepancy, other`. `other` and `discrepancy` require a note.

### Returned food is never deducted twice

`stock_effect`:
* `deduct` — ordinary wastage; `delta < 0`.
* `already_consumed` — the dish was served, so KDS consumption already deducted its ingredients.
  `returned_order` is always this; `incorrect_order` may be either (the caller must say which). The row is
  recorded with **`delta = 0`**, must reference `kitchen_ticket_item_id`, is capped at what that item
  consumed minus what was already re-labelled, and is **priced from the item's own consumption
  allocations** (so a returned dish is costed exactly as it was consumed). Aggregate stock and batches do
  not move. In the cost contract it is reported separately as `includedInConsumption`.

### Operation identity

`operation_id` (UUID) is required. Same id + same payload → the original result is replayed (HTTP 200,
`replayed: true`). Same id + different payload → **409 `operation_conflict`**. Enforced by a partial unique
index `(store_id, operation_id)` plus the ingredient lock. Consumption idempotency is now also a database
constraint: `unique (store_id, kitchen_ticket_item_id, ingredient_id) where reason='consumption'`.

### Approval threshold (explicit policy decision)

* **Nothing weakens.** A terminal wastage entry still needs a manager at every quantity, exactly as before.
* **The threshold adds a stronger requirement:** if the entry's attributed cost (known + estimated) is
  **at or above** the store's `wastage_approval_threshold_cents`, the terminal must present a
  server-verified, single-use `manager_approval_token` (Day 1, `POST /pos/manager-approvals`) bound to
  `action = 'inventory.wastage.record'` and the exact payload (`wastageApprovalPayload` in
  `packages/domain/src/wastage-category.ts` — key order matters, it is hashed). Legacy client-supplied
  `manager_id` + `manager_approved_at` is accepted only **below** the threshold (the shipped terminal UI
  now always requests a token, so it is the fallback for older clients).
* Boundary: cost == threshold requires the token (compared in exact micro-cents; no rounding up into the gate).
* Default `5000` minor units; per-store row in `public.inventory_policies`; `GET/PUT /inventory/wastage-policy`
  (PUT = owner/manager web session only; terminals may `GET /pos/inventory/wastage-policy`). `0` gates every entry.
* Signed-in owner/manager web sessions are their own authority and are not threshold-gated.
* The token is consumed only after every business validation passes; a retry of an already-recorded
  operation replays without needing the (spent) token.

## 3. The cost contract

```
GET /inventory/cost-summary?store_id=<uuid>&start=<ISO instant>&end=<ISO instant>      (owner/manager)
loadInventoryCostSummary(queryable, storeId, startUtc, endUtc): Promise<InventoryCostSummary>
summarizeInventoryCost({ startUtc, endUtc, effectiveFrom, groups }): InventoryCostSummary      (pure)
```

The caller resolves its own reporting period (e.g. a store-timezone business day) into UTC instants;
the range is `[start, end)`, max 366 days. It deliberately does not import `reports.ts`.

### Row-level source: `public.stock_movement_cost_lines` (security-invoker view)

One row per consumption / wastage / adjustment movement:

| column | meaning |
|---|---|
| `known_cost_cents` | cost attributed to real batches: allocation snapshots, or — pre-Day-2 movements only — the movement's own `batch_id` × that batch's immutable cost |
| `estimated_cost_cents` | quantity no batch covered, priced at the ingredient cost recorded at the time |
| `has_estimate` | the movement contains any estimated quantity |
| `cost_source` | `allocation_snapshot` · `legacy_batch_derived` · `unknown` |
| `unknown_cost` | no cost evidence (pre-Day-2, no batch). **Never priced at today's ingredient cost.** |

### Response shape (`InventoryCostSummary`)

| field | meaning |
|---|---|
| `period` | `{ startUtc, endUtc, endExclusive: true }` |
| `timeBasis` | `stock_movements.created_at` — when the movement was **recorded** (consumption: marked served; wastage: entry saved). Not paid time, not the sale's business day. |
| `refundTreatment` | `consumption: 'not_reversed'`. Refunds do not return ingredient stock, so consumption cost stays gross of refunds. Show revenue net of refunds and cost gross; do not net them. Wastage: not applicable. |
| `valuation` | `{ method: 'batch_pick_order', policyVersion: 1, effectiveFrom, description, legacyHandling }`. `effectiveFrom` = first allocation snapshot this store recorded (null until one exists). Before it, movements have no allocations (see legacy handling). |
| `consumption`, `wastage` | `CostAmounts`: `totalCents` (= `knownCents + estimatedCents`, always), `knownCents`, `estimatedCents`, `movementCount`, `estimatedMovementCount`, `unknownMovementCount` |
| `wastage.byCategory[]` | `{ category, label, amounts }`, null category → label `uncategorised` |
| `wastage.includedInConsumption` | already-consumed (returned-dish) wastage: **already inside consumption**, shown for visibility |
| `wastage.incrementalCostCents` | wastage that removed *additional* stock |
| `completeness` | `status`: `no_data` · `complete` (every movement fully batch-costed) · `estimated` (some quantity priced as an estimate) · `incomplete` (some movements have no cost evidence and are excluded from totals); plus `knownShareBps`, counts and a note |
| `variance` | see §4 |

**Total inventory outflow for a period = `consumption.totalCents + wastage.incrementalCostCents`.**
Adding `wastage.totalCents` would double count returned dishes.

### Worked example

Flour; ingredient price 70¢/kg; batch A 4 kg @ 50¢ (expires first), batch B 10 kg @ 80¢.

1. Serve item 1 (6 kg): 4 kg @ 50 + 2 kg @ 80 → **360¢** known
2. Waste 3 kg `spoiled`: 3 kg @ 80 → **240¢** known
3. Return 2 kg of item 1 (`returned_order`): re-labels 2 kg @ 50 → **100¢**, `delta 0`, already consumed
4. Serve item 2 (10 kg): B has 5 kg left → 5 @ 80 = **400¢** known + 5 kg uncovered @ 70 = **350¢ estimated**
5. Pre-Day-2 consumption of 3 kg recorded against batch A → 3 × 50 = **150¢** known (`legacy_batch_derived`)
6. Pre-Day-2 consumption of 2 kg, no batch → **unknown** (counted, not priced)
7. One manual adjustment → counted, not valued

| | known | estimated | total | movements | est. | unknown |
|---|---|---|---|---|---|---|
| consumption (1, 4, 5, 6) | 910 | 350 | **1260** | 4 | 1 | 1 |
| wastage (2, 3) | 340 | 0 | **340** | 2 | 0 | 0 |
| ↳ `includedInConsumption` (3) | 100 | | 100 | | | |
| ↳ `incrementalCostCents` | | | **240** | | | |

`completeness.status = 'incomplete'`; total inventory outflow = 1260 + 240 = **1500¢**.

### Fixtures

* Pure: `packages/domain/src/inventory-cost-summary.fixtures.ts` —
  `COST_CONTRACT_EXAMPLE_GROUPS` → `summarizeInventoryCost` → compare to `COST_CONTRACT_EXAMPLE_EXPECTED`.
* Real rows: `seedCostContractScenario` in `apps/api/src/routes/inventory-test-support.ts`; asserted against
  the same expectations in `apps/api/src/routes/inventory-cost-contract.test.ts`.

The lead can connect reporting by calling `loadInventoryCostSummary` (or the endpoint) with the period the
reporting screen already resolves, and swapping the real response in for the fixture without changing assertions.

## 4. Variance: what is and is not available

**Actual-versus-theoretical variance is unavailable** (`variance.actualVariance.available = false`,
`reason: 'no_independent_stock_counts'`). Consumption is generated from recipes, so comparing it with the
same recipe calculation measures nothing. There is no stocktake / count table in the schema (full stocktake
management is out of scope). The contract therefore reports only what is real:

* `theoreticalUsageCostCents` — recipe-driven consumption cost (labelled theoretical, not measured)
* `recordedWastageCostCents` — wastage that removed additional stock
* `knownAdjustments.movementCount` — manual adjustments, **counted but not valued** (no batch evidence)

Do not display a variance number until independent opening/closing counts exist.

## 5. Known limitations

* **Historical rows are not backfilled.** Pre-migration movements have no allocations; those with a
  `batch_id` are valued from that batch, the rest are `unknown`. The existing `reports.ts` wastage value
  prices batch-less historical wastage at the ingredient's *current* cost — it will not match this contract
  for those rows (this contract refuses to).
* Aggregate stock can already disagree with the sum of batch remainders (history); the contract labels the
  gap `estimated`, it does not repair it.
* Manual receiving (`POST …/batches`, not purchase-order receiving) has no operation id / replay protection;
  PO receiving does (`purchase_receipts (store_id, operation_id)`) and is unchanged.
* Real multi-connection lock contention is not covered by the PGlite suite.
