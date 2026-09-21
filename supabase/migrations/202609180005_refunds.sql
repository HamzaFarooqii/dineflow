-- Minimal whole-order refunds. docs/04_er_diagrams.md:98 defers a full Refunds/refund_items
-- design to Phase 2+ but sketches the required shape: the original order is never mutated — a
-- refund is a separate, append-only record that references the sale through order_id, and the
-- return itself through its own refund_id (never the reverse: an orders row must never gain a
-- refund foreign key). This migration builds exactly that shape, restricted to a whole-order
-- refund (no partial line items, no re-charging), which is the only flow the owner/manager UI
-- exposes.

create table public.pos_refunds (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  order_id uuid not null,
  amount_cents bigint not null check (amount_cents between 0 and 1000000000),
  reason text check (reason is null or char_length(trim(reason)) <= 240),
  refunded_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  -- Whole-order refund only: at most one refund per order.
  unique (store_id, order_id),
  unique (store_id, id),
  foreign key (store_id, order_id) references public.pos_orders(store_id, id)
);

create table public.pos_refund_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  refund_id uuid not null,
  -- Not a composite FK against pos_order_items (its primary key is a bare id, with no
  -- unique(store_id, id) to reference) — the API scopes this lookup by store_id itself when it
  -- builds these rows, inside the same transaction that already validated the parent order.
  order_item_id uuid not null references public.pos_order_items(id),
  product_id uuid not null,
  quantity integer not null check (quantity > 0),
  amount_cents bigint not null check (amount_cents between 0 and 1000000000),
  foreign key (store_id, refund_id) references public.pos_refunds(store_id, id),
  foreign key (store_id, product_id) references public.pos_products(store_id, id)
);

create index pos_refunds_by_order on public.pos_refunds(store_id, order_id);
create index pos_refund_items_by_refund on public.pos_refund_items(store_id, refund_id);

-- pos_inventory_movements.reason only allowed ('sale', 'opening_stock') — add 'refund' so the
-- stock reversal below can be recorded with an honest reason instead of misreporting a refund
-- as a sale or opening-stock adjustment.
alter table public.pos_inventory_movements
  drop constraint pos_inventory_movements_reason_check;
alter table public.pos_inventory_movements
  add constraint pos_inventory_movements_reason_check check (reason in ('sale', 'opening_stock', 'refund'));

alter table public.pos_refunds enable row level security;
alter table public.pos_refund_items enable row level security;
revoke all on public.pos_refunds, public.pos_refund_items from anon, authenticated;
grant select on public.pos_refunds, public.pos_refund_items to authenticated;
create policy pos_refunds_member_read on public.pos_refunds for select to authenticated using (public.is_store_member(store_id));
create policy pos_refund_items_member_read on public.pos_refund_items for select to authenticated using (public.is_store_member(store_id));

-- 'refund' change_feed entries let a provisioned terminal eventually learn a receipt it printed
-- was reversed (pull sync itself is not implemented anywhere yet — see the 'product'/'tax_rate'
-- migrations for the same forward-looking note).
alter table public.pos_change_feed
  drop constraint if exists pos_change_feed_entity_type_check;

alter table public.pos_change_feed
  add constraint pos_change_feed_entity_type_check
  check (entity_type in ('order', 'stock', 'product', 'customer', 'tax_rate', 'refund'));
