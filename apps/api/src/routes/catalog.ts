import { Router } from 'express'
import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { requireStoreMember, requireStoreManager, sendApiError, ApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'
import { convertQuantity, type RecipeCostUnit } from '../../../../packages/domain/src/recipe-cost.js'

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
      const store = await client.query('select id,name,timezone,currency,service_charge_bps from public.stores where id = $1', [storeId])
      const categories = await client.query('select id,store_id,name,active from public.pos_categories where store_id = $1 order by name', [storeId])
      const taxRates = await client.query('select id,store_id,name,rate_bps,active from public.pos_tax_rates where store_id = $1', [storeId])
      const products = await client.query('select id,store_id,sku,barcode,name,category_id,tax_rate_id,unit_price_cents::text,active,revision::text,image_url,' +
        'station_id,prep_time_seconds,course,kitchen_name,is_available,unavailable_until,sells_directly from public.pos_products where store_id = $1 order by name', [storeId])
      const modifiers = await client.query(
        `select pmg.product_id, mg.id, mg.name, mg.selection, mg.required, pmg.sort_order,
                mo.id as option_id, mo.name as option_name, mo.price_delta_cents, mo.active
         from public.product_modifier_groups pmg
         join public.modifier_groups mg on mg.store_id=pmg.store_id and mg.id=pmg.group_id
         left join public.modifier_options mo on mo.store_id=mg.store_id and mo.group_id=mg.id
         where pmg.store_id=$1 order by pmg.product_id, pmg.sort_order, mg.name, mo.name`,
        [storeId],
      )
      const stock = await client.query('select product_id,current_stock,updated_at from public.pos_stock where store_id = $1', [storeId])
      await client.query('commit')
      res.json({ store: store.rows[0], catalog_version: 1, checkpoint: feed.rows[0].last_position,
        categories: categories.rows, tax_rates: taxRates.rows, products: products.rows, stock: stock.rows,
        modifier_groups: shapeModifierGroups(modifiers.rows) })
    } catch (reason) { await client.query('rollback'); throw reason }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
}

// ---------------------------------------------------------------------------
// POST /catalog/products — owner/manager creates a new product
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type ModifierGroupView = { id: string; product_id: string; name: string; selection: 'single' | 'multi'; required: boolean; sort_order: number; options: { id: string; name: string; price_delta_cents: number; active: boolean }[] }

function shapeModifierGroups(rows: Record<string, unknown>[]): ModifierGroupView[] {
  const groups = new Map<string, ModifierGroupView>()
  for (const row of rows) {
    const groupId = String(row.id)
    let group = groups.get(groupId)
    if (!group) {
      group = { id: groupId, product_id: String(row.product_id), name: String(row.name), selection: row.selection as 'single' | 'multi',
        required: Boolean(row.required), sort_order: Number(row.sort_order), options: [] }
      groups.set(groupId, group)
    }
    if (row.option_id) group.options.push({ id: String(row.option_id), name: String(row.option_name),
      price_delta_cents: Number(row.price_delta_cents), active: Boolean(row.active) })
  }
  return [...groups.values()]
}

function modifierText(value: unknown, label: string): string {
  const result = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (!result || result.length > 60) throw new ApiError(422, 'validation_failed', `${label} must be 1–60 characters.`)
  return result
}

export function parseModifierGroups(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 20) throw new ApiError(422, 'validation_failed', 'Modifier groups must be an array with at most 20 groups.')
  return raw.map((value, groupIndex) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'validation_failed', `Modifier group ${groupIndex + 1} is invalid.`)
    const group = value as Record<string, unknown>
    if (group.selection !== 'single' && group.selection !== 'multi') throw new ApiError(422, 'validation_failed', `Modifier group ${groupIndex + 1} selection is invalid.`)
    if (typeof group.required !== 'boolean') throw new ApiError(422, 'validation_failed', `Modifier group ${groupIndex + 1} required is invalid.`)
    if (!Array.isArray(group.options) || group.options.length < 1 || group.options.length > 50) throw new ApiError(422, 'validation_failed', `Modifier group ${groupIndex + 1} needs 1 to 50 options.`)
    const options = group.options.map((value, optionIndex) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'validation_failed', `Modifier option ${optionIndex + 1} is invalid.`)
      const option = value as Record<string, unknown>
      if (!Number.isSafeInteger(option.price_delta_cents) || (option.price_delta_cents as number) < -1_000_000_000 || (option.price_delta_cents as number) > 1_000_000_000) {
        throw new ApiError(422, 'validation_failed', `Modifier option ${optionIndex + 1} price is invalid.`)
      }
      return { name: modifierText(option.name, 'Modifier option name'), price_delta_cents: option.price_delta_cents as number,
        active: option.active === undefined ? true : Boolean(option.active) }
    })
    if (new Set(options.map(option => option.name.toLocaleLowerCase())).size !== options.length) throw new ApiError(422, 'validation_failed', `Modifier group ${groupIndex + 1} has duplicate option names.`)
    return { name: modifierText(group.name, 'Modifier group name'), selection: group.selection as 'single' | 'multi', required: group.required, options }
  })
}

