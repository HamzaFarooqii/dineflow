/**
 * apps/web/src/lib/db.ts
 *
 * Dexie v4 local database for Dineflow.
 * All monetary fields are integer cents — never float.
 *
 * Schema version 1 is the initial schema for this branch.
 * Add new versions in separate upgrade() calls; never mutate existing ones.
 */
import Dexie, { type EntityTable, type Table } from 'dexie'

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface StoreConfig {
  id: string           // always 'local' (singleton)
  store_id: string
  name: string
  timezone: string
  currency: string
  catalog_version: number
}

export interface LocalCategory {
  id: string
  store_id: string
  name: string
  parent_id: string | null
  active: boolean
}

export interface LocalTaxRate {
  id: string
  store_id: string
  name: string
  rate_bps: number
  active: boolean
}

export interface LocalProduct {
  id: string
  store_id: string
  sku: string
  barcode: string | null
  name: string
  category_id: string | null
  tax_rate_id: string | null
  unit_price_cents: number   // integer cents
  active: boolean
  revision: number
  image_url?: string | null  // optional; absent on older records means no image — show a placeholder
}

export interface LocalStock {
  product_id: string          // primary key
  current_stock: number
  updated_at: string
}

export type SyncStatus = 'pending' | 'synced' | 'failed'

export interface LocalOrder {
  id: string
  store_id: string
  receipt_number: string
  subtotal_cents: number      // integer cents
  discount_cents?: number     // integer cents; absent on older records means zero
  tax_cents: number           // integer cents
  total_cents: number         // integer cents
  catalog_version: number
  client_generated_at: string // ISO 8601
  sync_status: SyncStatus
  currency: string
  store_name_snapshot: string
  timezone_snapshot: string
  accepted_checkpoint: string | null
  failure_reason: string | null
  customer_id?: string | null
  employee_id?: string | null         // cashier who rang up the sale, when checked out on a terminal
  manager_id?: string | null          // approving manager's employee id, when any line needed approval
  manager_approved_at?: string | null // ISO 8601, when any line needed approval
  refunded_at?: string | null         // ISO 8601; set locally right after POST /orders/:id/refund succeeds
  refunded_amount_cents?: number | null // integer cents; the whole-order amount reversed
}

export interface LocalCustomer {
  id: string
  store_id: string
  name: string
  phone_normalized: string | null
  client_generated_at: string
  creating_operation_id: string | null
  sync_status: SyncStatus
  failure_reason: string | null
}

export interface LocalOrderItem {
  id: string
  order_id: string
  product_id: string
  snapshot_name: string
  snapshot_sku: string
  snapshot_price_cents: number  // integer cents
  snapshot_tax_bps: number
  catalog_version: number
  quantity: number
  subtotal_cents: number        // integer cents
  discount_kind?: 'percent' | 'fixed' | null
  discount_value?: number | null       // bps for percent, integer cents for fixed
  discount_applied_cents?: number      // integer cents; absent on older records means zero
  taxable_cents?: number        // integer cents; subtotal_cents minus discount_applied_cents
  tax_cents: number             // integer cents
  total_cents: number           // integer cents
}

export type PaymentMethod = 'cash' | 'card'

export interface LocalPayment {
  id: string
  order_id: string
  method: PaymentMethod
  amount_cents: number      // integer cents
  tendered_cents: number    // integer cents
  change_cents: number      // integer cents
  reference: string | null
}

export type OutboxStatus = 'pending' | 'synced' | 'failed'

export interface OutboxEntry {
  id?: number              // auto-increment PK
  store_id: string
  operation_id: string     // UUID, unique per operation
  order_id: string
  status: OutboxStatus
  failure_reason: string | null
  failure_kind: 'connectivity' | 'authentication' | 'dependency' | 'validation' | null
  reason_code: string | null
  attempt_count: number
  lease_owner: string | null
  lease_expires_at: string | null
  accepted_checkpoint: string | null
  next_attempt_at: string  // ISO 8601
  created_at: string       // ISO 8601
  payload: string          // JSON string of OrderOperation
  entity_type?: 'order' | 'customer'
  depends_on?: string[]
}

