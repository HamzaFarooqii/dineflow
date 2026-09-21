-- Counterline Phase 1 foundation: authentication, stores and staff membership.
-- Apply with the Supabase CLI or paste into the SQL Editor once for a new project.
-- Do not put any service_role key, database password, or real employee PIN in this file.

create extension if not exists pgcrypto;

do $$
begin
  create type public.store_role as enum ('owner', 'manager', 'cashier');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_name_length check (char_length(full_name) <= 120)
);

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  timezone text not null default 'UTC',
  currency char(3) not null default 'USD',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stores_name_length check (char_length(trim(name)) between 2 and 120),
  constraint stores_currency_code check (currency ~ '^[A-Z]{3}$')
);

create table if not exists public.store_memberships (
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.store_role not null default 'cashier',
  active boolean not null default true,
  joined_at timestamptz not null default now(),
  primary key (store_id, user_id)
);

create table if not exists public.store_invites (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  email text not null,
  role public.store_role not null,
  invited_by uuid not null references auth.users(id),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (store_id, email),
  constraint invited_member_role check (role in ('manager', 'cashier')),
  constraint invite_email_normalized check (email = lower(trim(email)))
);

create index if not exists store_memberships_by_user
  on public.store_memberships(user_id, store_id) where active;
create index if not exists store_invites_by_email
  on public.store_invites(email) where accepted_at is null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(left(new.raw_user_meta_data ->> 'full_name', 120), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_store_member(target_store_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1 from public.store_memberships membership
    where membership.store_id = target_store_id
      and membership.user_id = (select auth.uid())
      and membership.active
  );
$$;

create or replace function public.is_store_admin(target_store_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1 from public.store_memberships membership
    where membership.store_id = target_store_id
      and membership.user_id = (select auth.uid())
      and membership.active
      and membership.role in ('owner', 'manager')
  );
$$;

create or replace function public.create_store(
  p_name text,
  p_timezone text default 'UTC',
  p_currency char(3) default 'USD'
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  new_store_id uuid;
  normalized_name text := trim(p_name);
  normalized_timezone text := trim(p_timezone);
  normalized_currency char(3) := upper(trim(p_currency));
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication is required';
  end if;
  if char_length(normalized_name) not between 2 and 120 then
    raise exception 'Store name must contain 2 to 120 characters';
  end if;
  if normalized_currency !~ '^[A-Z]{3}$' then
    raise exception 'Currency must be a three-letter ISO code';
  end if;
  perform timezone(normalized_timezone, now());

  insert into public.stores (name, code, timezone, currency, created_by)
  values (
    normalized_name,
    lower(regexp_replace(normalized_name, '[^a-zA-Z0-9]+', '-', 'g'))
      || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6),
    normalized_timezone,
    normalized_currency,
    (select auth.uid())
  )
  returning id into new_store_id;

  insert into public.store_memberships (store_id, user_id, role)
  values (new_store_id, (select auth.uid()), 'owner');

  return new_store_id;
end;
$$;

create or replace function public.invite_store_member(
  p_store_id uuid,
  p_email text,
  p_role public.store_role default 'cashier'
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  new_invite_id uuid;
  normalized_email text := lower(trim(p_email));
begin
  if not public.is_store_admin(p_store_id) then
    raise exception 'Only a store owner or manager can invite staff';
  end if;
  if p_role = 'owner' then
    raise exception 'Owner access cannot be granted by invitation';
  end if;
  if position('@' in normalized_email) <= 1 then
    raise exception 'A valid email is required';
  end if;

  insert into public.store_invites (store_id, email, role, invited_by, expires_at, accepted_at)
  values (p_store_id, normalized_email, p_role, (select auth.uid()), now() + interval '7 days', null)
  on conflict (store_id, email) do update
    set role = excluded.role,
        invited_by = excluded.invited_by,
        expires_at = excluded.expires_at,
        accepted_at = null
  returning id into new_invite_id;

  return new_invite_id;
end;
$$;

create or replace function public.accept_store_invites()
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  invite_record record;
  accepted_count integer := 0;
  signed_in_email text := lower(coalesce((select auth.jwt() ->> 'email'), ''));
begin
  if (select auth.uid()) is null or signed_in_email = '' then
    raise exception 'Authentication with a verified email is required';
  end if;

  for invite_record in
    select id, store_id, role
    from public.store_invites
    where email = signed_in_email
      and accepted_at is null
      and expires_at > now()
  loop
    insert into public.store_memberships (store_id, user_id, role)
    values (invite_record.store_id, (select auth.uid()), invite_record.role)
    on conflict (store_id, user_id) do nothing;

    update public.store_invites
      set accepted_at = now()
      where id = invite_record.id;
    accepted_count := accepted_count + 1;
  end loop;

  return accepted_count;
end;
$$;

alter table public.profiles enable row level security;
alter table public.stores enable row level security;
alter table public.store_memberships enable row level security;
alter table public.store_invites enable row level security;

revoke all on public.profiles, public.stores, public.store_memberships, public.store_invites from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.stores, public.store_memberships, public.store_invites to authenticated;

create policy "profile owner can read profile"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
create policy "profile owner can update profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
create policy "store members can read their stores"
  on public.stores for select to authenticated
  using (public.is_store_member(id));
create policy "members can read themselves and store admins can read their team"
  on public.store_memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.is_store_admin(store_id));
create policy "invited users and store admins can read invitations"
  on public.store_invites for select to authenticated
  using (
    public.is_store_admin(store_id)
    or email = lower(coalesce((select auth.jwt() ->> 'email'), ''))
  );

revoke all on function public.create_store(text, text, char(3)) from public;
revoke all on function public.invite_store_member(uuid, text, public.store_role) from public;
revoke all on function public.accept_store_invites() from public;
grant execute on function public.create_store(text, text, char(3)) to authenticated;
grant execute on function public.invite_store_member(uuid, text, public.store_role) to authenticated;
grant execute on function public.accept_store_invites() to authenticated;