async function replaceProductModifiers(req: import('express').Request, res: import('express').Response) {
  try {
    const storeId = String((req.body as Record<string, unknown>)?.store_id ?? '')
    const productId = String(req.params.productId ?? '')
    if (!UUID_RE.test(storeId) || !UUID_RE.test(productId)) throw new ApiError(400, 'validation_failed', 'Valid store and product IDs are required.')
    await requireStoreManager(req, storeId)
    const groups = parseModifierGroups((req.body as Record<string, unknown>)?.groups)
    const client = await db.connect()
    try {
      await client.query('begin')
      const product = await client.query('select 1 from public.pos_products where store_id=$1 and id=$2 for update', [storeId, productId])
      if (!product.rowCount) throw new ApiError(404, 'not_found', 'Menu item not found.')
      const existing = await client.query<{ group_id: string }>('delete from public.product_modifier_groups where store_id=$1 and product_id=$2 returning group_id', [storeId, productId])
      for (const row of existing.rows) await client.query('delete from public.modifier_groups where store_id=$1 and id=$2 and not exists (select 1 from public.product_modifier_groups where store_id=$1 and group_id=$2)', [storeId, row.group_id])
      const saved: ModifierGroupView[] = []
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index]
        const insertedGroup = await client.query<{ id: string }>(
          'insert into public.modifier_groups(store_id,name,selection,required) values ($1,$2,$3,$4) returning id',
          [storeId, group.name, group.selection, group.required],
        )
        const groupId = insertedGroup.rows[0].id
        await client.query('insert into public.product_modifier_groups(store_id,product_id,group_id,sort_order) values ($1,$2,$3,$4)', [storeId, productId, groupId, index])
        const options: ModifierGroupView['options'] = []
        for (const option of group.options) {
          const inserted = await client.query<{ id: string; name: string; price_delta_cents: number; active: boolean }>(
            'insert into public.modifier_options(store_id,group_id,name,price_delta_cents,active) values ($1,$2,$3,$4,$5) returning id,name,price_delta_cents,active',
            [storeId, groupId, option.name, option.price_delta_cents, option.active],
          )
          options.push(inserted.rows[0])
        }
        saved.push({ id: groupId, product_id: productId, name: group.name, selection: group.selection, required: group.required, sort_order: index, options })
      }
      await client.query('commit')
      res.json({ groups: saved })
    } catch (reason) { await client.query('rollback'); throw reason }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
}

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

type ProductMutationRow = {
  id: string
  store_id: string
  sku: string
  barcode: string | null
  name: string
  category_id: string | null
  tax_rate_id: string | null
  unit_price_cents: string
  active: boolean
  revision: string
  image_url: string | null
  station_id: string | null
  prep_time_seconds: number | null
  course: string | null
  kitchen_name: string | null
  is_available: boolean
  unavailable_until: string | null
  sells_directly: boolean
}

function productPayload(row: ProductMutationRow) {
  return {
    ...row,
    unit_price_cents: Number(row.unit_price_cents),
    revision: Number(row.revision),
  }
}

