# Migration ledger

This project does not use the Supabase CLI's own `supabase_migrations.schema_migrations`
tracking (no `supabase/config.toml`, project not linked). That table does not exist in the live
database, so there was previously no DB-side source of truth for which of the files in this
directory are actually applied.

This file is that source of truth instead. Each row's checksum and "confirmed by" marker were
verified against the live database on 2026-09-19 by querying `information_schema`/`pg_catalog`
for an object each migration is responsible for creating (or, for a `drop`, for its absence) —
see `apps/api/scripts/verify-migrations.mjs`, which can be re-run at any time to re-confirm this
table stays accurate.

**When adding a new migration file**: add a row here in the same pass, with its SHA-256
(`sha256sum supabase/migrations/<file>.sql`) and the object you checked to confirm it applied. If
the checksum of an already-applied file in this table ever changes, that is drift — the live
schema no longer matches history, and it needs manual reconciliation, not a silent edit here.

| Migration file | SHA-256 | Applied | Confirmed by |
|---|---|---|---|
| 202609130001_auth_and_stores.sql | `db4c8a7d59a81ae6d887118f902f2255314e5bea846c522f433e82a77199290d` | yes | `public.stores` table exists |
| 202609150001_catalog_checkout_sync.sql | `6c2a609b648955c1a34892ffa266835baa58fb7ad3a75d7836ecc50cdc56e8d0` | yes | `public.pos_products` table exists |
| 202609150001_terminal_employee_access.sql | `039181c9c21ba546c3410ffc9da32d6760fadb2ba32d0b0a76214483f242edb2` | yes | `public.terminal_employees` table exists |
| 202609150002_terminal_device_sessions.sql | `0bf3498345debca810a195fee6229920dfe03ef5f1c874b6da352a7ebcd37dba` | yes | `public.terminal_device_sessions` table exists |
| 202609150003_team_profile_visibility.sql | `50b3d69b746ddd310bfa72eb2000371c87dc2a2ac2c8ef9a48a0c1871c953610` | yes | policy `store members can read teammate profiles` on `profiles` exists |
| 202609160001_customers_and_sale_attachment.sql | `9a0cdd6e7f2fc7cec5ec33ffda3d1bb380c203a49fe94ad1e5b3e9a88c5fad5b` | yes | `public.pos_customers` table exists |
| 202609170001_change_feed_product_entity.sql | `e6d4ee60379ca5eb15979790ddfc0fcd8bbf639f1c86e251e5f64a7f4b7a9600` | yes | `pos_change_feed.entity_type` column exists |
| 202609170002_cart_discounts.sql | `0d805e363807319826eded555bce0cb9ace1d02dffd4e70d29fd8dd7f7cf8b40` | yes | `pos_orders.discount_cents` column exists |
| 202609180001_terminal_name_uniqueness.sql | `98933a75e5053cc2bb7102ca4ff593b9f02d7c4fdd98a63c0d2467cf16d3f1d3` | yes | index `terminal_devices_store_name_active_idx` exists |
| 202609180002_pos_orders_report_read_access.sql | `00cb3ec9ecdf3406784d31f256cd4aaff8582b014fcd47e7ae2e73b2d08f9adc` | yes | `pos_orders.employee_id` column exists |
| 202609190001_audit_log.sql | `b3c51d6401fb2190399fb02f06554de77631867b927afc2b9abacea2f189b836` | yes | `public.audit_log` table exists |
| 202609190001_store_onboarding_status.sql | `95c85c7a40a52cbcab6279b7e976fe56511750aa6ddbd9cb53b226e4613d9422` | yes | function `complete_store_onboarding` exists |
| 202609190002_remove_demo_catalog_seed.sql | `3a53091f607da9d43874458a7cd3e9f01ae78f1b7c372b536dd3ee3961d18443` | yes | function `pos_seed_new_store` is absent (dropped) |
| 202609190003_store_sync_feed_init.sql | `8039268781ce168ec2887fd409ea620291565e30e8248b10eac52b9b76e916e2` | yes | function `pos_init_store_sync_state` exists |
| 202609200001_service_role_only_rls_policies.sql | `c5d91c60277e769cfd13c295a781ab5a0302082967d696bafd4bb7839d5731b1` | yes | policy `pos_change_feed_service_role_only` exists |
| 202609230001_kitchen_display_system.sql | `bb9c97448b609f9de0c0443c30aaaca4d1e839d5de613dbc1428ab9ae58b1f55` | yes | `public.kitchen_tickets` table exists |

No pending or applied-but-missing-from-repo migrations were found among the files verified above.
Note: `202609210001_restaurant_foundation.sql` (Day 1) predates this row and was applied outside
this ledger's original 2026-09-19 pass; it is not yet checked by `verify-migrations.mjs` — a
pre-existing gap, not introduced here, left for whoever owns that migration to add.
