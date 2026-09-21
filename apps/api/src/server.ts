import { createApp } from './app.js'
import { db } from './db.js'

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
createApp({ pool: db, origin: required('WEB_ORIGIN'), supabaseUrl: required('SUPABASE_URL'), supabaseKey: required('SUPABASE_PUBLISHABLE_KEY'), secureCookies: process.env.NODE_ENV !== 'development' })
  .listen(Number(process.env.PORT ?? 3001), '127.0.0.1')