async function publishProductChange(
  client: PoolClient,
  storeId: string,
  row: ProductMutationRow,
  nextPosition: string,
) {
  const stock = await client.query(
    'select product_id,current_stock,updated_at from public.pos_stock where store_id=$1 and product_id=$2',
    [storeId, row.id],
  )
  const stockRow = stock.rows[0] as { product_id: string; current_stock: number; updated_at: string } | undefined
  await client.query('update public.pos_sync_feed_state set last_position=$1 where store_id=$2', [nextPosition, storeId])
  await client.query(
    `insert into public.pos_change_feed (store_id, position, entity_type, entity_id, action, payload)
     values ($1,$2,'product',$3,'upsert',$4::jsonb)`,
    [storeId, nextPosition, row.id, JSON.stringify({ product: productPayload(row), ...(stockRow ? { stock: stockRow } : {}) })],
  )
  return stockRow
}

// PATCH /catalog/products/:productId - owner/manager updates an existing menu item.
async function updateProduct(req: import('express').Request, res: import('express').Response) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = storeIdFrom(body.store_id)
    const productId = String(req.params.productId ?? '')
    if (!UUID_RE.test(productId)) throw new ApiError(400, 'validation_failed', 'A valid product ID is required.')
    await requireStoreManager(req, storeId)

    const name = String(body.name ?? '').trim()
    if (!name || name.length > 160) throw new ApiError(422, 'validation_failed', 'Product name is required and must be 1-160 characters.')
    const sku = String(body.sku ?? '').trim()
    if (!sku || sku.length > 80) throw new ApiError(422, 'validation_failed', 'SKU is required and must be 1-80 characters.')
    const barcode = body.barcode === null || body.barcode === undefined || String(body.barcode).trim() === ''
      ? null : String(body.barcode).trim()
    if (barcode !== null && (!/^[A-Za-z0-9]+$/.test(barcode) || barcode.length > 80)) {
      throw new ApiError(422, 'validation_failed', 'Barcode must be alphanumeric, 1-80 characters.')
    }
    const categoryId = body.category_id === null || body.category_id === undefined || body.category_id === ''
      ? null : String(body.category_id)
    if (categoryId !== null && !UUID_RE.test(categoryId)) throw new ApiError(422, 'validation_failed', 'Choose a valid category.')
    const taxRateId = body.tax_rate_id === null || body.tax_rate_id === undefined || body.tax_rate_id === ''
      ? null : String(body.tax_rate_id)
    if (taxRateId !== null && !UUID_RE.test(taxRateId)) throw new ApiError(422, 'validation_failed', 'Choose a valid tax rate.')
    if (!Number.isInteger(body.unit_price_cents) || (body.unit_price_cents as number) < 0 || (body.unit_price_cents as number) > 1_000_000_000) {
      throw new ApiError(422, 'validation_failed', 'unit_price_cents must be a non-negative integer.')
    }
    const imageUrl = body.image_url === null || body.image_url === undefined || String(body.image_url).trim() === ''
      ? null : String(body.image_url).trim()
    if (imageUrl !== null && (imageUrl.length > 2048 || !/^https?:\/\//i.test(imageUrl))) {
      throw new ApiError(422, 'validation_failed', 'image_url must be an http(s) URL of 2048 characters or fewer.')
    }
    const active = typeof body.active === 'boolean' ? body.active : true

    const client = await db.connect()
    try {
      await client.query('begin')
      const feed = await client.query('select last_position from public.pos_sync_feed_state where store_id=$1 for update', [storeId])
      if (!feed.rows[0]) throw new ApiError(503, 'server_unavailable', 'Store is not initialized.')
      const nextPosition = (BigInt(feed.rows[0].last_position as string | number) + 1n).toString()

      if (categoryId) {
        const category = await client.query('select 1 from public.pos_categories where store_id=$1 and id=$2', [storeId, categoryId])
        if (!category.rowCount) throw new ApiError(422, 'validation_failed', 'Category does not belong to this store.')
      }
      if (taxRateId) {
        const taxRate = await client.query('select 1 from public.pos_tax_rates where store_id=$1 and id=$2', [storeId, taxRateId])
        if (!taxRate.rowCount) throw new ApiError(422, 'validation_failed', 'Tax rate does not belong to this store.')
      }

      let updated
      try {
        updated = await client.query(
          `update public.pos_products
             set name=$3, sku=$4, barcode=$5, category_id=$6, tax_rate_id=$7,
                 unit_price_cents=$8, image_url=$9, active=$10, revision=revision+1
           where store_id=$1 and id=$2
           returning id,store_id,sku,barcode,name,category_id,tax_rate_id,
             unit_price_cents::text,active,revision::text,image_url,station_id,
             prep_time_seconds,course,kitchen_name,is_available,unavailable_until,sells_directly`,
          [storeId, productId, name, sku, barcode, categoryId, taxRateId, body.unit_price_cents, imageUrl, active],
        )
      } catch (updateReason) {
        if (typeof updateReason === 'object' && updateReason !== null && 'code' in updateReason && (updateReason as { code: string }).code === '23505') {
          throw new ApiError(409, 'sku_conflict', 'A product with this SKU already exists in this store.')
        }
        throw updateReason
      }
      if (!updated.rows[0]) throw new ApiError(404, 'not_found', 'Menu item not found.')
      const row = updated.rows[0] as ProductMutationRow
      const stock = await publishProductChange(client, storeId, row, nextPosition)
      await client.query('commit')
      res.json({ product: productPayload(row), stock, checkpoint: nextPosition })
    } catch (reason) {
      await client.query('rollback')
      throw reason
    } finally {
      client.release()
    }
  } catch (reason) { sendApiError(res, reason) }
}

