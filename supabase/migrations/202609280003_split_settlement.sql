-- Split settlement (Ahmad's A2 work): replaces the one-payment-per-order assumption with
-- multiple payment rows, adds an explicit tip figure per tender, and lets a refund allocate back
-- across the original tenders with an auditable running balance per tender. Every change here is
-- backward compatible with a single-cash or single-card sale that never splits: the new
-- tip_cents column defaults to zero, and the widened check constraint below reduces to exactly
-- the old formula when tip_cents is zero.

-- A single order can now carry more than one payment row (cash + external card split, itemized,
-- per-seat, ...). unique(store_id, id) replaces unique(store_id, order_id) as the tenant-scoped
-- key other tables reference this one by (pos_refund_tenders, below).
do $$
declare con_name text;
begin
  select conname into con_name from pg_constraint
    where conrelid = 'public.pos_payments'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (store_id, order_id)';
  if con_name is not null then execute format('alter table public.pos_payments drop constraint %I', con_name); end if;
end $$;
alter table public.pos_payments add constraint pos_payments_store_id_id_key unique (store_id, id);
create index pos_payments_by_order on public.pos_payments(store_id, order_id);

alter table public.pos_payments
  add column tip_cents bigint not null default 0 check (tip_cents between 0 and 1000000000);

do $$
declare con_name text;
begin
  select conname into con_name from pg_constraint
    where conrelid = 'public.pos_payments'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%method%cash%tendered_cents%';
  if con_name is not null then execute format('alter table public.pos_payments drop constraint %I', con_name); end if;
end $$;
alter table public.pos_payments add constraint pos_payments_tender_matches_method check (
  (method = 'cash' and tendered_cents = amount_cents + tip_cents + change_cents) or
  (method = 'card' and tendered_cents = amount_cents + tip_cents and change_cents = 0)
);

-- Refunds: was whole-order-only (at most one refund per order, one implicit "all tenders, all
-- items" allocation). Now a store can issue more than one refund against the same order over
-- time (a partial return today, another line returned next week), each one an explicit, still
-- append-only record of exactly which line items and which original tenders it covers.
do $$
declare con_name text;
begin
  select conname into con_name from pg_constraint
    where conrelid = 'public.pos_refunds'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (store_id, order_id)';
  if con_name is not null then execute format('alter table public.pos_refunds drop constraint %I', con_name); end if;
end $$;

create table public.pos_refund_tenders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  refund_id uuid not null,
  payment_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 1000000000),
  foreign key (store_id, refund_id) references public.pos_refunds(store_id, id),
  foreign key (store_id, payment_id) references public.pos_payments(store_id, id)
);
create index pos_refund_tenders_by_refund on public.pos_refund_tenders(store_id, refund_id);
create index pos_refund_tenders_by_payment on public.pos_refund_tenders(store_id, payment_id);

alter table public.pos_refund_tenders enable row level security;
revoke all on public.pos_refund_tenders from anon, authenticated;
grant select on public.pos_refund_tenders to authenticated;
create policy pos_refund_tenders_member_read on public.pos_refund_tenders for select to authenticated using (public.is_store_member(store_id));
