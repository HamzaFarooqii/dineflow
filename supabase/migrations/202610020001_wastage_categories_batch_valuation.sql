-- Day 2 (Bisma): structured wastage + batch-allocation cost snapshots + the read-side cost view.
-- Additive only: new nullable/defaulted columns, two new tables, one view, new constraints that
-- every existing row already satisfies. No existing row is rewritten and nothing is backfilled --
-- movements recorded before this migration keep their note, their batch_id and a NULL category,
-- and the cost view labels them honestly (see stock_movement_cost_lines below).
--
-- Valuation decisions encoded here (full write-up: docs/inventory-cost-contract.md):
--  * Physical picking order (earliest expiry first, then oldest received, then id) is separate
--    from accounting valuation (each unit costed at the batch it was allocated from, snapshotted).
--  * A movement may now span several batches. stock_movements stays one row per business event
--    (so the consumption idempotency key and every pre-existing reader keep working); the
--    per-batch truth lives in stock_movement_allocations, which is append-only.
--  * Quantity no batch can cover is stored as an allocation with cost_basis
--    'estimated_ingredient_cost' and NO batch -- never attributed to a batch that didn't supply it.

-- 1. Tenant-composite targets for the new foreign keys. The existing unique (store_id, id) stays;
--    these wider keys let an allocation prove its batch/movement belongs to the SAME ingredient.
alter table public.ingredient_batches add constraint ingredient_batches_store_id_id_ingredient_key unique (store_id, id, ingredient_id);
alter table public.stock_movements add constraint stock_movements_store_id_id_ingredient_key unique (store_id, id, ingredient_id);

-- 2. Structured wastage + operation identity + approval evidence on the ledger row.
alter table public.stock_movements
  add column wastage_category text,
  add column stock_effect text,
  add column operation_id uuid,
  add column payload_hash text,
  add column approval_method text,
  add column approval_required boolean,
  add column approval_threshold_cents integer;

alter table public.stock_movements
  add constraint stock_movements_wastage_category_check check (wastage_category is null or wastage_category in (
    'spoiled', 'expired', 'damaged', 'prep_waste', 'overproduction', 'staff_meal',
    'complimentary', 'incorrect_order', 'returned_order', 'discrepancy', 'other')),
  add constraint stock_movements_wastage_category_reason_check check (wastage_category is null or reason = 'wastage'),
  add constraint stock_movements_stock_effect_check check (stock_effect is null or (reason = 'wastage' and stock_effect in ('deduct', 'already_consumed'))),
  -- A returned dish re-labels stock KDS consumption already deducted: delta 0, never a second deduction.
  add constraint stock_movements_stock_effect_delta_check check (
    (stock_effect is distinct from 'already_consumed' or delta = 0) and (stock_effect is distinct from 'deduct' or delta < 0)),
  add constraint stock_movements_operation_pair_check check ((operation_id is null) = (payload_hash is null)),
  add constraint stock_movements_approval_method_check check (approval_method is null or approval_method in (
    'web_manager_session', 'terminal_verified_token', 'terminal_legacy_evidence')),
  add constraint stock_movements_approval_threshold_check check (approval_threshold_cents is null or approval_threshold_cents >= 0),
  -- NOT VALID: enforced for every row written from now on, deliberately not checked against
  -- historical wastage rows (they predate categories and must stay exactly as recorded).
  add constraint stock_movements_new_wastage_structured_check check (
    reason <> 'wastage' or (wastage_category is not null and stock_effect is not null)) not valid;

-- Stable operation identity: one wastage operation id can only ever produce one ledger row.
create unique index stock_movements_operation_id_key on public.stock_movements (store_id, operation_id) where operation_id is not null;

-- Consumption idempotency enforced by the database, not just by a read-then-write check: a
-- kitchen item can consume a given ingredient at most once even under concurrent serves.
create unique index stock_movements_one_consumption_per_item_ingredient
  on public.stock_movements (store_id, kitchen_ticket_item_id, ingredient_id)
  where reason = 'consumption' and kitchen_ticket_item_id is not null;

-- Already-consumed wastage (returned dishes) references the ticket item whose consumption it
-- re-labels; look-ups for "how much of this item is already reclassified" use this.
create index stock_movements_wastage_by_ticket_item
  on public.stock_movements (store_id, kitchen_ticket_item_id, ingredient_id)
  where reason = 'wastage' and kitchen_ticket_item_id is not null;