// DELETE keeps historical orders and recipe references intact by archiving the dish.
async function archiveProduct(req: import('express').Request, res: import('express').Response) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = storeIdFrom(body.store_id)
    const productId = String(req.params.productId ?? '')
    if (!UUID_RE.test(productId)) throw new ApiError(400, 'validation_failed', 'A valid product ID is required.')
    await requireStoreManager(req, storeId)
    const client = await db.connect()
    try {
      await client.query('begin')
      const feed = await client.query('select last_position from public.pos_sync_feed_state where store_id=$1 for update', [storeId])
      if (!feed.rows[0]) throw new ApiError(503, 'server_unavailable', 'Store is not initialized.')
      const nextPosition = (BigInt(feed.rows[0].last_position as string | number) + 1n).toString()
      const updated = await client.query(
        `update public.pos_products set active=false, revision=revision+1
         where store_id=$1 and id=$2
         returning id,store_id,sku,barcode,name,category_id,tax_rate_id,
           unit_price_cents::text,active,revision::text,image_url,station_id,
           prep_time_seconds,course,kitchen_name,is_available,unavailable_until,sells_directly`,
        [storeId, productId],
      )
      if (!updated.rows[0]) throw new ApiError(404, 'not_found', 'Menu item not found.')
      const row = updated.rows[0] as ProductMutationRow
      const stock = await publishProductChange(client, storeId, row, nextPosition)
      await client.query('commit')
      res.json({ product: productPayload(row), stock, checkpoint: nextPosition })
    } catch (reason) {
      await client.query('rollback')
      throw reason
    } finally {
      client.release()
    }
  } catch (reason) { sendApiError(res, reason) }
}

// ---------------------------------------------------------------------------
// Recipes + units (Day 3). Recipes are back-office data only — terminals never need them, so
// none of this goes through the sync feed. Ingredient lines live in Bisma's recipe_ingredients
// table; until that migration is applied every endpoint here still works, just with no lines
// and no ingredients (ingredients_ready: false tells the UI why).
// ---------------------------------------------------------------------------
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }

const UNIT_KINDS = ['mass', 'volume', 'count'] as const
type UnitKind = typeof UNIT_KINDS[number]
const MAX_RECIPE_QUANTITY = 1_000_000
const MAX_RECIPE_LINES = 100

export interface UnitInput { name: string; abbreviation: string; kind: UnitKind; factor_to_base: number | null }
export interface RecipeLineInput { ingredient_id: string; quantity: number; unit_id: string }
export interface RecipeInput { yield_quantity: number; yield_unit_id: string; lines: RecipeLineInput[] }

function storeIdFrom(value: unknown): string {
  const storeId = String(value ?? '')
  if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id UUID is required.')
  return storeId
}

function recipeQuantity(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_RECIPE_QUANTITY) {
    throw new ApiError(422, 'validation_failed', `${label} must be a number greater than 0 and at most ${MAX_RECIPE_QUANTITY.toLocaleString('en-US')}.`)
  }
  return value
}

