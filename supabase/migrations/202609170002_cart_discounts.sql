-- Cart-level line discounts (FEAT-AUTH-02): a line may carry a percent (basis points) or a fixed
-- integer-cent discount, applied to the line subtotal before tax. A discount above the cashier's
-- independent 20% authority requires manager approval; the PIN itself is verified offline on the
-- terminal (matching the existing terminal-auth trust model) and never reaches this API, so the
-- server only records and cross-checks the approving manager's identity for audit.

-- pos_orders and pos_order_items previously enforced total = subtotal + tax with an unnamed table
-- check constraint. Drop it by looking up its generated name rather than guessing it, then add the
-- discount-aware replacement.
do $$
declare con_name text;
begin
  select conname into con_name from pg_constraint
    where conrelid = 'public.pos_orders'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) = 'CHECK ((total_cents = (subtotal_cents + tax_cents)))';
  if con_name is not null then execute format('alter table public.pos_orders drop constraint %I', con_name); end if;
end $$;

alter table public.pos_orders
  add column discount_cents bigint not null default 0 check (discount_cents between 0 and 1000000000),
  add column manager_id uuid,
  add column manager_approved_at timestamptz,
  add constraint pos_orders_discount_within_subtotal check (discount_cents <= subtotal_cents),
  add constraint pos_orders_total_matches_lines check (total_cents = subtotal_cents - discount_cents + tax_cents),
  add constraint pos_orders_manager_evidence_paired check ((manager_id is null) = (manager_approved_at is null)),
  add foreign key (store_id, manager_id) references public.terminal_employees(store_id, id);

do $$
declare con_name text;
begin
  select conname into con_name from pg_constraint
    where conrelid = 'public.pos_order_items'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) = 'CHECK ((total_cents = (subtotal_cents + tax_cents)))';
  if con_name is not null then execute format('alter table public.pos_order_items drop constraint %I', con_name); end if;
end $$;

alter table public.pos_order_items
  add column discount_kind text check (discount_kind in ('percent', 'fixed')),
  add column discount_value integer check (discount_value >= 0),
  add column discount_applied_cents bigint,
  add column taxable_cents bigint;

update public.pos_order_items set discount_applied_cents = 0, taxable_cents = subtotal_cents
  where discount_applied_cents is null;

alter table public.pos_order_items
  alter column discount_applied_cents set not null,
  alter column discount_applied_cents set default 0,
  alter column taxable_cents set not null,
  add constraint pos_order_items_discount_applied_range check (discount_applied_cents between 0 and 1000000000),
  add constraint pos_order_items_taxable_range check (taxable_cents between 0 and 1000000000),
  add constraint pos_order_items_discount_within_subtotal check (discount_applied_cents <= subtotal_cents),
  add constraint pos_order_items_taxable_matches check (taxable_cents = subtotal_cents - discount_applied_cents),
  add constraint pos_order_items_total_matches check (total_cents = taxable_cents + tax_cents),
  add constraint pos_order_items_discount_kind_requires_value check ((discount_kind is null) = (discount_value is null));
