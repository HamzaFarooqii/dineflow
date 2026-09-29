-- Kitchen operations depth (Ahmad's A3 work): course-based firing, SLA tracking and a fire audit
-- trail. Every new column is nullable/defaulted so the existing "fire everything immediately"
-- behavior (every ticket item created today has no course, no held state) is completely
-- unaffected until a product actually has course data and the API starts honoring it.

alter table public.kitchen_ticket_items
  -- Snapshotted from pos_products.course at ticket-creation time, same principle as
  -- snapshot_price_cents on pos_order_items -- a later product edit must never rewrite which
  -- course an already-fired (or already-queued) ticket item belongs to.
  add column course text check (course is null or course in ('appetizer', 'main', 'dessert', 'side', 'beverage')),
  -- Snapshotted preparation target in seconds (pos_products.prep_time_seconds, or the domain
  -- default when unset) -- the SLA clock is always measured against this snapshot, never a live
  -- re-fetch of the product's current prep time.
  add column prep_time_target_seconds integer check (prep_time_target_seconds is null or prep_time_target_seconds > 0),
  -- Set when a course has been explicitly held back from firing (informational -- the item's
  -- status stays 'queued' either way; this only distinguishes "queued, not yet due" from "queued,
  -- deliberately held" for the KDS board). Cleared the moment the course is actually fired.
  add column held_at timestamptz;

-- An explicit, append-only record of who fired which course and when -- there was no audit trail
-- on kitchen ticket transitions before this (the existing item-status PATCH is a bare UPDATE).
create table public.kitchen_course_fire_log (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  ticket_id uuid not null,
  course text not null check (course in ('appetizer', 'main', 'dessert', 'side', 'beverage')),
  fired_by_employee_id uuid,
  fired_by_user_id uuid references auth.users(id),
  fired_item_count integer not null check (fired_item_count > 0),
  fired_at timestamptz not null default now(),
  foreign key (store_id, ticket_id) references public.kitchen_tickets(store_id, id),
  foreign key (store_id, fired_by_employee_id) references public.terminal_employees(store_id, id)
);
create index kitchen_course_fire_log_by_ticket on public.kitchen_course_fire_log(store_id, ticket_id);

alter table public.kitchen_course_fire_log enable row level security;
grant select on public.kitchen_course_fire_log to authenticated;
create policy kitchen_course_fire_log_member_read on public.kitchen_course_fire_log for select to authenticated using (public.is_store_member(store_id));

-- Manager ticket history (served/cancelled tickets, date/station/status filtered, paginated) --
-- today's only index is (store_id, status), which serves the active board's `in (...)` filter
-- but not an ordered, paginated history read.
create index kitchen_tickets_by_store_status_created on public.kitchen_tickets(store_id, status, created_at desc);
