-- Restaurant POS — real staff roles beyond Cashier/Manager, plus clock-in/out shifts.
-- (docs/day-plans/day5.md, Hamza's schema-first task: lands before Ahmed's/Bisma's own-screen
-- permission gating starts, same sequencing every prior day used.)
--
-- 1. Extend terminal_employees.role. Purely additive: every existing check for role='manager'
-- (inventory.ts, orders.ts) or role='cashier' is unaffected -- a waiter/chef/inventory_manager/
-- rider is neither, so no existing authority check widens. Capability -> role mapping itself
-- lives in code (packages/domain/src/staff-role.ts), not the database, so it can change without
-- a migration.
alter table public.terminal_employees drop constraint terminal_employees_role_check;
alter table public.terminal_employees add constraint terminal_employees_role_check
  check (role in ('cashier', 'manager', 'waiter', 'chef', 'inventory_manager', 'rider'));

-- 2. Shifts: a clock-in/out record per terminal employee. Deliberately minimal -- no breaks, no
-- payroll export -- matching the agreed v1 scope. clocked_out_at is null while a shift is open;
-- an employee can only have one open shift at a time (partial unique index below).
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  employee_id uuid not null,
  device_id uuid not null,
  clocked_in_at timestamptz not null default now(),
  clocked_out_at timestamptz,
  unique (store_id, id),
  foreign key (store_id, employee_id) references public.terminal_employees(store_id, id),
  foreign key (store_id, device_id) references public.terminal_devices(store_id, id),
  check (clocked_out_at is null or clocked_out_at > clocked_in_at)
);
create unique index shifts_one_open_per_employee on public.shifts(store_id, employee_id) where clocked_out_at is null;
create index shifts_store_clocked_in on public.shifts(store_id, clocked_in_at);

alter table public.shifts enable row level security;
grant select on public.shifts to authenticated;
create policy shifts_member_read on public.shifts for select to authenticated using (public.is_store_member(store_id));
-- Writes go through the API (service-role) only, same convention as every other restaurant table.
