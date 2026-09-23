import { Client } from 'pg'
import 'dotenv/config'

const checks = [
  { file: '202609130001_auth_and_stores.sql', sql: `select 1 from information_schema.tables where table_schema='public' and table_name='stores'` },
  { file: '202609150001_catalog_checkout_sync.sql', sql: `select 1 from information_schema.tables where table_schema='public' and table_name='pos_products'` },
  { file: '202609150001_terminal_employee_access.sql', sql: `select 1 from information_schema.tables where table_schema='public' and table_name='terminal_employees'` },
  { file: '202609150002_terminal_device_sessions.sql', sql: `select 1 from information_schema.tables where table_schema='public' and table_name='terminal_device_sessions'` },
  { file: '202609150003_team_profile_visibility.sql', sql: `select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='store members can read teammate profiles'` },
  { file: '202609160001_customers_and_sale_attachment.sql', sql: `select 1 from information_schema.tables where table_schema='public' and table_name='pos_customers'` },
  { file: '202609170001_change_feed_product_entity.sql', sql: `select 1 from information_schema.columns where table_schema='public' and table_name='pos_change_feed' and column_name='entity_type'` },
  { file: '202609170002_cart_discounts.sql', sql: `select 1 from information_schema.columns where table_schema='public' and table_name='pos_orders' and column_name='discount_cents'` },
  { file: '202609180001_terminal_name_uniqueness.sql', sql: `select 1 from pg_indexes where schemaname='public' and indexname='terminal_devices_store_name_active_idx'` },
  { file: '202609180002_pos_orders_report_read_access.sql', sql: `select 1 from information_schema.columns where table_schema='public' and table_name='pos_orders' and column_name='employee_id'` },
  { file: '202609190001_audit_log.sql', sql: `select 1 from information_schema.tables where table_schema='public' and table_name='audit_log'` },
  { file: '202609190001_store_onboarding_status.sql', sql: `select 1 from pg_proc where proname='complete_store_onboarding'` },
  { file: '202609190002_remove_demo_catalog_seed.sql', sql: `select 1 from pg_proc where proname='pos_seed_new_store'` }, // expect NO row (function was dropped)
  { file: '202609190003_store_sync_feed_init.sql', sql: `select 1 from pg_proc where proname='pos_init_store_sync_state'` },
  { file: '202609200001_service_role_only_rls_policies.sql', sql: `select 1 from pg_policies where schemaname='public' and tablename='pos_change_feed' and policyname='pos_change_feed_service_role_only'` },
  { file: '202609230001_kitchen_display_system.sql', sql: `select 1 from information_schema.tables where table_schema='public' and table_name='kitchen_tickets'` },
]

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  for (const check of checks) {
    const { rows } = await client.query(check.sql)
    const dropCheck = check.file.includes('remove_demo_catalog_seed')
    const ok = dropCheck ? rows.length === 0 : rows.length > 0
    console.log(`${ok ? 'CONFIRMED' : 'MISMATCH '} ${check.file}`)
  }
} finally {
  await client.end()
}