export function parseUnitBody(body: Record<string, unknown>): UnitInput {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 40) throw new ApiError(422, 'validation_failed', 'Unit name is required and must be 1–40 characters.')
  const abbreviation = typeof body.abbreviation === 'string' ? body.abbreviation.trim() : ''
  if (!abbreviation || abbreviation.length > 10) throw new ApiError(422, 'validation_failed', 'Unit abbreviation is required and must be 1–10 characters.')
  const kind = body.kind as UnitKind
  if (!UNIT_KINDS.includes(kind)) throw new ApiError(422, 'validation_failed', 'Unit kind must be mass, volume, or count.')
  let factorToBase: number | null = null
  if (body.factor_to_base !== undefined && body.factor_to_base !== null) {
    const value = Number(body.factor_to_base)
    if (!Number.isFinite(value) || value <= 0) throw new ApiError(422, 'validation_failed', 'factor_to_base must be a number greater than 0, or omitted.')
    factorToBase = value
  }
  return { name, abbreviation, kind, factor_to_base: factorToBase }
}

export function parseRecipeBody(body: Record<string, unknown>): RecipeInput {
  const yieldQuantity = recipeQuantity(body.yield_quantity, 'Recipe yield')
  const yieldUnitId = String(body.yield_unit_id ?? '')
  if (!UUID_RE.test(yieldUnitId)) throw new ApiError(422, 'validation_failed', 'Choose a yield unit for the recipe.')
  if (!Array.isArray(body.lines)) throw new ApiError(422, 'validation_failed', 'lines must be an array.')
  if (body.lines.length > MAX_RECIPE_LINES) throw new ApiError(422, 'validation_failed', `A recipe can have at most ${MAX_RECIPE_LINES} ingredient lines.`)
  const seen = new Set<string>()
  const lines = body.lines.map((raw, index): RecipeLineInput => {
    const line = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const ingredientId = String(line.ingredient_id ?? '')
    const unitId = String(line.unit_id ?? '')
    if (!UUID_RE.test(ingredientId)) throw new ApiError(422, 'validation_failed', `Line ${index + 1}: choose an ingredient.`)
    if (!UUID_RE.test(unitId)) throw new ApiError(422, 'validation_failed', `Line ${index + 1}: choose a unit.`)
    if (seen.has(ingredientId)) throw new ApiError(422, 'validation_failed', `Line ${index + 1}: this ingredient is already on the recipe — combine the quantities into one line.`)
    seen.add(ingredientId)
    return { ingredient_id: ingredientId, quantity: recipeQuantity(line.quantity, `Line ${index + 1} quantity`), unit_id: unitId }
  })
  return { yield_quantity: yieldQuantity, yield_unit_id: yieldUnitId, lines }
}

/** Bisma's ingredients/recipe_ingredients migration lands after this one — probe, don't assume. */
async function ingredientsReady(client: Queryable): Promise<boolean> {
  const result = await client.query(`select to_regclass('public.ingredients') is not null and to_regclass('public.recipe_ingredients') is not null as ready`)
  return (result.rows[0] as { ready: boolean }).ready
}

export interface RecipeRow {
  id: string; product_id: string; yield_quantity: number; yield_unit_id: string
  lines: { id: string; ingredient_id: string; quantity: number; unit_id: string }[]
}

async function loadRecipes(client: Queryable, storeId: string, ready: boolean, productId?: string): Promise<RecipeRow[]> {
  const recipes = await client.query(
    `select id, product_id, yield_quantity::float8 as yield_quantity, yield_unit_id from public.recipes
     where store_id=$1 and ($2::uuid is null or product_id=$2::uuid)`,
    [storeId, productId ?? null],
  )
  const byId = new Map((recipes.rows as Omit<RecipeRow, 'lines'>[]).map(row => [row.id, { ...row, lines: [] as RecipeRow['lines'] }]))
  if (ready && byId.size) {
    const lines = await client.query(
      `select id, recipe_id, ingredient_id, quantity::float8 as quantity, unit_id from public.recipe_ingredients
       where store_id=$1 and recipe_id = any($2::uuid[]) order by id`,
      [storeId, [...byId.keys()]],
    )
    for (const line of lines.rows as (RecipeRow['lines'][number] & { recipe_id: string })[]) {
      const { recipe_id: recipeId, ...rest } = line
      byId.get(recipeId)?.lines.push(rest)
    }
  }
  return [...byId.values()]
}

