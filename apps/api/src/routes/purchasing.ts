import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { ApiError, requireStoreManager, sendApiError } from './auth.js'

export const purchasingRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}

function idParam(req: Request, name = 'id'): string {
  const value = String(req.params[name] ?? '')
  if (!UUID_RE.test(value)) throw new ApiError(422, 'validation_failed', `A valid ${name} is required.`)
  return value
}

function uuidValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new ApiError(422, 'validation_failed', `${label} must be a UUID.`)
  return value
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  if (!text || text.length > max) throw new ApiError(422, 'validation_failed', `${label} must be ${max} characters or fewer.`)
  return text
}

function text(value: unknown, label: string, max: number): string {
  const result = optionalText(value, label, max)
  if (!result) throw new ApiError(422, 'validation_failed', `${label} is required.`)
  return result
}

function positiveNumber(value: unknown, label: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(422, 'validation_failed', `${label} must be positive.`)
  return n
}

function nonNegativeInt(value: unknown, label: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new ApiError(422, 'validation_failed', `${label} must be a non-negative integer.`)
  return n
}

function isoOrNow(value: unknown): string {
  if (value === undefined || value === null || value === '') return new Date().toISOString()
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new ApiError(422, 'validation_failed', 'received_at must be a valid date/time.')
  return new Date(value).toISOString()
}

function isUniqueViolation(reason: unknown): boolean {
  return Boolean(reason && typeof reason === 'object' && 'code' in reason && (reason as { code?: string }).code === '23505')
}

interface VendorRow {
  id: string; store_id: string; name: string; contact_name: string | null; email: string | null
  phone: string | null; terms: string; active: boolean; created_at: string; updated_at: string
}

interface PurchaseOrderRow {
  id: string; store_id: string; vendor_id: string; vendor_name: string | null; status: string
  reference: string | null; notes: string; sent_at: string | null; cancelled_at: string | null
  created_at: string; updated_at: string; line_count: number; ordered_total_cents: string; received_total_cents: string
}

interface PurchaseOrderLineRow {
  id: string; store_id: string; purchase_order_id: string; ingredient_id: string; ingredient_name: string | null
  ordered_quantity: string; received_quantity: string; unit_cost_cents: number; reference: string | null; created_at: string
}

interface PurchaseReceiptRow {
  id: string; store_id: string; purchase_order_id: string; operation_id: string; invoice_reference: string | null
  received_at: string; manager_approved: boolean; manager_approval_reason: string | null; created_at: string
}

const PO_SELECT = `
  po.id, po.store_id, po.vendor_id, v.name as vendor_name, po.status, po.reference, po.notes,
  po.sent_at, po.cancelled_at, po.created_at, po.updated_at,
  coalesce(count(pol.id),0)::int as line_count,
  coalesce(sum(pol.ordered_quantity * pol.unit_cost_cents),0)::text as ordered_total_cents,
  coalesce(sum(pol.received_quantity * pol.unit_cost_cents),0)::text as received_total_cents
  from public.purchase_orders po
  join public.vendors v on v.store_id=po.store_id and v.id=po.vendor_id
  left join public.purchase_order_lines pol on pol.store_id=po.store_id and pol.purchase_order_id=po.id`

const LINE_SELECT = `
  pol.id, pol.store_id, pol.purchase_order_id, pol.ingredient_id, i.name as ingredient_name,
  pol.ordered_quantity::text as ordered_quantity, pol.received_quantity::text as received_quantity,
  pol.unit_cost_cents, pol.reference, pol.created_at
  from public.purchase_order_lines pol
  join public.ingredients i on i.store_id=pol.store_id and i.id=pol.ingredient_id`

async function listVendors(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const includeInactive = req.query.include_inactive === 'true'
    const result = await db.query<VendorRow>(
      `select * from public.vendors where store_id=$1 ${includeInactive ? '' : 'and active=true'} order by name`,
      [storeId],
    )
    res.json({ vendors: result.rows })
  } catch (reason) { sendApiError(res, reason) }
}

