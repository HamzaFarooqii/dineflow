-- New stores were auto-seeded with 8 hardcoded demo products (Ceramic Mug, Canvas Tote, etc.)
-- via a trigger on stores insert. That made sense for early manual testing but means every real
-- owner's brand-new store starts with fake inventory instead of an empty catalog. Stop seeding
-- future stores; existing stores keep whatever demo/real products they already have — this does
-- not delete any product, category, tax rate or stock row.

drop trigger if exists pos_demo_catalog_after_store on public.stores;
drop function if exists public.pos_seed_new_store();

-- pos_seed_demo_catalog(uuid) itself is left in place (already revoked from anon/authenticated)
-- as a manually-invocable admin utility, in case demo data is still wanted for a test project.
