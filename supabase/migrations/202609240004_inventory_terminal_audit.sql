-- Restaurant POS Transformation — Day 3: cashier-terminal inventory writes (docs/day-plans/
-- day3.md, Bisma's half). created_by_user_id (202609240003) only applies to a Supabase-
-- authenticated owner/manager web session; a cashier terminal has no such user, only a
-- terminal_employees row plus, for any inventory write, a manager's PIN approval — the same
-- evidence pattern pos_orders already uses for over-authority discounts (manager_id +
-- manager_approved_at, paired or both null, PIN itself never leaves the browser).
alter table public.ingredients
  add column created_by_employee_id uuid references public.terminal_employees(id),
  add column manager_id uuid references public.terminal_employees(id),
  add column manager_approved_at timestamptz,
  add constraint ingredients_manager_evidence_paired check ((manager_id is null) = (manager_approved_at is null));

alter table public.stock_movements
  add column created_by_employee_id uuid references public.terminal_employees(id),
  add column manager_id uuid references public.terminal_employees(id),
  add column manager_approved_at timestamptz,
  add constraint stock_movements_manager_evidence_paired check ((manager_id is null) = (manager_approved_at is null));
