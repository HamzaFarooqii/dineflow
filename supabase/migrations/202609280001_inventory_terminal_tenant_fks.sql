-- Day 5 security closeout: inventory terminal attribution must be tenant-scoped.
--
-- The original audit migration used bare terminal employee ids. UUIDs are globally unique in
-- practice, but every restaurant-owned relationship in Dineflow also carries store_id so the
-- database itself rejects cross-tenant attribution. Replace the four bare foreign keys with the
-- same composite pattern used by orders, shifts, tables, loyalty, recipes, and modifiers.

alter table public.ingredients
  drop constraint if exists ingredients_created_by_employee_id_fkey,
  drop constraint if exists ingredients_manager_id_fkey,
  add constraint ingredients_created_by_employee_store_fkey
    foreign key (store_id, created_by_employee_id)
    references public.terminal_employees(store_id, id),
  add constraint ingredients_manager_store_fkey
    foreign key (store_id, manager_id)
    references public.terminal_employees(store_id, id);

alter table public.stock_movements
  drop constraint if exists stock_movements_created_by_employee_id_fkey,
  drop constraint if exists stock_movements_manager_id_fkey,
  add constraint stock_movements_created_by_employee_store_fkey
    foreign key (store_id, created_by_employee_id)
    references public.terminal_employees(store_id, id),
  add constraint stock_movements_manager_store_fkey
    foreign key (store_id, manager_id)
    references public.terminal_employees(store_id, id);
