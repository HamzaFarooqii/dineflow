-- Day 2, Part 2 (Dispatch) -- honest ETA configuration.
-- An owner/manager can optionally set a per-store target delivery duration (minutes, order
-- creation to delivered). When unset, delivery.ts's ETA estimate instead falls back to this
-- store's own historical average time-to-delivered (delivery.ts, loadEtaBasis) -- and when
-- neither this column nor enough real history exists, the ETA is honestly null, never guessed.
-- Nullable by design: null is "no explicit configuration", not zero minutes.

alter table public.stores
  add column delivery_target_minutes integer check (delivery_target_minutes is null or delivery_target_minutes between 1 and 360);
