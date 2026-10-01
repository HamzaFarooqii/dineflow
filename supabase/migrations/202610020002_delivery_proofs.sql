-- Day 2, Part 2 (Dispatch) -- proof-of-delivery. No SMS/push notification provider exists
-- anywhere in this codebase (checked before choosing this design), so a one-time confirmation
-- code is the mechanism the assignment itself prefers in that case, over photo/signature evidence
-- (which would need a private authorized storage bucket -- the only existing bucket,
-- product-images, is public and explicitly unsuitable per 202609180004_product_images.sql).
--
-- Issued once, automatically, at delivery-order creation (delivery.ts's
-- createDeliveryOrderSnapshot) -- the plaintext code is returned exactly once, in that same
-- checkout's push response, for whoever is taking the (phone) order to read to the customer right
-- then. It is never stored in plaintext and never re-returned by any later request. The customer
-- gives it back to the rider at the door; the rider's device submits it to complete the
-- 'out_for_delivery' -> 'delivered' transition (applyDeliveryTransition), verified server-side.
--
-- One row per issuance, not one row per delivery: a manager can reissue a fresh code (e.g. the
-- customer lost it, or attempts were exhausted) without losing the audit trail of the original.
-- "The" active proof for a delivery is whichever row is newest and not yet invalidated/consumed/
-- expired -- there is no uniqueness constraint forcing exactly one, only the application's own
-- query order (delivery.ts, loadActiveProof: "order by created_at desc limit 1").
create table public.delivery_proofs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  delivery_order_id uuid not null,

  code_hash text not null,                 -- sha256(code); the code itself is never persisted
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  expires_at timestamptz not null,
  consumed_at timestamptz,                 -- set the moment it successfully completes a delivery
  invalidated_at timestamptz,              -- set on reissue, or once attempt_count reaches max_attempts

  created_at timestamptz not null default now(),

  unique (store_id, id),
  foreign key (store_id, delivery_order_id) references public.delivery_orders(store_id, id)
);
create index delivery_proofs_by_delivery on public.delivery_proofs(store_id, delivery_order_id, created_at desc);

-- RLS: same member-read / API-service-role-write convention as delivery_orders itself
-- (202609280002_delivery_operations.sql). The code_hash is a hash, not a secret in plaintext, but
-- read access still stays store-member-scoped like every other operational table here, not public.
alter table public.delivery_proofs enable row level security;
grant select on public.delivery_proofs to authenticated;
create policy delivery_proofs_member_read on public.delivery_proofs for select to authenticated using (public.is_store_member(store_id));