async function createVendor(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const body = req.body as Record<string, unknown>
    const result = await db.query<VendorRow>(
      `insert into public.vendors(store_id,name,contact_name,email,phone,terms,active)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [storeId, text(body.name, 'Vendor name', 160), optionalText(body.contact_name, 'Contact name', 120),
        optionalText(body.email, 'Email', 160), optionalText(body.phone, 'Phone', 40),
        optionalText(body.terms, 'Terms', 500) ?? '', body.active === undefined ? true : Boolean(body.active)],
    )
    res.status(201).json(result.rows[0])
  } catch (reason) {
    if (isUniqueViolation(reason)) sendApiError(res, new ApiError(409, 'name_conflict', 'A vendor with this name already exists.'))
    else sendApiError(res, reason)
  }
}

async function updateVendor(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const id = idParam(req)
    const body = req.body as Record<string, unknown>
    const updates: string[] = []
    const values: unknown[] = []
    let index = 1
    const add = (field: string, value: unknown) => { updates.push(`${field}=$${index++}`); values.push(value) }
    if (body.name !== undefined) add('name', text(body.name, 'Vendor name', 160))
    if (body.contact_name !== undefined) add('contact_name', optionalText(body.contact_name, 'Contact name', 120))
    if (body.email !== undefined) add('email', optionalText(body.email, 'Email', 160))
    if (body.phone !== undefined) add('phone', optionalText(body.phone, 'Phone', 40))
    if (body.terms !== undefined) add('terms', optionalText(body.terms, 'Terms', 500) ?? '')
    if (body.active !== undefined) add('active', Boolean(body.active))
    if (!updates.length) throw new ApiError(422, 'validation_failed', 'Nothing to update.')
    updates.push('updated_at=now()')
    values.push(id, storeId)
    const result = await db.query<VendorRow>(`update public.vendors set ${updates.join(', ')} where id=$${index++} and store_id=$${index} returning *`, values)
    if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Vendor not found.')
    res.json(result.rows[0])
  } catch (reason) {
    if (isUniqueViolation(reason)) sendApiError(res, new ApiError(409, 'name_conflict', 'A vendor with this name already exists.'))
    else sendApiError(res, reason)
  }
}

async function fetchPo(storeId: string, poId: string): Promise<{ purchase_order: PurchaseOrderRow; lines: PurchaseOrderLineRow[]; receipts: PurchaseReceiptRow[] }> {
  const [po, lines, receipts] = await Promise.all([
    db.query<PurchaseOrderRow>(`select ${PO_SELECT} where po.store_id=$1 and po.id=$2 group by po.id, v.name`, [storeId, poId]),
    db.query<PurchaseOrderLineRow>(`select ${LINE_SELECT} where pol.store_id=$1 and pol.purchase_order_id=$2 order by i.name`, [storeId, poId]),
    db.query<PurchaseReceiptRow>('select * from public.purchase_receipts where store_id=$1 and purchase_order_id=$2 order by received_at desc', [storeId, poId]),
  ])
  if (!po.rows[0]) throw new ApiError(404, 'not_found', 'Purchase order not found.')
  return { purchase_order: po.rows[0], lines: lines.rows, receipts: receipts.rows }
}

async function listPurchaseOrders(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const result = await db.query<PurchaseOrderRow>(
      `select ${PO_SELECT} where po.store_id=$1 group by po.id, v.name order by po.created_at desc limit 100`,
      [storeId],
    )
    res.json({ purchase_orders: result.rows })
  } catch (reason) { sendApiError(res, reason) }
}

async function createPurchaseOrder(req: Request, res: Response) {
  const client = await db.connect()
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const body = req.body as Record<string, unknown>
    const vendorId = uuidValue(body.vendor_id, 'vendor_id')
    const rawLines = Array.isArray(body.lines) ? body.lines : []
    if (!rawLines.length) throw new ApiError(422, 'validation_failed', 'At least one line is required.')
    await client.query('begin')
    const vendor = await client.query('select 1 from public.vendors where id=$1 and store_id=$2 and active=true', [vendorId, storeId])
    if (!vendor.rowCount) throw new ApiError(422, 'validation_failed', 'Vendor must be active and belong to this store.')
    const po = await client.query<{ id: string }>(
      `insert into public.purchase_orders(store_id,vendor_id,reference,notes)
       values ($1,$2,$3,$4) returning id`,
      [storeId, vendorId, optionalText(body.reference, 'Reference', 120), optionalText(body.notes, 'Notes', 500) ?? ''],
    )
    for (const raw of rawLines) {
      const line = raw as Record<string, unknown>
      const ingredientId = uuidValue(line.ingredient_id, 'ingredient_id')
      const ingredient = await client.query('select 1 from public.ingredients where id=$1 and store_id=$2 and active=true', [ingredientId, storeId])
      if (!ingredient.rowCount) throw new ApiError(422, 'validation_failed', 'Each line ingredient must belong to this store.')
      await client.query(
        `insert into public.purchase_order_lines(store_id,purchase_order_id,ingredient_id,ordered_quantity,unit_cost_cents,reference)
         values ($1,$2,$3,$4,$5,$6)`,
        [storeId, po.rows[0].id, ingredientId, positiveNumber(line.ordered_quantity, 'ordered_quantity'),
          nonNegativeInt(line.unit_cost_cents, 'unit_cost_cents'), optionalText(line.reference, 'Line reference', 160)],
      )
    }
    await client.query('commit')
    res.status(201).json(await fetchPo(storeId, po.rows[0].id))
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    sendApiError(res, reason)
  } finally { client.release() }
}

async function setPoStatus(req: Request, res: Response, status: 'sent' | 'cancelled') {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const poId = idParam(req)
    const result = await db.query<{ id: string }>(
      status === 'sent'
        ? `update public.purchase_orders set status='sent', sent_at=coalesce(sent_at, now()), updated_at=now()
           where id=$1 and store_id=$2 and status='draft' returning id`
        : `update public.purchase_orders set status='cancelled', cancelled_at=now(), updated_at=now()
           where id=$1 and store_id=$2 and status <> 'cancelled' returning id`,
      [poId, storeId],
    )
    if (!result.rows[0]) {
      const exists = await db.query('select 1 from public.purchase_orders where id=$1 and store_id=$2', [poId, storeId])
      if (!exists.rowCount) throw new ApiError(404, 'not_found', 'Purchase order not found.')
      throw new ApiError(409, 'invalid_transition', 'Purchase order is not in a valid state for this action.')
    }
    res.json(await fetchPo(storeId, poId))
  } catch (reason) { sendApiError(res, reason) }
}

async function recomputePoStatus(client: PoolClient, storeId: string, poId: string) {
  const lines = await client.query<{ ordered: string; received: string }>(
    `select coalesce(sum(ordered_quantity),0)::text as ordered, coalesce(sum(least(received_quantity, ordered_quantity)),0)::text as received
     from public.purchase_order_lines where store_id=$1 and purchase_order_id=$2`,
    [storeId, poId],
  )
  const current = await client.query<{ status: string }>('select status from public.purchase_orders where store_id=$1 and id=$2 for update', [storeId, poId])
  if (current.rows[0]?.status === 'cancelled') return
  const ordered = Number(lines.rows[0].ordered), received = Number(lines.rows[0].received)
  const status = received <= 0 ? 'sent' : received >= ordered ? 'received' : 'partially_received'
  await client.query('update public.purchase_orders set status=$1, updated_at=now() where store_id=$2 and id=$3', [status, storeId, poId])
}

export async function receivePurchaseOrderCore(client: PoolClient, storeId: string, poId: string, input: Record<string, unknown>) {
  const operationId = input.operation_id ? uuidValue(input.operation_id, 'operation_id') : randomUUID()
  const rawLines = Array.isArray(input.lines) ? input.lines : []
  if (!rawLines.length) throw new ApiError(422, 'validation_failed', 'At least one received line is required.')
  const managerApproved = Boolean(input.manager_approved)
  const approvalReason = optionalText(input.manager_approval_reason, 'Manager approval reason', 500)
  const updateIngredientCosts = Boolean(input.update_ingredient_costs)
  if ((managerApproved || updateIngredientCosts) && !approvalReason) throw new ApiError(422, 'validation_failed', 'Manager-approved receiving requires a reason.')
  const receivedAt = isoOrNow(input.received_at)
  const invoiceReference = optionalText(input.invoice_reference, 'Invoice reference', 160)

  const po = await client.query<{ status: string }>('select status from public.purchase_orders where id=$1 and store_id=$2 for update', [poId, storeId])
  if (!po.rows[0]) throw new ApiError(404, 'not_found', 'Purchase order not found.')
  if (po.rows[0].status === 'cancelled') throw new ApiError(409, 'po_cancelled', 'A cancelled purchase order cannot receive more stock.')
  // ON CONFLICT DO NOTHING makes the (store_id, operation_id) idempotency check atomic with the
  // insert itself -- a plain SELECT-then-INSERT would leave a window where two concurrent
  // requests with the same operation_id (e.g. a double-submitted receive) could both pass the
  // check and race on the insert's unique constraint.
  const receipt = await client.query<{ id: string }>(
    `insert into public.purchase_receipts(store_id,purchase_order_id,operation_id,invoice_reference,received_at,manager_approved,manager_approval_reason)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (store_id, operation_id) do nothing
     returning id`,
    [storeId, poId, operationId, invoiceReference, receivedAt, managerApproved, approvalReason],
  )
  if (!receipt.rows[0]) {
    const existing = await client.query<{ id: string }>('select id from public.purchase_receipts where store_id=$1 and operation_id=$2', [storeId, operationId])
    return { receiptId: existing.rows[0].id, replayed: true }
  }
  for (const raw of rawLines) {
    const lineInput = raw as Record<string, unknown>
    const lineId = uuidValue(lineInput.purchase_order_line_id, 'purchase_order_line_id')
    const receivedQuantity = positiveNumber(lineInput.received_quantity, 'received_quantity')
    const unitCostCents = lineInput.unit_cost_cents === undefined ? null : nonNegativeInt(lineInput.unit_cost_cents, 'unit_cost_cents')
    const line = await client.query<{ ingredient_id: string; ordered_quantity: string; received_quantity: string; unit_cost_cents: number; ingredient_cost: number }>(
      `select pol.ingredient_id, pol.ordered_quantity::text, pol.received_quantity::text, pol.unit_cost_cents, i.cost_per_unit_cents as ingredient_cost
       from public.purchase_order_lines pol
       join public.ingredients i on i.store_id=pol.store_id and i.id=pol.ingredient_id
       where pol.id=$1 and pol.store_id=$2 and pol.purchase_order_id=$3 for update`,
      [lineId, storeId, poId],
    )
    if (!line.rows[0]) throw new ApiError(422, 'validation_failed', 'Received line does not belong to this purchase order.')
    const row = line.rows[0]
    const newReceived = Number(row.received_quantity) + receivedQuantity
    const overReceived = newReceived > Number(row.ordered_quantity)
    if (overReceived && !managerApproved) throw new ApiError(409, 'over_receipt_requires_approval', 'Over-receipt requires manager approval.')
    const cost = unitCostCents ?? row.unit_cost_cents
    const batch = await client.query<{ id: string }>(
      `insert into public.ingredient_batches(store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents,received_at,reference)
       values ($1,$2,$3,$3,$4,$5,$6) returning id`,
      [storeId, row.ingredient_id, receivedQuantity, cost, receivedAt, invoiceReference],
    )
    const movement = await client.query<{ id: string }>(
      `insert into public.stock_movements(store_id,ingredient_id,batch_id,delta,reason,note)
       values ($1,$2,$3,$4,'purchase',$5) returning id`,
      [storeId, row.ingredient_id, batch.rows[0].id, receivedQuantity, `PO ${poId}`],
    )
    await client.query('update public.ingredients set current_stock=current_stock+$1, updated_at=now() where store_id=$2 and id=$3', [receivedQuantity, storeId, row.ingredient_id])
    await client.query('update public.purchase_order_lines set received_quantity=received_quantity+$1 where store_id=$2 and id=$3', [receivedQuantity, storeId, lineId])
    const receiptLine = await client.query<{ id: string }>(
      `insert into public.purchase_receipt_lines(store_id,purchase_receipt_id,purchase_order_line_id,ingredient_id,
        received_quantity,unit_cost_cents,previous_unit_cost_cents,cost_variance_cents,batch_id,stock_movement_id,over_received)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [storeId, receipt.rows[0].id, lineId, row.ingredient_id, receivedQuantity, cost, row.ingredient_cost,
        cost - row.ingredient_cost, batch.rows[0].id, movement.rows[0].id, overReceived],
    )
    if (updateIngredientCosts && cost !== row.ingredient_cost) {
      if (!managerApproved || !approvalReason) throw new ApiError(422, 'validation_failed', 'Cost updates require manager approval and a reason.')
      await client.query(
        `insert into public.ingredient_cost_history(store_id,ingredient_id,purchase_receipt_line_id,previous_unit_cost_cents,new_unit_cost_cents,reason)
         values ($1,$2,$3,$4,$5,$6)`,
        [storeId, row.ingredient_id, receiptLine.rows[0].id, row.ingredient_cost, cost, approvalReason],
      )
      await client.query('update public.ingredients set cost_per_unit_cents=$1, updated_at=now() where store_id=$2 and id=$3', [cost, storeId, row.ingredient_id])
    }
  }
  await recomputePoStatus(client, storeId, poId)
  return { receiptId: receipt.rows[0].id, replayed: false }
}

