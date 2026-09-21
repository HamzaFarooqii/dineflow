import { readFileSync } from 'node:fs'
import { Client } from 'pg'
import 'dotenv/config'

const migrationPath = process.argv[2]
if (!migrationPath) {
  console.error('Usage: node scripts/apply-migration.mjs <path-to-migration.sql>')
  process.exit(1)
}

const sql = readFileSync(migrationPath, 'utf8')
const client = new Client({ connectionString: process.env.DATABASE_URL })

await client.connect()
try {
  await client.query('begin')
  await client.query(sql)
  await client.query('commit')
  console.log('Migration applied successfully.')
} catch (err) {
  await client.query('rollback')
  console.error('Migration failed, rolled back:', err.message)
  process.exit(1)
} finally {
  await client.end()
}
