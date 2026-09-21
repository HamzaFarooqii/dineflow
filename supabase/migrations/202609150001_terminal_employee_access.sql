-- Terminal access only. Independent of the unmerged offline POS foundation.
create table public.terminal_devices (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 80),
  receipt_prefix text not null unique,
  provisioned_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  refresh_hash text not null unique,
  refresh_expires_at timestamptz not null,
  access_hash text not null unique,
  access_expires_at timestamptz not null,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 4),
  locked_until timestamptz,
  unique(store_id, id)
);
create table public.terminal_employees (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 80),
  role text not null check (role in ('cashier','manager')),
  active boolean not null default true,
  pin_salt text not null check (pin_salt ~ '^[0-9a-f]{32}$'),
  pin_hash text not null check (pin_hash ~ '^[0-9a-f]{64}$'),
  permission_version integer not null default 1 check (permission_version > 0),
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 4),
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  unique(store_id, id)
);
create table public.terminal_cashier_sessions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  device_id uuid not null,
  employee_id uuid not null,
  token_hash text not null unique,
  permission_version integer not null,
  logged_in_at timestamptz not null default now(),
  last_server_validated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  foreign key (store_id, device_id) references public.terminal_devices(store_id, id),
  foreign key (store_id, employee_id) references public.terminal_employees(store_id, id)
);
alter table public.terminal_devices enable row level security;
alter table public.terminal_employees enable row level security;
alter table public.terminal_cashier_sessions enable row level security;
-- No browser access to credential tables, including store administrators.
revoke all on public.terminal_devices, public.terminal_employees, public.terminal_cashier_sessions from public, anon, authenticated;
grant select, insert, update on public.terminal_devices, public.terminal_employees, public.terminal_cashier_sessions to service_role;
create index terminal_employees_store on public.terminal_employees(store_id);
create index terminal_sessions_device on public.terminal_cashier_sessions(device_id);
