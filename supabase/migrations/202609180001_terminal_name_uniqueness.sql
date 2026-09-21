-- Terminal reactivate + name uniqueness. Two active (non-revoked) terminals in the same store
-- must not share a name (case-insensitive): it would make the terminal list ambiguous for
-- managers and confusing for cashiers reading the receipt-prefix/name pairing at the register.
-- Revoked terminals are excluded so a retired name can be reused by a new device, and reactivating
-- a device can still collide with a name taken in the meantime (handled as a 23505 in the API).
create unique index terminal_devices_store_name_active_idx
  on public.terminal_devices (store_id, lower(name))
  where revoked_at is null;
