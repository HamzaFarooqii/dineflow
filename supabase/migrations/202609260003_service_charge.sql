-- Restaurant POS — configurable service charge (docs/day-plans/day5.md gap-fill).
-- A store-level percentage (basis points, same convention as everything else in this schema)
-- applied to the whole bill's post-discount subtotal, on top of tax -- not a per-line concept
-- like a discount, so it lives on pos_orders only, never pos_order_items.

alter table public.stores
  add column service_charge_bps integer not null default 0 check (service_charge_bps between 0 and 10000);

do $$
declare con_name text;
begin
  select conname into con_name from pg_constraint
    where conrelid = 'public.pos_orders'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) = 'CHECK ((total_cents = ((subtotal_cents - discount_cents) + tax_cents)))';
  if con_name is not null then execute format('alter table public.pos_orders drop constraint %I', con_name); end if;
end $$;

alter table public.pos_orders
  add column service_charge_cents bigint not null default 0 check (service_charge_cents between 0 and 1000000000),
  add constraint pos_orders_total_matches_lines check (total_cents = subtotal_cents - discount_cents + tax_cents + service_charge_cents);
