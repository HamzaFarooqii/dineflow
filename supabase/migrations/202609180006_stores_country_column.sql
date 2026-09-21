-- Fix-up: 202609180002_store_business_details.sql was expected to add both stores.address and
-- stores.country, but the deployed database ended up with address + an unplanned "locale" column
-- instead of country, and without either check constraint. Per rules.md, an already-applied
-- migration is never edited — this adds exactly what's missing instead. "locale" is left alone
-- (not part of this task; drop it in its own migration later if it turns out to be unwanted).

alter table public.stores
  add column country char(2),
  add constraint stores_country_code check (country is null or country ~ '^[A-Z]{2}$');

-- address exists but never got its length constraint — add it now too, guarded in case any
-- existing row is already too long (astronomically unlikely, but this must not fail on data).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stores_address_length') then
    if exists (select 1 from public.stores where address is not null and char_length(trim(address)) > 240) then
      raise notice 'Skipping stores_address_length: an existing address exceeds 240 characters.';
    else
      alter table public.stores
        add constraint stores_address_length check (address is null or char_length(trim(address)) <= 240);
    end if;
  end if;
end $$;
