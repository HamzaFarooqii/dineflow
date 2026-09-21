-- Store administrators can already read team memberships. Allow a member's name
-- to be displayed only to people who share at least one store with that member.
create policy "store members can read teammate profiles"
  on public.profiles for select to authenticated
  using (
    exists (
      select 1
      from public.store_memberships viewer
      join public.store_memberships teammate on teammate.store_id = viewer.store_id
      where viewer.user_id = (select auth.uid())
        and viewer.active
        and teammate.user_id = profiles.id
        and teammate.active
    )
  );
