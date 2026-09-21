-- Move terminal credentials into revocable, rotatable device sessions.
-- This follows the already-applied terminal access migration without editing it.
create table public.terminal_device_sessions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  device_id uuid not null,
  access_hash text not null unique check (access_hash ~ '^[0-9a-f]{64}$'),
  access_expires_at timestamptz not null,
  refresh_hash text not null unique check (refresh_hash ~ '^[0-9a-f]{64}$'),
  refresh_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  rotated_from uuid references public.terminal_device_sessions(id),
  foreign key (store_id, device_id) references public.terminal_devices(store_id, id)
);

-- Preserve every existing provisioned browser session during the upgrade.
insert into public.terminal_device_sessions (
  store_id, device_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at
)
select store_id, id, access_hash, access_expires_at, refresh_hash, refresh_expires_at
from public.terminal_devices;

alter table public.terminal_devices alter column access_hash drop not null;
alter table public.terminal_devices alter column access_expires_at drop not null;
alter table public.terminal_devices alter column refresh_hash drop not null;
alter table public.terminal_devices alter column refresh_expires_at drop not null;
update public.terminal_devices
set access_hash = null,
    access_expires_at = null,
    refresh_hash = null,
    refresh_expires_at = null;

alter table public.terminal_device_sessions enable row level security;
revoke all on public.terminal_device_sessions from public, anon, authenticated;
grant select, insert, update on public.terminal_device_sessions to service_role;
create index terminal_device_sessions_device on public.terminal_device_sessions(device_id);
create index terminal_device_sessions_refresh on public.terminal_device_sessions(refresh_hash);
create index terminal_device_sessions_access on public.terminal_device_sessions(access_hash);
