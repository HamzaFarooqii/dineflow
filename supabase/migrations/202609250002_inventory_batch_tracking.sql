-- Inventory UX redesign (Hamza) -- schema support for per-batch remaining-quantity tracking,
-- a free-text batch reference, and an ingredient-level updated_at for "recently updated" sorting.
-- Additive only: new nullable/defaulted columns, no change to any existing constraint.
--
-- remaining_quantity backfills to quantity for every existing row -- every batch received before
-- this migration is, by definition, fully unspent from the schema's point of view (nothing has
-- ever decremented a specific batch before now; only the ingredient's aggregate current_stock
-- moved). That's the correct, honest starting value, not an approximation.
alter table public.ingredient_batches
  add column remaining_quantity numeric,
  add column reference text check (reference is null or length(trim(reference)) <= 200);

update public.ingredient_batches set remaining_quantity = quantity where remaining_quantity is null;

alter table public.ingredient_batches
  alter column remaining_quantity set not null,
  add constraint ingredient_batches_remaining_quantity_check check (remaining_quantity >= 0 and remaining_quantity <= quantity);

alter table public.ingredients
  add column updated_at timestamptz not null default now();
