-- Restaurant POS Transformation — Day 4: promotions (docs/day-plans/day4.md, Bisma's half).
-- Additive only: one new table, no change to any existing table or constraint.
--
-- discount_kind/discount_value deliberately mirror LineDiscount's own {percent,bps}|{fixed,cents}
-- shape (packages/domain/src/money.ts) -- so turning an active promotion into a LineDiscount at
-- checkout (Hamza's checkout-wiring task) is a direct mapping, not a translation layer. Same
-- convention Hamza's reward_rules (202609250001_loyalty_foundation.sql) already used for its own
-- discount_cents column.

create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 60),
  discount_kind text not null check (discount_kind in ('percent', 'fixed')),
  discount_value integer not null check (discount_value > 0), -- bps if percent, cents if fixed
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  unique (store_id, id)
);

alter table public.promotions enable row level security;
grant select on public.promotions to authenticated;
create policy promotions_member_read on public.promotions for select to authenticated using (public.is_store_member(store_id));