export interface SyncMetadata {
  key: string              // e.g. 'last_pull_checkpoint', 'last_receipt_seq', 'catalog_version'
  value: string
}

export interface LocalStockAdjustment {
  operation_id: string
  product_id: string
  delta: number
  accepted_checkpoint: string | null
}

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

export class DineflowDatabase extends Dexie {
  store_config!: EntityTable<StoreConfig, 'id'>
  categories!: EntityTable<LocalCategory, 'id'>
  tax_rates!: EntityTable<LocalTaxRate, 'id'>
  products!: EntityTable<LocalProduct, 'id'>
  server_stock!: EntityTable<LocalStock, 'product_id'>
  orders!: EntityTable<LocalOrder, 'id'>
  customers!: EntityTable<LocalCustomer, 'id'>
  order_items!: EntityTable<LocalOrderItem, 'id'>
  payments!: EntityTable<LocalPayment, 'id'>
  outbox!: EntityTable<OutboxEntry, 'id'>
  sync_metadata!: EntityTable<SyncMetadata, 'key'>
  stock_adjustments!: Table<LocalStockAdjustment, [string, string]>

  constructor() {
    super('dineflow')

    this.version(1).stores({
      // Key path first, then indexed fields
      store_config:  'id',
      categories:    'id, store_id, active',
      tax_rates:     'id, store_id, active',
      products:      'id, &sku, barcode, category_id, active, store_id',
      server_stock:  'product_id',
      orders:        'id, &receipt_number, client_generated_at, sync_status',
      order_items:   'id, order_id, product_id',
      payments:      'id, &order_id',
      outbox:        '++id, &operation_id, status, next_attempt_at',
      sync_metadata: 'key',
      stock_adjustments: '[operation_id+product_id], product_id, operation_id',
    })

    // Keep SKU uniqueness within a store so two store catalogs may reuse the same SKU.
    this.version(2).stores({
      products: 'id, &[store_id+sku], [store_id+barcode], [store_id+category_id], active, store_id',
    })

    this.version(3).stores({
      orders: 'id, &receipt_number, client_generated_at, sync_status, store_id, [store_id+client_generated_at]',
      outbox: '++id, &operation_id, status, next_attempt_at, store_id',
    }).upgrade(async transaction => {
      const outbox = transaction.table<OutboxEntry, number>('outbox')
      const orders = transaction.table<LocalOrder, string>('orders')
      for (const entry of await outbox.toArray()) {
        const order = await orders.get(entry.order_id)
        await outbox.update(entry.id!, { store_id: order?.store_id ?? '' })
      }
    })

    this.version(4).stores({
      customers: 'id, store_id, [store_id+phone_normalized], creating_operation_id, sync_status',
      outbox: '++id, &operation_id, status, next_attempt_at, store_id, entity_type',
      orders: 'id, &receipt_number, client_generated_at, sync_status, store_id, [store_id+client_generated_at], customer_id',
    }).upgrade(async transaction => {
      const outbox = transaction.table<OutboxEntry, number>('outbox')
      for (const entry of await outbox.toArray()) {
        await outbox.update(entry.id!, { entity_type: 'order', depends_on: [] })
      }
    })

    // No new indexes: discount and manager-approval fields are read with `?? 0` / `?? null` defaults,
    // but backfill existing rows so every record carries an explicit value.
    this.version(5).stores({}).upgrade(async transaction => {
      const orders = transaction.table<LocalOrder, string>('orders')
      for (const order of await orders.toArray()) {
        await orders.update(order.id, { discount_cents: order.discount_cents ?? 0, manager_id: order.manager_id ?? null, manager_approved_at: order.manager_approved_at ?? null })
      }
      const orderItems = transaction.table<LocalOrderItem, string>('order_items')
      for (const item of await orderItems.toArray()) {
        await orderItems.update(item.id, { discount_kind: item.discount_kind ?? null, discount_value: item.discount_value ?? null,
          discount_applied_cents: item.discount_applied_cents ?? 0, taxable_cents: item.taxable_cents ?? item.subtotal_cents })
      }
    })
  }
}

/** Singleton database instance — import this everywhere in the app. */
export const posDb = new DineflowDatabase()
