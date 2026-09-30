import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const client = readFileSync(new URL('../src/lib/qr-ordering.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../src/screens/qr/CustomerOrderScreen.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('customer requests never carry staff credentials or client-chosen store/table ids', () => {
  const customer = client.slice(client.indexOf('async function customerRequest'), client.indexOf('export const openQrSession'))
  assert.match(customer, /credentials: 'omit'/)
  assert.doesNotMatch(customer, /accessToken\(/)
  assert.doesNotMatch(client.slice(client.indexOf('export const submitQrOrder'), client.indexOf('export interface QrTableState')), /store_id|table_id|price|discount/)
})

test('customer page never claims food is being prepared', () => {
  assert.doesNotMatch(page, /preparing|being made|in the kitchen|cooking/i)
})

test('customer page is a public route outside ProtectedRoute', () => {
  const route = app.match(/<Route path="\/order\/:code".*?<\/Suspense>\} \/>/)?.[0] ?? ''
  assert.ok(route.includes('CustomerOrderScreen'))
  assert.ok(!route.includes('ProtectedRoute') && !route.includes('CashierTerminalRoute'))
})

test('staff QR requests keep store_id in the query only', () => {
  const staff = client.slice(client.indexOf('async function staffRequest'), client.indexOf('export const fetchQrTables'))
  assert.match(staff, /query\.set\('store_id', storeId\)/)
  assert.match(staff, /body: body === undefined \? undefined : JSON\.stringify\(body\)/)
})
