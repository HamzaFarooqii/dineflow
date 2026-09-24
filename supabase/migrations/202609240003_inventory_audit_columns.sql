-- Restaurant POS Transformation — Day 3: inventory audit columns (docs/day-plans/day3.md,
-- Bisma's half). Additive only: two nullable columns on tables created by 202609240002. Every
-- inventory write goes through requireStoreManager (web, owner/manager only — no terminal/
-- cashier route exists for inventory), so the acting user is always a real auth.users row;
-- nullable only because these columns predate any historical rows (there are none yet, but the
-- convention elsewhere in this schema is not to force a fabricated backfill value).
alter table public.ingredients
  add column created_by_user_id uuid references auth.users(id);

alter table public.stock_movements
  add column created_by_user_id uuid references auth.users(id);
