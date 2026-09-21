import { Router } from 'express'
import { db } from '../db.js'
import { requireStoreMember, requireStoreManager, sendApiError, ApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'

async function snapshot(req: import('express').Request, res: import('express').Response, terminal = false) {
  try {
    const storeId = String(req.query.store_id ?? '')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store ID is required.')
    if (terminal) {
      const session = await requireCashierTerminal(req, db)
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else await requireStoreMember(req, storeId)
    const client = await db.connect()
    try {
      await client.query('begin')
      const feed = await client.query('select last_position::text from public.pos_sync_feed_state where store_id=$1 for update', [storeId])
      if (!feed.rows[0]) throw new ApiError(503, 'server_unavailable', 'Store snapshot is not initialized.')
      const store = await client.query('select id,name,timezone,currency from public.stores where id = $1', [storeId])
      const categories = await client.query('select id,store_id,name,active from public.pos_categories where store_id = $1 order by name', [storeId])
      const taxRates = await client.query('select id,store_id,name,rate_bps,active from public.pos_tax_rates where store_id = $1', [storeId])
      const products = await client.query('select id,store_id,sku,barcode,name,category_id,tax_rate_id,unit_price_cents::text,active,revision::text,image_url from public.pos_products where store_id = $1 order by name', [storeId])
      const stock = await client.query('select product_id,current_stock,updated_at from public.pos_stock where store_id = $1', [storeId])
      await client.query('commit')
      res.json({ store: store.rows[0], catalog_version: 1, checkpoint: feed.rows[0].last_position,
        categories: categories.rows, tax_rates: taxRates.rows, products: products.rows, stock: stock.rows })
    } catch (reason) { await client.query('rollback'); throw reason }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
}

// ---------------------------------------------------------------------------
// POST /catalog/products — owner/manager creates a new product
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function createProduct(req: import('express').Request, res: import('express').Response) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = String(body.store_id ?? '')
    if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id UUID is required.')

    await requireStoreManager(req, storeId)

    // Validate name
    const name = String(body.name ?? '').trim()
    if (!name || name.length > 160) throw new ApiError(422, 'validation_failed', 'Product name is required and must be 1–160 characters.')

    // Validate SKU
    const sku = String(body.sku ?? '').trim()
    if (!sku || sku.length > 80) throw new ApiError(422, 'validation_failed', 'SKU is required and must be 1–80 characters.')

    // Validate barcode (optional, alphanumeric)
    const rawBarcode = body.barcode !== undefined && body.barcode !== null && String(body.barcode).trim() !== ''
      ? String(body.barcode).trim() : null
    if (rawBarcode !== null && (!/^[A-Za-z0-9]+$/.test(rawBarcode) || rawBarcode.length > 80)) {
      throw new ApiError(422, 'validation_failed', 'Barcode must be alphanumeric, 1–80 characters.')
    }

    // Validate optional image URL (the browser uploads directly to Supabase Storage and sends back
    // the resulting public URL — this never receives a file, just the string).
    const rawImageUrl = body.image_url !== undefined && body.image_url !== null && String(body.image_url).trim() !== ''
      ? String(body.image_url).trim() : null
    if (rawImageUrl !== null && (rawImageUrl.length > 2048 || !/^https?:\/\//i.test(rawImageUrl))) {
      throw new ApiError(422, 'validation_failed', 'image_url must be an http(s) URL of 2048 characters or fewer.')
    }

    // Validate optional FK references
    const categoryId = body.category_id && UUID_RE.test(String(body.category_id))
      ? String(body.category_id) : null
    const taxRateId = body.tax_rate_id && UUID_RE.test(String(body.tax_rate_id))
      ? String(body.tax_rate_id) : null

    // Optional: create new category by name within the same transaction
    const newCategoryName = body.new_category_name && typeof body.new_category_name === 'string'
      ? body.new_category_name.trim() : null
    if (newCategoryName && newCategoryName.length > 120) {
      throw new ApiError(422, 'validation_failed', 'Category name must be 1–120 characters.')
    }
    // categoryId and newCategoryName are mutually exclusive: new_category_name takes precedence
    const useExistingCategoryId = newCategoryName ? null : categoryId

    // Optional: create a new tax rate by name + rate within the same transaction. Stores no
    // longer get any tax rates at all on creation (202609190002_remove_demo_catalog_seed.sql
    // dropped the only insert into pos_tax_rates that ever existed, which used to happen as a
    // side effect of demo-catalog seeding) and there was no other way — UI or API — to create one,
    // so every store's tax rate dropdown was permanently stuck at "Tax exempt (0%)".
    const newTaxRateName = body.new_tax_rate_name && typeof body.new_tax_rate_name === 'string'
      ? body.new_tax_rate_name.trim() : null
    if (newTaxRateName && newTaxRateName.length > 80) {
      throw new ApiError(422, 'validation_failed', 'Tax rate name must be 1–80 characters.')
    }
    const newTaxRateBps = newTaxRateName ? body.new_tax_rate_rate_bps : undefined
    if (newTaxRateName && (!Number.isInteger(newTaxRateBps) || (newTaxRateBps as number) < 0 || (newTaxRateBps as number) > 10_000)) {
      throw new ApiError(422, 'validation_failed', 'new_tax_rate_rate_bps must be an integer between 0 and 10000.')
    }
    // taxRateId and newTaxRateName are mutually exclusive: new_tax_rate_name takes precedence
    const useExistingTaxRateId = newTaxRateName ? null : taxRateId

    // Validate price (integer cents)
    const rawPrice = body.unit_price_cents
    if (!Number.isInteger(rawPrice) || (rawPrice as number) < 0 || (rawPrice as number) > 1_000_000_000) {
      throw new ApiError(422, 'validation_failed', 'unit_price_cents must be a non-negative integer ≤ 1,000,000,000.')
    }
    const priceCents = rawPrice as number

    // Validate initial stock
    const rawStock = body.initial_stock !== undefined ? body.initial_stock : 0
    if (!Number.isInteger(rawStock) || (rawStock as number) < 0 || (rawStock as number) > 1_000_000) {
      throw new ApiError(422, 'validation_failed', 'initial_stock must be a non-negative integer.')
    }
    const initialStock = rawStock as number

    // Single pg transaction: product + stock + feed (doc 03 §3.5 serialized per-store feed)
    const client = await db.connect()
    try {
      await client.query('begin')

      // Lock feed state row first (serialises concurrent store writes)
      const feedRow = await client.query(
        'select last_position from public.pos_sync_feed_state where store_id=$1 for update',
        [storeId],
      )
      if (!feedRow.rows[0]) throw new ApiError(503, 'server_unavailable', 'Store is not initialized. Apply catalog migration.')

      const nextPos = (BigInt(feedRow.rows[0].last_position as string | number) + 1n).toString()

      // Create new category if requested (inside transaction)
      let resolvedCategoryId: string | null = useExistingCategoryId
      let createdCategory: { id: string; store_id: string; name: string; active: boolean } | null = null
      if (newCategoryName) {
        const catRes = await client.query(
          `insert into public.pos_categories (store_id, name, active)
           values ($1,$2,true)
           on conflict (store_id, name) do update set active = true
           returning id, store_id, name, active`,
          [storeId, newCategoryName],
        )
        resolvedCategoryId = catRes.rows[0].id as string
        createdCategory = catRes.rows[0] as { id: string; store_id: string; name: string; active: boolean }
      } else if (useExistingCategoryId) {
        // Verify existing category belongs to this store
        const chk = await client.query(
          'select 1 from public.pos_categories where store_id=$1 and id=$2',
          [storeId, useExistingCategoryId],
        )
        if (!chk.rowCount) throw new ApiError(422, 'validation_failed', 'Category does not belong to this store.')
      }

      // Create new tax rate if requested (inside transaction)
      let resolvedTaxRateId: string | null = useExistingTaxRateId
      let createdTaxRate: { id: string; store_id: string; name: string; rate_bps: number; active: boolean } | null = null
      if (newTaxRateName) {
        // Unlike pos_categories, pos_tax_rates has no unique(store_id, name) constraint to upsert
        // against, so a retried/double-clicked submit would otherwise silently create a second
        // identically-named rate — look for an existing active one with this exact name first.
        const existingRate = await client.query(
          'select id, store_id, name, rate_bps, active from public.pos_tax_rates where store_id=$1 and name=$2 and active=true',
          [storeId, newTaxRateName],
        )
        const taxRes = existingRate.rows[0] ? existingRate : await client.query(
          `insert into public.pos_tax_rates (store_id, name, rate_bps, active)
           values ($1,$2,$3,true)
           returning id, store_id, name, rate_bps, active`,
          [storeId, newTaxRateName, newTaxRateBps],
        )
        resolvedTaxRateId = taxRes.rows[0].id as string
        createdTaxRate = taxRes.rows[0] as { id: string; store_id: string; name: string; rate_bps: number; active: boolean }
      } else if (useExistingTaxRateId) {
        // Verify existing tax rate belongs to this store
        const chk = await client.query(
          'select 1 from public.pos_tax_rates where store_id=$1 and id=$2',
          [storeId, useExistingTaxRateId],
        )
        if (!chk.rowCount) throw new ApiError(422, 'validation_failed', 'Tax rate does not belong to this store.')
      }

      // Reject a duplicate SKU up front with a clear message (the unique constraint below is
      // the authoritative guard for the race case, caught right after the insert).
      const skuChk = await client.query(
        'select 1 from public.pos_products where store_id=$1 and sku=$2',
        [storeId, sku],
      )
      if (skuChk.rowCount) throw new ApiError(409, 'sku_conflict', 'A product with this SKU already exists in this store.')

      // Insert product
      let productRes
      try {
        productRes = await client.query(
          `insert into public.pos_products
            (store_id, sku, barcode, name, category_id, tax_rate_id, unit_price_cents, active, revision, image_url)
           values ($1,$2,$3,$4,$5,$6,$7,true,1,$8)
           returning id, store_id, sku, barcode, name, category_id, tax_rate_id,
                     unit_price_cents::text as unit_price_cents, active, revision::text as revision, image_url`,
          [storeId, sku, rawBarcode, name, resolvedCategoryId, resolvedTaxRateId, priceCents, rawImageUrl],
        )
      } catch (insertReason) {
        if (typeof insertReason === 'object' && insertReason !== null && 'code' in insertReason && (insertReason as { code: string }).code === '23505') {
          throw new ApiError(409, 'sku_conflict', 'A product with this SKU already exists in this store.')
        }
        throw insertReason
      }
      const row = productRes.rows[0] as {
        id: string; store_id: string; sku: string; barcode: string | null
        name: string; category_id: string | null; tax_rate_id: string | null
        unit_price_cents: string; active: boolean; revision: string; image_url: string | null
      }

      // Insert stock
      await client.query(
        'insert into public.pos_stock (store_id, product_id, current_stock, updated_at) values ($1,$2,$3,now())',
        [storeId, row.id, initialStock],
      )

      // Insert opening_stock movement (only when stock > 0)
      if (initialStock > 0) {
        await client.query(
          `insert into public.pos_inventory_movements (store_id, product_id, operation_id, delta, reason)
           values ($1,$2,gen_random_uuid(),$3,'opening_stock')`,
          [storeId, row.id, initialStock],
        )
      }

      // Advance feed position
      await client.query(
        'update public.pos_sync_feed_state set last_position=$1 where store_id=$2',
        [nextPos, storeId],
      )

      // Write change_feed entry so terminals get it on next pull
      const feedPayload = JSON.stringify({
        product: { id: row.id, store_id: row.store_id, sku: row.sku, barcode: row.barcode,
          name: row.name, category_id: row.category_id, tax_rate_id: row.tax_rate_id,
          unit_price_cents: priceCents, active: true, revision: 1, image_url: row.image_url },
        stock: { product_id: row.id, current_stock: initialStock },
      })
      await client.query(
        `insert into public.pos_change_feed (store_id, position, entity_type, entity_id, action, payload)
         values ($1,$2,'product',$3,'upsert',$4::jsonb)`,
        [storeId, nextPos, row.id, feedPayload],
      )

      await client.query('commit')

      res.status(201).json({
        product: { id: row.id, store_id: row.store_id, sku: row.sku, barcode: row.barcode,
          name: row.name, category_id: row.category_id, tax_rate_id: row.tax_rate_id,
          unit_price_cents: priceCents, active: row.active, revision: 1, image_url: row.image_url },
        stock: { product_id: row.id, current_stock: initialStock },
        ...(createdCategory ? { category: createdCategory } : {}),
        ...(createdTaxRate ? { taxRate: createdTaxRate } : {}),
        checkpoint: nextPos,
      })
    } catch (reason) {
      await client.query('rollback')
      throw reason
    } finally {
      client.release()
    }
  } catch (reason) {
    sendApiError(res, reason)
  }
}

export const catalogRouter = Router()
export const terminalCatalogRouter = Router()
catalogRouter.get('/snapshot', (req, res) => void snapshot(req, res))
catalogRouter.post('/products', (req, res) => void createProduct(req, res))
terminalCatalogRouter.get('/snapshot', (req, res) => void snapshot(req, res, true))
