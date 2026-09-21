import { Client } from 'pg'
import dotenv from 'dotenv'

dotenv.config()
dotenv.config({ path: '.env.local', override: true })

const email = 'bismamunir474+qatest@gmail.com'
const password = process.env.QA_TEST_PASSWORD ?? crypto.randomUUID()
const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceRoleKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (apps/api/.env.local).')
  process.exit(1)
}

async function main() {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const body = await response.json()
  if (!response.ok) {
    if (body.msg?.includes('already been registered') || body.code === 'email_exists') {
      console.log('Test user already exists, looking it up instead.')
      const list = await fetch(`${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      }).then(r => r.json())
      const existing = list.users?.[0]
      if (!existing) { console.error('Could not find existing user:', JSON.stringify(list)); process.exit(1) }
      await ensureStoreMembership(existing.id)
      console.log('Test user id:', existing.id)
      return
    }
    console.error('Failed to create user:', JSON.stringify(body))
    process.exit(1)
  }
  console.log('Created test user id:', body.id)
  await ensureStoreMembership(body.id)
  console.log('Password (save this, not printed again):', password)
}

async function ensureStoreMembership(userId) {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    const existingStore = await client.query(
      `select store_id from public.store_memberships where user_id=$1 and active=true limit 1`, [userId])
    if (existingStore.rows[0]) {
      console.log('User already has an active store membership:', existingStore.rows[0].store_id)
      return
    }
    await client.query('begin')
    const store = await client.query(
      `insert into public.stores(name, code, timezone, currency, created_by)
       values ('QA Test Store', 'qa-test-store', 'UTC', 'USD', $1)
       returning id`, [userId])
    const storeId = store.rows[0].id
    await client.query(
      `insert into public.profiles(id, full_name) values ($1, 'QA Test User')
       on conflict (id) do nothing`, [userId])
    await client.query(
      `insert into public.store_memberships(store_id, user_id, role, active)
       values ($1, $2, 'owner', true)`, [storeId, userId])
    await client.query('commit')
    console.log('Created store + membership:', storeId)
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    await client.end()
  }
}

await main()
