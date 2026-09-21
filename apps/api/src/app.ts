import express from 'express'
import { catalogRouter, terminalCatalogRouter } from './routes/catalog.js'
import { ordersRouter, terminalOrdersRouter } from './routes/orders.js'
import { customersRouter, terminalCustomersRouter } from './routes/customers.js'
import { storesRouter } from './routes/stores.js'
import { reportsRouter } from './routes/reports.js'
import { auditRouter } from './routes/audit.js'
import { terminalAuthRouter, type TerminalAuthOptions } from './terminal-auth/routes.js'

export function createApp(options: TerminalAuthOptions) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '64kb' }))
  app.get('/health', (_req, res) => { res.json({ status: 'ok', ts: new Date().toISOString() }) })
  app.use(terminalAuthRouter(options))
  app.use('/catalog', catalogRouter)
  app.use('/orders', ordersRouter)
  app.use('/customers', customersRouter)
  app.use('/stores', storesRouter)
  app.use('/reports', reportsRouter)
  app.use(auditRouter)
  app.use('/pos/catalog', terminalCatalogRouter)
  app.use('/pos/orders', terminalOrdersRouter)
  app.use('/pos/customers', terminalCustomersRouter)
  return app
}
