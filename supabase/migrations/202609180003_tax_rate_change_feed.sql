-- Add 'tax_rate' to pos_change_feed entity_type check constraint.
-- Required so POST /catalog/tax-rates can write change_feed entries for terminal pull sync,
-- the same way POST /catalog/products already does for 'product'.

alter table public.pos_change_feed
  drop constraint if exists pos_change_feed_entity_type_check;

alter table public.pos_change_feed
  add constraint pos_change_feed_entity_type_check
  check (entity_type in ('order', 'stock', 'product', 'customer', 'tax_rate'));
