-- The previous migration (202609190002) dropped the demo-catalog seed trigger to stop
-- fake products showing up on new stores, but that trigger was also the only thing that
-- initialized public.pos_sync_feed_state for a new store. Without that row, the catalog
-- snapshot endpoint 503s with "Store snapshot is not initialized" for every brand-new
-- store. Replace it with a lean trigger that only creates the sync feed state row — no
-- demo categories, products, tax rates or stock.

create function public.pos_init_store_sync_state() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pos_sync_feed_state(store_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger pos_init_sync_state_after_store after insert on public.stores
for each row execute function public.pos_init_store_sync_state();

-- Backfill stores created after the demo-seed trigger was dropped but before this fix,
-- which are otherwise stuck permanently 503ing.
insert into public.pos_sync_feed_state(store_id)
select id from public.stores
on conflict do nothing;