async function receivePurchaseOrder(req: Request, res: Response) {
  const client = await db.connect()
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const poId = idParam(req)
    await client.query('begin')
    const result = await receivePurchaseOrderCore(client, storeId, poId, req.body as Record<string, unknown>)
    await client.query('commit')
    res.status(result.replayed ? 200 : 201).json({ ...await fetchPo(storeId, poId), receipt_id: result.receiptId, replayed: result.replayed })
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    sendApiError(res, reason)
  } finally { client.release() }
}

async function report(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const [vendors, spend, variance] = await Promise.all([
      db.query<{ active: string; inactive: string }>(`select count(*) filter (where active)::text as active, count(*) filter (where not active)::text as inactive from public.vendors where store_id=$1`, [storeId]),
      db.query<{ vendor_id: string; vendor_name: string; spend_cents: string }>(
        `select v.id as vendor_id, v.name as vendor_name, coalesce(sum(prl.received_quantity * prl.unit_cost_cents),0)::text as spend_cents
         from public.vendors v
         left join public.purchase_orders po on po.store_id=v.store_id and po.vendor_id=v.id
         left join public.purchase_receipts pr on pr.store_id=po.store_id and pr.purchase_order_id=po.id
         left join public.purchase_receipt_lines prl on prl.store_id=pr.store_id and prl.purchase_receipt_id=pr.id
         where v.store_id=$1 group by v.id, v.name order by coalesce(sum(prl.received_quantity * prl.unit_cost_cents),0) desc`,
        [storeId],
      ),
      db.query<{ ingredient_id: string; ingredient_name: string; variance_cents: string }>(
        `select i.id as ingredient_id, i.name as ingredient_name, coalesce(sum(prl.received_quantity * prl.cost_variance_cents),0)::text as variance_cents
         from public.purchase_receipt_lines prl
         join public.ingredients i on i.store_id=prl.store_id and i.id=prl.ingredient_id
         where prl.store_id=$1 group by i.id, i.name order by abs(coalesce(sum(prl.received_quantity * prl.cost_variance_cents),0)) desc limit 25`,
        [storeId],
      ),
    ])
    res.json({ vendors: vendors.rows[0], vendor_spend: spend.rows, cost_variance: variance.rows })
  } catch (reason) { sendApiError(res, reason) }
}

purchasingRouter.get('/vendors', (req, res) => void listVendors(req, res))
purchasingRouter.post('/vendors', (req, res) => void createVendor(req, res))
purchasingRouter.patch('/vendors/:id', (req, res) => void updateVendor(req, res))
purchasingRouter.get('/purchase-orders', (req, res) => void listPurchaseOrders(req, res))
purchasingRouter.post('/purchase-orders', (req, res) => void createPurchaseOrder(req, res))
purchasingRouter.get('/purchase-orders/:id', async (req, res) => {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    res.json(await fetchPo(storeId, idParam(req)))
  } catch (reason) { sendApiError(res, reason) }
})
purchasingRouter.post('/purchase-orders/:id/send', (req, res) => void setPoStatus(req, res, 'sent'))
purchasingRouter.post('/purchase-orders/:id/cancel', (req, res) => void setPoStatus(req, res, 'cancelled'))
purchasingRouter.post('/purchase-orders/:id/receive', (req, res) => void receivePurchaseOrder(req, res))
purchasingRouter.get('/report', (req, res) => void report(req, res))
