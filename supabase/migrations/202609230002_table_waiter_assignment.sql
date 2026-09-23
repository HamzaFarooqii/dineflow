-- Day 2 — Bisma: table waiter assignment. Additive only: one nullable column on
-- restaurant_tables plus a store-scoped foreign key into terminal_employees. Status transitions
-- and reads continue to use the column/constraint added by
-- 202609210001_restaurant_foundation.sql; no change to that migration's check constraint, since
-- every status value used by today's transitions is already covered by it.

alter table public.restaurant_tables
  add column assigned_waiter_id uuid;

-- A bare `references terminal_employees(id)` would allow assigning a waiter from a different
-- store. terminal_employees already carries a unique (store_id, id) constraint
-- (202609150001_terminal_employee_access.sql), so the composite FK below enforces same-store
-- assignment at the database level, not just in application code.
alter table public.restaurant_tables
  add constraint restaurant_tables_assigned_waiter_fkey
  foreign key (store_id, assigned_waiter_id)
  references public.terminal_employees(store_id, id);
