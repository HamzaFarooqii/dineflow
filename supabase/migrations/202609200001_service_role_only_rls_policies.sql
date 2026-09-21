-- QA follow-up: pos_change_feed, pos_inventory_movements, pos_operation_ledger,
-- pos_sync_feed_state, terminal_cashier_sessions, terminal_device_sessions, terminal_devices
-- and terminal_employees have row level security enabled but carry no policy at all. Under
-- Postgres RLS semantics that already makes them unreadable/unwritable to the anon and
-- authenticated roles (only a role with BYPASSRLS, such as the service role apps/api's raw
-- pg.Pool connects with, can see rows) — so this migration changes no runtime behaviour.
--
-- It exists purely to make that "service-role only, no client policy needed" fact explicit and
-- machine-checkable instead of indistinguishable from an oversight: an explicit deny-all policy
-- documents intent in the schema itself, and grep in apps/web/src confirms no client code ever
-- calls .from() on any of these eight table names (see the companion guard test in
-- apps/web/tests/service-role-only-tables.test.ts).

create policy pos_change_feed_service_role_only on public.pos_change_feed
  for all to authenticated, anon using (false);

create policy pos_inventory_movements_service_role_only on public.pos_inventory_movements
  for all to authenticated, anon using (false);

create policy pos_operation_ledger_service_role_only on public.pos_operation_ledger
  for all to authenticated, anon using (false);

create policy pos_sync_feed_state_service_role_only on public.pos_sync_feed_state
  for all to authenticated, anon using (false);

create policy terminal_cashier_sessions_service_role_only on public.terminal_cashier_sessions
  for all to authenticated, anon using (false);

create policy terminal_device_sessions_service_role_only on public.terminal_device_sessions
  for all to authenticated, anon using (false);

create policy terminal_devices_service_role_only on public.terminal_devices
  for all to authenticated, anon using (false);

create policy terminal_employees_service_role_only on public.terminal_employees
  for all to authenticated, anon using (false);
