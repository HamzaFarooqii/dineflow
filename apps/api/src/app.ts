import express from 'express'
import { catalogRouter, terminalCatalogRouter } from './routes/catalog.js'
import { ordersRouter, terminalOrdersRouter } from './routes/orders.js'
import { customersRouter, terminalCustomersRouter } from './routes/customers.js'
import { storesRouter } from './routes/stores.js'
import { reportsRouter } from './routes/reports.js'
import { auditRouter } from './routes/audit.js'
import { floorRouter, terminalFloorRouter } from './routes/floor.js'
import { kitchenRouter, terminalKitchenRouter } from './routes/kitchen.js'
import { inventoryRouter, terminalInventoryRouter } from './routes/inventory.js'
import { promotionsRouter } from './routes/promotions.js'
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
  app.use('/floor', floorRouter)
  app.use('/kitchen', kitchenRouter)
  app.use('/inventory', inventoryRouter)
  app.use('/promotions', promotionsRouter)
  app.use(auditRouter)
  app.use('/pos/catalog', terminalCatalogRouter)
  app.use('/pos/orders', terminalOrdersRouter)
  app.use('/pos/customers', terminalCustomersRouter)
  app.use('/pos/floor', terminalFloorRouter)
  app.use('/pos/kitchen', terminalKitchenRouter)
  app.use('/pos/inventory', terminalInventoryRouter)
  return app
}