/**
 * Creates or replaces a product's recipe and all of its ingredient lines in one transaction —
 * a full replace-on-save, never incremental line edits. Every referenced product, unit, and
 * ingredient is checked against storeId before writing (the composite FKs are the final guard).
 */
export async function saveRecipe(storeId: string, productId: string, input: RecipeInput): Promise<RecipeRow> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const product = await client.query('select 1 from public.pos_products where store_id=$1 and id=$2', [storeId, productId])
    if (!product.rowCount) throw new ApiError(404, 'not_found', 'That dish does not exist in this store.')

    const unitIds = [...new Set([input.yield_unit_id, ...input.lines.map(line => line.unit_id)])]
    const units = await client.query('select id, kind, factor_to_base::float8 as factor_to_base from public.units where store_id=$1 and id = any($2::uuid[])', [storeId, unitIds])
    const unitsById = new Map((units.rows as (RecipeCostUnit & { factor_to_base: number | null })[]).map(row => [row.id, { id: row.id, kind: row.kind, factorToBase: row.factor_to_base } as RecipeCostUnit]))
    if (!unitsById.has(input.yield_unit_id)) throw new ApiError(422, 'validation_failed', 'The yield unit does not belong to this store.')
    if (unitIds.some(id => !unitsById.has(id))) throw new ApiError(422, 'validation_failed', 'A recipe line uses a unit that does not belong to this store.')

    const ready = await ingredientsReady(client)
    if (input.lines.length && !ready) {
      throw new ApiError(409, 'ingredients_unavailable', 'Ingredient inventory is not set up yet, so ingredient lines cannot be saved. Save the yield only for now.')
    }
    if (input.lines.length) {
      const ingredients = await client.query(
        'select id, unit_id from public.ingredients where store_id=$1 and id = any($2::uuid[])',
        [storeId, input.lines.map(line => line.ingredient_id)],
      )
      const ingredientUnit = new Map((ingredients.rows as { id: string; unit_id: string }[]).map(row => [row.id, row.unit_id]))
      // An ingredient's own stock unit isn't necessarily one of the units already fetched above
      // (those only cover the yield unit and each line's chosen unit) -- fetch whichever of them
      // are still missing so the conversion check below always has both sides available.
      const missingUnitIds = [...ingredientUnit.values()].filter(id => !unitsById.has(id))
      if (missingUnitIds.length) {
        const moreUnits = await client.query('select id, kind, factor_to_base::float8 as factor_to_base from public.units where store_id=$1 and id = any($2::uuid[])', [storeId, missingUnitIds])
        for (const row of moreUnits.rows as (RecipeCostUnit & { factor_to_base: number | null })[]) {
          unitsById.set(row.id, { id: row.id, kind: row.kind, factorToBase: row.factor_to_base })
        }
      }
      input.lines.forEach((line, index) => {
        const unitId = ingredientUnit.get(line.ingredient_id)
        if (!unitId) throw new ApiError(422, 'validation_failed', `Line ${index + 1}: that ingredient does not belong to this store.`)
        const ingredientUnitInfo = unitsById.get(unitId)
        const lineUnitInfo = unitsById.get(line.unit_id)
        // Costing (packages/domain/src/recipe-cost.ts) refuses a mismatched or unconvertible line
        // at costing time too -- refusing it here as well keeps a bad line out of storage entirely.
        if (!ingredientUnitInfo || !lineUnitInfo || convertQuantity(1, lineUnitInfo, ingredientUnitInfo) === null) {
          throw new ApiError(422, 'unit_mismatch', `Line ${index + 1}: this unit has no known conversion to the ingredient's stock unit.`)
        }
      })
    }

    const recipe = await client.query(
      `insert into public.recipes (store_id, product_id, yield_quantity, yield_unit_id) values ($1,$2,$3,$4)
       on conflict (store_id, product_id) do update set yield_quantity=excluded.yield_quantity, yield_unit_id=excluded.yield_unit_id
       returning id`,
      [storeId, productId, input.yield_quantity, input.yield_unit_id],
    )
    const recipeId = (recipe.rows[0] as { id: string }).id
    if (ready) {
      await client.query('delete from public.recipe_ingredients where store_id=$1 and recipe_id=$2', [storeId, recipeId])
      for (const line of input.lines) {
        await client.query(
          'insert into public.recipe_ingredients (store_id, recipe_id, ingredient_id, quantity, unit_id) values ($1,$2,$3,$4,$5)',
          [storeId, recipeId, line.ingredient_id, line.quantity, line.unit_id],
        )
      }
    }
    const [saved] = await loadRecipes(client, storeId, ready, productId)
    await client.query('commit')
    return saved
  } catch (reason) {
    await client.query('rollback')
    throw reason
  } finally {
    client.release()
  }
}

