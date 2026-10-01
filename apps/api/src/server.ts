import { createApp } from './app.js'
import { db } from './db.js'
import { installQrSecurityHooks } from './routes/qr-security-integration.js'

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
// Must run before the app starts accepting traffic: qr-ordering.ts's public routes are fail-closed
// behind QR_ORDERING_ENABLED, but the moment that flag is ever set true, these hooks are what give
// the public surface real rate limiting and staff-role enforcement instead of qr-security-hooks.ts's
// allow-all defaults.
installQrSecurityHooks(db)
createApp({ pool: db, origin: required('WEB_ORIGIN'), supabaseUrl: required('SUPABASE_URL'), supabaseKey: required('SUPABASE_PUBLISHABLE_KEY'), secureCookies: process.env.NODE_ENV !== 'development' })
  .listen(Number(process.env.PORT ?? 3001), '127.0.0.1')
