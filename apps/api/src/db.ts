import pg from 'pg'
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is required. ' +
    'Copy apps/api/.env.example to apps/api/.env.local and fill in your values.',
  )
}

/**
 * Singleton pg.Pool connected to the Supabase (or local Postgres) database.
 * Used exclusively in server-side API routes — never exported to browser code.
 */
const databaseUrl = new URL(process.env.DATABASE_URL)
if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
  throw new Error('DATABASE_URL must use the postgres or postgresql scheme.')
}
const caPath = process.env.SUPABASE_DB_CA_CERT_PATH
const ssl = caPath
  ? { ca: readFileSync(resolve(caPath), 'utf8'), servername: databaseUrl.hostname, rejectUnauthorized: true }
  : undefined

if (databaseUrl.hostname.endsWith('.pooler.supabase.com') && !ssl) {
  throw new Error('SUPABASE_DB_CA_CERT_PATH is required for a verified Supabase pooler connection.')
}

export const db = new Pool({
  host: databaseUrl.hostname,
  port: Number(databaseUrl.port || 5432),
  database: decodeURIComponent(databaseUrl.pathname.slice(1)),
  user: decodeURIComponent(databaseUrl.username),
  password: decodeURIComponent(databaseUrl.password),
  ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

db.on('error', (err) => {
  console.error('[db] unexpected pool error', err)
})
