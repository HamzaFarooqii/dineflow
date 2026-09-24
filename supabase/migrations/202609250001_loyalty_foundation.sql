-- Restaurant POS Transformation — Day 4: loyalty schema (docs/day-plans/day4.md, Hamza's half).
-- Additive only: four new tables, no change to any existing table or constraint. Ahmed's
-- domain math/API and reward-rules CRUD, and the checkout-wiring hook (points earned/redeemed),
-- both build on this once it's live.
--
-- The one real design decision this migration encodes: point redemption becomes a `LineDiscount`
-- (packages/domain/src/money.ts's existing {kind:'percent',bps} | {kind:'fixed',cents} type)
-- applied through the existing manager-approval gate, not a parallel discount mechanism. That's
-- why reward_rules.discount_cents is a plain integer cents amount -- it maps directly onto
-- {kind:'fixed', cents: discount_cents}, the same way Bisma's Day 4 promotions schema is shaped
-- to map directly onto LineDiscount too.

-- 1. Loyalty tiers, per store (e.g. Bronze/Silver/Gold). Tier membership is computed from
-- loyalty_accounts.lifetime_points (a counter that only ever increases), not points_balance
-- (which redemption decrements) -- so spending points never demotes a customer's tier, matching
-- how real loyalty programs separate "spendable balance" from "earning history".
create table public.loyalty_tiers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 40),
  min_lifetime_points integer not null check (min_lifetime_points >= 0),
  -- 10000 = 1x earn rate, 15000 = 1.5x, matching the bps convention already used for
  -- tax_rate_bps/discount bps elsewhere in this schema.
  point_multiplier_bps integer not null default 10000 check (point_multiplier_bps between 10000 and 100000),
  unique (store_id, id),
  unique (store_id, name)
);

-- 2. One loyalty account per customer, per store. Created lazily -- Ahmed's Day 4 task 4 decides
-- the exact enrollment moment (auto on first purchase vs. explicit opt-in).
create table public.loyalty_accounts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  customer_id uuid not null,
  points_balance integer not null default 0 check (points_balance >= 0),
  lifetime_points integer not null default 0 check (lifetime_points >= 0),
  enrolled_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, customer_id),
  foreign key (store_id, customer_id) references public.pos_customers(store_id, id)
);

-- 3. Append-only ledger of every point change -- same shape and reasoning as Day 3's
-- stock_movements: points_balance/lifetime_points are denormalized columns kept in sync in the
-- same transaction as every ledger insert (no trigger), and this table is the audit trail.
-- created_by_user_id/created_by_employee_id record who initiated a *manual* adjustment (a
-- redemption or earn tied to an order is already attributable via order_id -> pos_orders'
-- own employee_id, so these stay nullable rather than duplicating that).
create table public.loyalty_point_ledger (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  account_id uuid not null,
  delta integer not null,
  reason text not null check (reason in ('earned', 'redeemed', 'expired', 'adjustment')),
  order_id uuid,
  created_by_user_id uuid references auth.users(id),
  created_by_employee_id uuid,
  created_at timestamptz not null default now(),
  foreign key (store_id, account_id) references public.loyalty_accounts(store_id, id),
  foreign key (store_id, order_id) references public.pos_orders(store_id, id),
  foreign key (store_id, created_by_employee_id) references public.terminal_employees(store_id, id)
);
create index loyalty_point_ledger_by_account on public.loyalty_point_ledger(store_id, account_id, created_at);

-- 4. A configurable "spend N points, get $X off" catalog. Ahmed builds the CRUD/UI for this
-- table (his Day 4 task 3); this migration only creates it so his branch has something to build
-- against, and so the checkout-wiring hook has real rows to redeem against once he's populated it.
create table public.reward_rules (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 60),
  points_cost integer not null check (points_cost > 0),
  discount_cents integer not null check (discount_cents > 0),
  active boolean not null default true,
  unique (store_id, id)
);

-- 5. RLS: same member-read pattern as every other restaurant table; writes go through the API
-- only (service-role connection), matching the existing convention for these tables.
alter table public.loyalty_tiers enable row level security;
alter table public.loyalty_accounts enable row level security;
alter table public.loyalty_point_ledger enable row level security;
alter table public.reward_rules enable row level security;
grant select on public.loyalty_tiers, public.loyalty_accounts, public.loyalty_point_ledger, public.reward_rules to authenticated;
create policy loyalty_tiers_member_read on public.loyalty_tiers for select to authenticated using (public.is_store_member(store_id));
create policy loyalty_accounts_member_read on public.loyalty_accounts for select to authenticated using (public.is_store_member(store_id));
create policy loyalty_point_ledger_member_read on public.loyalty_point_ledger for select to authenticated using (public.is_store_member(store_id));
create policy reward_rules_member_read on public.reward_rules for select to authenticated using (public.is_store_member(store_id));
