-- Store business details: address and country, editable by an owner/manager after store creation
-- through GET/PATCH /stores/:id. Both are nullable — a store that has not filled these in yet is
-- not blocked from operating (matches the existing "provisional data" tolerance elsewhere in the
-- schema; see stores_name_length / stores_currency_code for the naming convention these mirror).

alter table public.stores
  add column address text,
  add column country char(2),
  add constraint stores_address_length check (address is null or char_length(trim(address)) <= 240),
  add constraint stores_country_code check (country is null or country ~ '^[A-Z]{2}$');
