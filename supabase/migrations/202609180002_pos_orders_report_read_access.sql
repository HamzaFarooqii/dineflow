-- Track B (reporting): member-scoped read access on the completed-sale tables, plus cashier
-- attribution on pos_orders. The API reads these tables via the raw pg.Pool, which bypasses RLS
-- entirely, so this policy is defense-in-depth for any future direct-client read, not a functional
-- dependency of the report endpoints built alongside it.

grant select on public.pos_orders, public.pos_order_items, public.pos_payments to authenticated;
create policy pos_orders_member_read on public.pos_orders for select to authenticated using (public.is_store_member(store_id));
create policy pos_order_items_member_read on public.pos_order_items for select to authenticated using (public.is_store_member(store_id));
create policy pos_payments_member_read on public.pos_payments for select to authenticated using (public.is_store_member(store_id));

-- Cashier attribution: previously pos_orders could only be traced to a terminal/device via
-- receipt_prefix, with no record of which employee rang the sale up.
alter table public.pos_orders
  add column employee_id uuid,
  add foreign key (store_id, employee_id) references public.terminal_employees(store_id, id);
