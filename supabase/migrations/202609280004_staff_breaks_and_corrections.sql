-- B5 (staff timekeeping): paid/unpaid breaks against an open shift, plus an immutable manager
-- correction log for shift/break records. Extends public.shifts (202609260002) the same way
-- purchasing/inventory extend their own foundations -- store-scoped, composite tenant FKs, RLS
-- for member reads, writes go through the API's service-role pg.Pool only.

-- 1. Breaks: paid or unpaid, against a single shift. clocked_out_at is null while a shift is
-- open (see shifts table); a break can only be attached to a shift, and only one break can be
-- open per shift at a time (partial unique index below mirrors shifts_one_open_per_employee).
-- Whether the referenced shift is *currently open* is enforced by the trigger further down --
-- a unique/foreign key alone can't express "the parent row's own state must be X".
create table public.shift_breaks (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  shift_id uuid not null,
  employee_id uuid not null,
  paid boolean not null default false,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (store_id, id),
  foreign key (store_id, shift_id) references public.shifts(store_id, id),
  foreign key (store_id, employee_id) references public.terminal_employees(store_id, id),
  check (ended_at is null or ended_at > started_at)
);
create unique index shift_breaks_one_open_per_shift on public.shift_breaks(store_id, shift_id) where ended_at is null;
create index shift_breaks_store_started on public.shift_breaks(store_id, started_at);

-- A break may only be opened against a shift that is currently open (clocked_out_at is null).
-- Enforced in the database, not only in API code, so this holds even under concurrent requests
-- racing the same shift -- the trigger runs inside the same transaction as the insert and sees
-- a row-locked (or just-read) shifts row.
create function public.check_break_against_open_shift() returns trigger language plpgsql as $$
declare
  shift_open boolean;
begin
  select (clocked_out_at is null) into shift_open
  from public.shifts where store_id = new.store_id and id = new.shift_id
  for update;
  if shift_open is null then
    raise exception 'shift % not found in store %', new.shift_id, new.store_id using errcode = '23503';
  end if;
  if not shift_open then
    raise exception 'cannot start a break against a shift that is not open' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger shift_breaks_require_open_shift
  before insert on public.shift_breaks
  for each row execute function public.check_break_against_open_shift();

alter table public.shift_breaks enable row level security;
grant select on public.shift_breaks to authenticated;
create policy shift_breaks_member_read on public.shift_breaks for select to authenticated using (public.is_store_member(store_id));

-- 2. Immutable correction/audit log for manager edits to shift or break records. Every correction
-- records who changed what, the old and new value, and a required reason -- history is never
-- silently mutated; a "correction" is always an additional row, and the underlying shift/break
-- row is updated in the same transaction as the audit insert (see timekeeping.ts).
create table public.timekeeping_corrections (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  record_type text not null check (record_type in ('shift', 'break')),
  record_id uuid not null,
  corrected_by uuid not null references auth.users(id),
  field text not null check (char_length(field) between 1 and 60),
  old_value text,
  new_value text not null check (char_length(new_value) between 1 and 200),
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now()
);
create index timekeeping_corrections_store_created_idx on public.timekeeping_corrections(store_id, created_at desc);
create index timekeeping_corrections_record_idx on public.timekeeping_corrections(store_id, record_type, record_id);

alter table public.timekeeping_corrections enable row level security;
grant select on public.timekeeping_corrections to authenticated;
create policy timekeeping_corrections_member_read on public.timekeeping_corrections for select to authenticated
  using (public.is_store_member(store_id) and exists (
    select 1 from public.store_memberships m
    where m.store_id = timekeeping_corrections.store_id and m.user_id = auth.uid() and m.active and m.role in ('owner', 'manager')
  ));

-- Defense in depth beyond "no update/delete policy": even the service-role connection the API
-- uses (which bypasses RLS entirely) cannot mutate or remove a correction row once written.
create function public.forbid_correction_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'timekeeping_corrections rows are immutable' using errcode = '0A000';
end;
$$;
create trigger timekeeping_corrections_immutable
  before update or delete on public.timekeeping_corrections
  for each row execute function public.forbid_correction_mutation();

-- TODO(B5/A2 follow-up): once A2 (tip tracking) lands, add tip totals to staff reporting and,
-- if it introduces a per-order or per-payment tip_amount_cents column, surface a per-employee
-- tip total alongside the hours/break totals here and in the CSV export. Not built now: A2 has
-- not landed on develop as of this migration (no tip-related column exists anywhere in the
-- schema yet), and inventing that schema here would risk conflicting with the real workstream.
