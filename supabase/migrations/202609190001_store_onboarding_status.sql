-- Tracks whether a store has completed the mandatory post-signup onboarding wizard
-- (store profile confirmation, first terminal, first cashier employee).
-- Existing stores are backfilled as already onboarded so this never re-gates them.

alter table public.stores
  add column if not exists onboarding_completed_at timestamptz;

update public.stores
  set onboarding_completed_at = created_at
  where onboarding_completed_at is null;

create or replace function public.update_store_profile(
  p_store_id uuid,
  p_name text,
  p_timezone text,
  p_currency char(3)
)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  normalized_name text := trim(p_name);
  normalized_timezone text := trim(p_timezone);
  normalized_currency char(3) := upper(trim(p_currency));
begin
  if not public.is_store_admin(p_store_id) then
    raise exception 'Only a store owner or manager can update the store profile';
  end if;
  if char_length(normalized_name) not between 2 and 120 then
    raise exception 'Store name must contain 2 to 120 characters';
  end if;
  if normalized_currency !~ '^[A-Z]{3}$' then
    raise exception 'Currency must be a three-letter ISO code';
  end if;
  perform timezone(normalized_timezone, now());

  update public.stores
    set name = normalized_name,
        timezone = normalized_timezone,
        currency = normalized_currency,
        updated_at = now()
    where id = p_store_id;
end;
$$;

create or replace function public.complete_store_onboarding(p_store_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  if not public.is_store_admin(p_store_id) then
    raise exception 'Only a store owner or manager can complete onboarding';
  end if;

  update public.stores
    set onboarding_completed_at = now()
    where id = p_store_id
      and onboarding_completed_at is null;
end;
$$;

revoke all on function public.update_store_profile(uuid, text, text, char(3)) from public;
revoke all on function public.complete_store_onboarding(uuid) from public;
grant execute on function public.update_store_profile(uuid, text, text, char(3)) to authenticated;
grant execute on function public.complete_store_onboarding(uuid) to authenticated;