-- 3. Allocation snapshots. One row per (movement, source); append-only.
--    quantity     -- ingredient's stored unit, 6 decimal places in practice.
--    unit_cost_cents -- the batch's (or, for estimates, the ingredient's) per-unit cost AT THAT
--                   MOMENT. Later cost edits never touch it.
--    cost_cents   -- exact quantity x unit_cost_cents (fractional cents are kept; rounding to whole
--                   cents happens once, in the read model).
--    source_allocation_id -- for already-consumed wastage: the consumption allocation this share
--                   re-prices, so a returned dish is costed exactly as it was consumed.
create table public.stock_movement_allocations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  stock_movement_id uuid not null,
  ingredient_id uuid not null,
  batch_id uuid,
  sequence smallint not null check (sequence >= 1),
  quantity numeric not null check (quantity > 0),
  unit_cost_cents integer not null check (unit_cost_cents >= 0),
  cost_cents numeric not null check (cost_cents >= 0),
  cost_basis text not null check (cost_basis in ('batch', 'estimated_ingredient_cost')),
  source_allocation_id uuid,
  created_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, stock_movement_id, sequence),
  -- a batch-based allocation must name its batch; an estimate must not
  check ((cost_basis = 'batch') = (batch_id is not null)),
  foreign key (store_id, stock_movement_id, ingredient_id) references public.stock_movements(store_id, id, ingredient_id),
  foreign key (store_id, batch_id, ingredient_id) references public.ingredient_batches(store_id, id, ingredient_id),
  foreign key (store_id, ingredient_id) references public.ingredients(store_id, id),
  foreign key (store_id, source_allocation_id) references public.stock_movement_allocations(store_id, id)
);
create index stock_movement_allocations_by_batch on public.stock_movement_allocations (store_id, batch_id) where batch_id is not null;
create index stock_movement_allocations_by_source on public.stock_movement_allocations (store_id, source_allocation_id) where source_allocation_id is not null;

create function public.stock_movement_allocations_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'stock_movement_allocations rows are append-only cost snapshots and cannot be updated';
end $$;
create trigger stock_movement_allocations_no_update before update on public.stock_movement_allocations
  for each row execute function public.stock_movement_allocations_immutable();

-- A batch's purchase cost is the evidence behind every valuation (allocation snapshots copy it, and
-- pre-Day-2 movements are valued from it directly), so it must be immutable. No code path edits it
-- today -- ingredient price changes go through ingredients.cost_per_unit_cents and
-- ingredient_cost_history -- this makes that a database guarantee rather than a convention.
create function public.ingredient_batches_cost_immutable() returns trigger language plpgsql as $$
begin
  if new.cost_per_unit_cents is distinct from old.cost_per_unit_cents then
    raise exception 'ingredient_batches.cost_per_unit_cents is the purchase cost of a received batch and cannot be changed';
  end if;
  return new;
end $$;
create trigger ingredient_batches_cost_no_change before update on public.ingredient_batches
  for each row execute function public.ingredient_batches_cost_immutable();

-- 4. Per-store policy: the wastage approval threshold (attributed cost, in cents, at or above
--    which a terminal entry needs a server-verified approval token).
create table public.inventory_policies (
  store_id uuid primary key references public.stores(id),
  wastage_approval_threshold_cents integer not null default 5000 check (wastage_approval_threshold_cents >= 0),
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid
);

alter table public.stock_movement_allocations enable row level security;
alter table public.inventory_policies enable row level security;
grant select on public.stock_movement_allocations, public.inventory_policies to authenticated;
create policy stock_movement_allocations_member_read on public.stock_movement_allocations for select to authenticated using (public.is_store_member(store_id));
create policy inventory_policies_member_read on public.inventory_policies for select to authenticated using (public.is_store_member(store_id));

-- 5. The read-side cost contract: ONE row per consumption / wastage / adjustment movement with
--    its cost split into what is known, what is an estimate, and whether it has no evidence.
--    security_invoker => it honours the caller's RLS exactly like the tables it reads.
--
--    known_cost_cents     cost attributed to real batches: allocation snapshots, or (pre-Day-2
--                         movements only) the movement's own batch_id x that batch's immutable cost.
--    estimated_cost_cents quantity no batch covered, priced at the ingredient cost recorded then.
--    cost_source          'allocation_snapshot' | 'legacy_batch_derived' | 'unknown'
--    A pre-Day-2 movement with no batch is 'unknown': it is NOT priced at today's ingredient cost.
create view public.stock_movement_cost_lines with (security_invoker = true) as
select
  m.store_id, m.id as movement_id, m.ingredient_id, m.reason, m.wastage_category, m.stock_effect, m.created_at,
  coalesce(a.quantity, abs(m.delta)) as quantity,
  case
    when a.n > 0 then a.known_cost
    when m.batch_id is not null then abs(m.delta) * b.cost_per_unit_cents
    else 0
  end as known_cost_cents,
  coalesce(a.estimated_cost, 0) as estimated_cost_cents,
  coalesce(a.estimated_n, 0) > 0 as has_estimate,
  case when a.n > 0 then 'allocation_snapshot' when m.batch_id is not null then 'legacy_batch_derived' else 'unknown' end as cost_source,
  (coalesce(a.n, 0) = 0 and m.batch_id is null) as unknown_cost
from public.stock_movements m
left join lateral (
  select count(*) as n,
         sum(x.quantity) as quantity,
         coalesce(sum(x.cost_cents) filter (where x.cost_basis = 'batch'), 0) as known_cost,
         coalesce(sum(x.cost_cents) filter (where x.cost_basis = 'estimated_ingredient_cost'), 0) as estimated_cost,
         count(*) filter (where x.cost_basis = 'estimated_ingredient_cost') as estimated_n
  from public.stock_movement_allocations x
  where x.store_id = m.store_id and x.stock_movement_id = m.id
) a on a.n > 0
left join public.ingredient_batches b on b.store_id = m.store_id and b.id = m.batch_id
where m.reason in ('consumption', 'wastage', 'adjustment');
grant select on public.stock_movement_cost_lines to authenticated;
