// Fixtures for the inventory cost contract (docs/inventory-cost-contract.md, "Worked example").
// Plain data, no database: the profitability/reporting developer can feed COST_CONTRACT_EXAMPLE_GROUPS
// to summarizeInventoryCost and assert against COST_CONTRACT_EXAMPLE_EXPECTED, then swap in the
// real GET /inventory/cost-summary response without changing the assertions.
//
// The same scenario is produced from real rows by seedCostContractScenario in
// apps/api/src/routes/inventory-test-support.ts (asserted in inventory-cost-contract.test.ts).
//
// Scenario (one ingredient, flour; ingredient price 70c/kg; batches A = 4 kg @ 50c, B = 10 kg @ 80c):
//   1. serve item 1: consumes 6 kg      -> 4 kg @ 50c + 2 kg @ 80c           = 360c known
//   2. waste 3 kg as 'spoiled'          -> 3 kg @ 80c                         = 240c known
//   3. return 2 kg of item 1            -> re-labels 2 kg @ 50c (no stock)    = 100c known, already consumed
//   4. serve item 2: consumes 10 kg     -> batch B has 5 kg left: 5 @ 80c = 400c known + 5 kg uncovered @ 70c = 350c estimated
//   5. a pre-Day-2 consumption of 3 kg that recorded batch A                  = 150c known (legacy_batch_derived)
//   6. a pre-Day-2 consumption of 2 kg with no batch                          = unknown (not priced)
//   7. one manual adjustment                                                  = counted, not valued
import type { CostLineGroup, InventoryCostSummary } from './inventory-cost-summary.js'

export const COST_CONTRACT_EXAMPLE_PERIOD = {
  startUtc: '2026-10-02T00:00:00.000Z',
  endUtc: '2026-10-03T00:00:00.000Z',
  effectiveFrom: '2026-10-02T08:00:00.000Z',
}

export const COST_CONTRACT_EXAMPLE_GROUPS: CostLineGroup[] = [
  { reason: 'consumption', wastageCategory: null, stockEffect: null, movementCount: 4,
    knownCostCents: '910', estimatedCostCents: '350', estimatedMovementCount: 1, unknownMovementCount: 1 },
  { reason: 'wastage', wastageCategory: 'spoiled', stockEffect: 'deduct', movementCount: 1,
    knownCostCents: '240', estimatedCostCents: '0', estimatedMovementCount: 0, unknownMovementCount: 0 },
  { reason: 'wastage', wastageCategory: 'returned_order', stockEffect: 'already_consumed', movementCount: 1,
    knownCostCents: '100', estimatedCostCents: '0', estimatedMovementCount: 0, unknownMovementCount: 0 },
  { reason: 'adjustment', wastageCategory: null, stockEffect: null, movementCount: 1,
    knownCostCents: '0', estimatedCostCents: '0', estimatedMovementCount: 0, unknownMovementCount: 1 },
]

/** The headline numbers the example must produce (a subset of InventoryCostSummary, for assertions). */
export const COST_CONTRACT_EXAMPLE_EXPECTED = {
  consumption: { knownCents: 910, estimatedCents: 350, totalCents: 1260, movementCount: 4, estimatedMovementCount: 1, unknownMovementCount: 1 },
  wastage: { knownCents: 340, estimatedCents: 0, totalCents: 340, movementCount: 2, includedInConsumptionCents: 100, incrementalCostCents: 240 },
  completenessStatus: 'incomplete' as InventoryCostSummary['completeness']['status'],
  /** consumption.totalCents + wastage.incrementalCostCents: what to add up for total food cost without double counting the return. */
  totalInventoryOutflowCents: 1500,
  variance: { theoreticalUsageCostCents: 1260, recordedWastageCostCents: 240, adjustmentMovementCount: 1 },
}
