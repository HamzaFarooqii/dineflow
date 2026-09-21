-- Track B (reporting): owner activity/audit log. Records sensitive management actions (terminal
-- revoke/reactivate, employee create/update) so owners and managers can review who did what.
-- The API writes rows via the raw pg.Pool, which bypasses RLS entirely, so this policy is
-- defense-in-depth for any future direct-client read, matching pos_orders_report_read_access.

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  actor_id uuid not null references auth.users(id),
  action text not null check (char_length(action) between 1 and 80),
  target text not null check (char_length(target) between 1 and 200),
  created_at timestamptz not null default now()
);

create index audit_log_store_created_idx on public.audit_log (store_id, created_at desc);

alter table public.audit_log enable row level security;

grant select on public.audit_log to authenticated;

create policy audit_log_member_read on public.audit_log for select to authenticated
  using (public.is_store_member(store_id) and exists (
    select 1 from public.store_memberships m
    where m.store_id = audit_log.store_id and m.user_id = auth.uid() and m.active and m.role in ('owner', 'manager')
  ));

-- No insert/update/delete policy: the API writes audit rows via the service-role pg.Pool
-- connection, which is not subject to RLS. No client role should ever be able to write audit rows.
