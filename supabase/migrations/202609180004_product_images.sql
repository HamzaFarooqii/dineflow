-- Product images (FEAT-CAT-01 extension). Optional — a product without one falls back to a
-- placeholder in the UI; this is never a required field, matching the schema's existing
-- "provisional data" tolerance elsewhere.

alter table public.pos_products
  add column image_url text,
  add constraint pos_products_image_url_length check (image_url is null or char_length(image_url) <= 2048);

-- Storage bucket for product photos. Public read is a deliberate simplification: cashier
-- terminals authenticate to our own API via a device session, not a Supabase user JWT, so they
-- have no Supabase-auth identity an RLS-gated read policy could check against. A plain <img src>
-- on the terminal (and in the browser catalog) therefore needs an unauthenticated URL. Product
-- photos are not sensitive, so public read is an acceptable trade-off; writes stay restricted
-- below. Revisit if this bucket is ever asked to hold anything sensitive.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- Objects are stored as "{store_id}/{filename}" — storage.foldername(name) splits that path so
-- the first segment can be checked against the caller's store membership, the same multi-tenant
-- pattern Supabase's own storage RLS examples use.
create policy "product images public read"
  on storage.objects for select
  to public
  using (bucket_id = 'product-images');

create policy "owner or manager can upload product images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'product-images'
    and public.is_store_admin((storage.foldername(name))[1]::uuid)
  );

create policy "owner or manager can replace product images"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'product-images'
    and public.is_store_admin((storage.foldername(name))[1]::uuid)
  )
  with check (
    bucket_id = 'product-images'
    and public.is_store_admin((storage.foldername(name))[1]::uuid)
  );

create policy "owner or manager can delete product images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'product-images'
    and public.is_store_admin((storage.foldername(name))[1]::uuid)
  );