// GET /catalog/recipes — everything the recipe editor needs for a store, in one read.
async function listRecipeData(req: import('express').Request, res: import('express').Response) {
  try {
    const storeId = storeIdFrom(req.query.store_id)
    await requireStoreMember(req, storeId)
    const ready = await ingredientsReady(db)
    const units = await db.query('select id, name, abbreviation, kind, factor_to_base::float8 as factor_to_base from public.units where store_id=$1 order by name', [storeId])
    const ingredients = ready
      ? await db.query('select id, name, unit_id, cost_per_unit_cents, active from public.ingredients where store_id=$1 order by name', [storeId])
      : { rows: [] }
    res.json({ ingredients_ready: ready, units: units.rows, ingredients: ingredients.rows, recipes: await loadRecipes(db, storeId, ready) })
  } catch (reason) { sendApiError(res, reason) }
}

// POST /catalog/units — owner/manager adds a unit of measure.
async function createUnit(req: import('express').Request, res: import('express').Response) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = storeIdFrom(body.store_id)
    await requireStoreManager(req, storeId)
    const unit = parseUnitBody(body)
    try {
      const result = await db.query(
        'insert into public.units (store_id, name, abbreviation, kind, factor_to_base) values ($1,$2,$3,$4,$5) returning id, name, abbreviation, kind, factor_to_base::float8 as factor_to_base',
        [storeId, unit.name, unit.abbreviation, unit.kind, unit.factor_to_base],
      )
      res.status(201).json({ unit: result.rows[0] })
    } catch (insertReason) {
      if (typeof insertReason === 'object' && insertReason !== null && 'code' in insertReason && (insertReason as { code: string }).code === '23505') {
        throw new ApiError(409, 'unit_conflict', 'A unit with this name already exists in this store.')
      }
      throw insertReason
    }
  } catch (reason) { sendApiError(res, reason) }
}

// PUT /catalog/products/:productId/recipe — owner/manager saves a dish's whole recipe.
async function putRecipe(req: import('express').Request, res: import('express').Response) {
  try {
    const body = req.body as Record<string, unknown>
    const storeId = storeIdFrom(body.store_id)
    const productId = String(req.params.productId ?? '')
    if (!UUID_RE.test(productId)) throw new ApiError(400, 'validation_failed', 'A valid product ID is required.')
    await requireStoreManager(req, storeId)
    res.json({ recipe: await saveRecipe(storeId, productId, parseRecipeBody(body)) })
  } catch (reason) { sendApiError(res, reason) }
}

export const catalogRouter = Router()
export const terminalCatalogRouter = Router()
catalogRouter.get('/snapshot', (req, res) => void snapshot(req, res))
catalogRouter.post('/products', (req, res) => void createProduct(req, res))
catalogRouter.patch('/products/:productId', (req, res) => void updateProduct(req, res))
catalogRouter.delete('/products/:productId', (req, res) => void archiveProduct(req, res))
catalogRouter.get('/recipes', (req, res) => void listRecipeData(req, res))
catalogRouter.post('/units', (req, res) => void createUnit(req, res))
catalogRouter.put('/products/:productId/recipe', (req, res) => void putRecipe(req, res))
catalogRouter.put('/products/:productId/modifiers', (req, res) => void replaceProductModifiers(req, res))
terminalCatalogRouter.get('/snapshot', (req, res) => void snapshot(req, res, true))
