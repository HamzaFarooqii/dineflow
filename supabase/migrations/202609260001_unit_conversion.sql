-- Restaurant POS — unit conversion for recipe costing (fills a documented Day 3 gap: a recipe
-- line previously only costed when its unit was the ingredient's own stored unit exactly).
--
-- Each unit optionally stores a conversion factor relative to an implicit per-kind base unit
-- (mass -> gram, volume -> milliliter; count has no universal base, see below). A line and its
-- ingredient's unit are convertible only when BOTH have a non-null factor_to_base of the SAME
-- kind -- two units that are merely the same kind but have never been given a real factor stay
-- unconvertible, exactly like today, rather than silently guessing a 1:1 ratio. The identical
-- unit always still costs directly regardless of factor_to_base (see recipe-cost.ts).
--
-- Nullable and defaulted to null: every existing unit keeps today's exact-match-only behavior
-- until someone explicitly gives it a real factor (via the curated common-units quick-add, which
-- ships correct factors for mg/g/kg/ml/L, or by hand for a custom unit).
alter table public.units add column factor_to_base numeric check (factor_to_base is null or factor_to_base > 0);
comment on column public.units.factor_to_base is
  'How many of this kind''s implicit base unit (gram for mass, milliliter for volume) one unit of this row equals. Null means no known conversion -- this unit only costs against its own exact id.';
