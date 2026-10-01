import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { ApiError, requireStoreMember, sendApiError } from './auth.js'
import { calendarDayBoundsUtc } from '../lib/timezone.js'
import { costRecipe, foodCostBps, type RecipeCostUnit } from '../../../../packages/domain/src/recipe-cost.js'

export const reportsRouter = Router()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const dateRe = /^\d{4}-\d{2}-\d{2}$/

export async function requireReportAccess(req: Request, storeId: string): Promise<void> {
  const userId = await requireStoreMember(req, storeId)
  const result = await db.query<{ role: string }>('select role from public.store_memberships where store_id=$1 and user_id=$2 and active=true', [storeId, userId])
  if (!['owner', 'manager'].includes(result.rows[0]?.role ?? '')) throw new ApiError(403, 'authorization_failed', 'Report access requires an owner or manager role.')
}

export function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!uuid.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}

export function dateParam(req: Request): string {
  const date = String(req.query.date ?? '')
  if (!dateRe.test(date)) throw new ApiError(400, 'validation_failed', 'A valid date (YYYY-MM-DD) is required.')
  // Date.parse rolls a calendar-invalid date (e.g. 2025-02-29, a non-leap year) into the next day
  // instead of rejecting it, so round-trip through Date.UTC to catch dates that don't exist.
  const [year, month, day] = date.split('-').map(Number)
  const asUtc = new Date(Date.UTC(year, month - 1, day))
  if (asUtc.getUTCFullYear() !== year || asUtc.getUTCMonth() !== month - 1 || asUtc.getUTCDate() !== day) {
    throw new ApiError(400, 'validation_failed', 'A valid date (YYYY-MM-DD) is required.')
  }
  return date
}

async function storeTimezone(storeId: string): Promise<string> {
  const store = await db.query<{ timezone: string }>('select timezone from public.stores where id=$1', [storeId])
  if (!store.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Store no longer exists.')
  return store.rows[0].timezone
}

async function dayBounds(storeId: string, date: string) {
  const timezone = await storeTimezone(storeId)
  return calendarDayBoundsUtc(date, timezone)
}

export interface DailySummary {
  grossSalesCents: number
  discountCents: number
  netSalesCents: number
  taxCents: number
  cashTakingsCents: number
  cardTakingsCents: number
  tipsCents?: number
  recordedTotalCents: number
  completedOrderCount: number
  averageSaleCents: number
  itemsSold: number
  refundedCount: number
  refundedAmountCents: number
}

// Field names match LocalSalesReport in apps/web/src/lib/reporting.ts so the frontend can consume
// either shape uniformly. No pending/rejected fields: server data is only ever accepted orders — a
// rejected sale never reaches pos_orders at all, since the API only accepts fully-valid operations.
export async function loadDailySummary(storeId: string, date: string): Promise<DailySummary> {
  const { startUtc, endUtc } = await dayBounds(storeId, date)
  const [totals, items, payments, refunds] = await Promise.all([
    db.query<{ gross: string; discount: string; tax: string; total: string; count: string }>(`
      select coalesce(sum(subtotal_cents),0)::text as gross, coalesce(sum(discount_cents),0)::text as discount,
        coalesce(sum(tax_cents),0)::text as tax, coalesce(sum(total_cents),0)::text as total, count(*)::text as count
      from public.pos_orders o where store_id=$1 and client_generated_at >= $2 and client_generated_at < $3`,
      [storeId, startUtc, endUtc]),
    db.query<{ qty: string }>(`
      select coalesce(sum(oi.quantity),0)::text as qty from public.pos_order_items oi
      join public.pos_orders o on o.store_id=oi.store_id and o.id=oi.order_id
      where o.store_id=$1 and o.client_generated_at >= $2 and o.client_generated_at < $3`,
      [storeId, startUtc, endUtc]),
    db.query<{ method: string; amount: string; tips: string }>(`
      select p.method, coalesce(sum(p.amount_cents),0)::text as amount, coalesce(sum(p.tip_cents),0)::text as tips from public.pos_payments p
      join public.pos_orders o on o.store_id=p.store_id and o.id=p.order_id
      where o.store_id=$1 and o.client_generated_at >= $2 and o.client_generated_at < $3
      group by p.method`, [storeId, startUtc, endUtc]),
    db.query<{ count: string; amount: string; merchandise: string; tax: string; cash: string; card: string; tips: string }>(`
      select count(*)::text as count, coalesce(sum(r.amount_cents),0)::text as amount,
        coalesce(sum(r.merchandise_cents),0)::text as merchandise,
        coalesce(sum(r.tax_cents),0)::text as tax, coalesce(sum(r.tip_cents),0)::text as tips,
        coalesce(sum(t.cash),0)::text as cash,
        coalesce(sum(t.card),0)::text as card
      from public.pos_refunds r join public.pos_orders o on o.store_id=r.store_id and o.id=r.order_id
      left join lateral (
        select sum(case when p.method='cash' then rt.amount_cents else 0 end) as cash,
               sum(case when p.method='card' then rt.amount_cents else 0 end) as card
        from public.pos_refund_tenders rt join public.pos_payments p on p.store_id=rt.store_id and p.id=rt.payment_id
        where rt.store_id=r.store_id and rt.refund_id=r.id
      ) t on true
      where r.store_id=$1 and r.created_at >= $2 and r.created_at < $3`,
      [storeId, startUtc, endUtc]),
  ])
  const row = totals.rows[0]
  const grossSalesCents = Number(row.gross), discountCents = Number(row.discount), taxCents = Number(row.tax)
  const originalTotalCents = Number(row.total), completedOrderCount = Number(row.count)
  const refundedAmountCents = Number(refunds.rows[0]?.amount ?? '0')
  const recordedTotalCents = originalTotalCents - refundedAmountCents
  const cashTakingsCents = Number(payments.rows.find(p => p.method === 'cash')?.amount ?? '0') - Number(refunds.rows[0]?.cash ?? '0')
  const cardTakingsCents = Number(payments.rows.find(p => p.method === 'card')?.amount ?? '0') - Number(refunds.rows[0]?.card ?? '0')
  const averageSaleCents = completedOrderCount
    ? Math.floor((originalTotalCents + Math.floor(completedOrderCount / 2)) / completedOrderCount)
    : 0
  return { grossSalesCents, discountCents,
    netSalesCents: grossSalesCents - discountCents - Number(refunds.rows[0]?.merchandise ?? '0'),
    taxCents: taxCents - Number(refunds.rows[0]?.tax ?? '0'),
    cashTakingsCents, cardTakingsCents, tipsCents: payments.rows.reduce((sum, payment) => sum + Number(payment.tips), 0) - Number(refunds.rows[0]?.tips ?? 0), recordedTotalCents, completedOrderCount, averageSaleCents,
    itemsSold: Number(items.rows[0]?.qty ?? '0'),
    refundedCount: Number(refunds.rows[0]?.count ?? '0'), refundedAmountCents }
}

async function dailySummaryHandler(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireReportAccess(req, storeId)
    const date = dateParam(req)
    res.json(await loadDailySummary(storeId, date))
  } catch (reason) { sendApiError(res, reason) }
}
reportsRouter.get('/daily-summary', (req, res) => void dailySummaryHandler(req, res))

export interface ReportOrderSummary {
  id: string
  receiptNumber: string
  time: string
  totalCents: number
  paymentMethod: 'cash' | 'card' | 'split' | 'unknown'
  itemCount: number
  syncStatus: 'synced'
  employeeId: string | null
  cashierName: string | null
  refunded: boolean
}
export interface OrdersPage { orders: ReportOrderSummary[]; next_cursor: string | null }

interface OrdersCursor { time: string; id: string }
function cursorParam(req: Request): OrdersCursor | null {
  const value = req.query.cursor
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length > 160) throw new ApiError(400, 'validation_failed', 'Invalid cursor.')
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw new ApiError(400, 'validation_failed', 'Invalid cursor.') }
  const row = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const { time, id } = row
  if (typeof time !== 'string' || Number.isNaN(Date.parse(time)) || typeof id !== 'string' || !uuid.test(id)) {
    throw new ApiError(400, 'validation_failed', 'Invalid cursor.')
  }
  return { time, id }
}
function limitParam(req: Request): number {
  const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit)
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) throw new ApiError(400, 'validation_failed', 'Limit must be 1 to 200.')
  return rawLimit
}

// Cross-device drill-down for a store's calendar day, newest first — matching RecentOrderSummary's
// own sort order in reporting.ts. Keyset-paginated on (client_generated_at, id) so pages stay stable
// even when two sales share a timestamp; the cursor pattern otherwise mirrors customers.ts's
// cursor()/search() (opaque base64url cursor, limit+1 fetch to compute next_cursor cheaply).
export async function loadOrdersPage(storeId: string, date: string, cursor: OrdersCursor | null, limit: number): Promise<OrdersPage> {
  const { startUtc, endUtc } = await dayBounds(storeId, date)
  const result = await db.query<{
    id: string; receipt_number: string; client_generated_at: string; total_cents: string
    payment_method: string | null; item_count: string; employee_id: string | null; cashier_name: string | null; refunded: boolean
  }>(`
    select o.id, o.receipt_number, o.client_generated_at, o.total_cents::text as total_cents,
      p.method as payment_method, coalesce(oi.qty, 0)::text as item_count,
      o.employee_id, e.name as cashier_name,
      exists (select 1 from public.pos_refunds r where r.store_id=o.store_id and r.order_id=o.id) as refunded
    from public.pos_orders o
    left join (select store_id, order_id, case when count(*)>1 then 'split' else min(method) end as method from public.pos_payments group by store_id, order_id) p on p.store_id = o.store_id and p.order_id = o.id
    left join (select order_id, sum(quantity) as qty from public.pos_order_items where store_id=$1 group by order_id) oi
      on oi.order_id = o.id
    left join public.terminal_employees e on e.store_id = o.store_id and e.id = o.employee_id
    where o.store_id = $1 and o.client_generated_at >= $2 and o.client_generated_at < $3
      and ($4::timestamptz is null or (o.client_generated_at, o.id) < ($4::timestamptz, $5::uuid))
    order by o.client_generated_at desc, o.id desc limit $6`,
    [storeId, startUtc, endUtc, cursor?.time ?? null, cursor?.id ?? null, limit + 1])
  const page = result.rows.slice(0, limit)
  const last = page.at(-1)
  return {
    orders: page.map(row => ({
      id: row.id, receiptNumber: row.receipt_number, time: row.client_generated_at,
      totalCents: Number(row.total_cents), paymentMethod: (row.payment_method as 'cash' | 'card' | 'split' | null) ?? 'unknown',
      itemCount: Number(row.item_count), syncStatus: 'synced',
      employeeId: row.employee_id, cashierName: row.cashier_name, refunded: row.refunded,
    })),
    next_cursor: result.rows.length > limit && last
      ? Buffer.from(JSON.stringify({ time: last.client_generated_at, id: last.id })).toString('base64url')
      : null,
  }
}

async function ordersHandler(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireReportAccess(req, storeId)
    const date = dateParam(req)
    const limit = limitParam(req)
    const cursor = cursorParam(req)
    res.json(await loadOrdersPage(storeId, date, cursor, limit))
  } catch (reason) { sendApiError(res, reason) }
}
reportsRouter.get('/orders', (req, res) => void ordersHandler(req, res))

export interface OversoldProduct { id: string; name: string; sku: string; current_stock: number }

// Server-truth oversell list: pos_stock reflects every accepted sale across all devices, unlike a
// single browser's synced projection.
export async function loadOversold(storeId: string): Promise<OversoldProduct[]> {
  const result = await db.query<OversoldProduct>(`
    select p.id, p.name, p.sku, s.current_stock
    from public.pos_stock s
    join public.pos_products p on p.store_id = s.store_id and p.id = s.product_id
    where s.store_id = $1 and s.current_stock < 0
    order by s.current_stock asc`, [storeId])
  return result.rows
}

async function oversoldHandler(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireReportAccess(req, storeId)
    res.json({ products: await loadOversold(storeId) })
  } catch (reason) { sendApiError(res, reason) }
}
reportsRouter.get('/oversold', (req, res) => void oversoldHandler(req, res))

function dateValue(value: unknown, label: string): string {
  const date = String(value ?? '')
  if (!dateRe.test(date)) throw new ApiError(400, 'validation_failed', `A valid ${label} date (YYYY-MM-DD) is required.`)
  const [year, month, day] = date.split('-').map(Number)
  const asUtc = new Date(Date.UTC(year, month - 1, day))
  if (asUtc.getUTCFullYear() !== year || asUtc.getUTCMonth() !== month - 1 || asUtc.getUTCDate() !== day) {
    throw new ApiError(400, 'validation_failed', `A valid ${label} date (YYYY-MM-DD) is required.`)
  }
  return date
}

export async function reportRange(storeId: string, from: string, to: string) {
  const timezone = await storeTimezone(storeId)
  const start = calendarDayBoundsUtc(from, timezone).startUtc
  const end = calendarDayBoundsUtc(to, timezone).endUtc
  if (Date.parse(start) >= Date.parse(end)) throw new ApiError(400, 'validation_failed', 'The from date must be on or before the to date.')
  if ((Date.parse(end) - Date.parse(start)) / 86_400_000 > 367) throw new ApiError(400, 'validation_failed', 'Report ranges may not exceed 366 days.')
  return { startUtc: start, endUtc: end }
}

function rangeParam(req: Request) {
  return { from: dateValue(req.query.from, 'from'), to: dateValue(req.query.to, 'to') }
}

export interface CustomerReportRow {
  id: string
  name: string
  visitCount: number
  spendCents: number
  lastVisit: string
  pointsBalance: number
  lifetimePoints: number
  tierName: string | null
}

export interface CustomerReport {
  uniqueGuests: number
  returningGuests: number
  newGuests: number
  enrolledGuests: number
  visits: number
  guestRevenueCents: number
  pointsEarned: number
  pointsRedeemed: number
  topGuests: CustomerReportRow[]
}

export async function loadCustomerReport(storeId: string, from: string, to: string): Promise<CustomerReport> {
  const { startUtc, endUtc } = await reportRange(storeId, from, to)
  const [guests, accounts, tiers, loyalty, enrolled, created] = await Promise.all([
    db.query<{
      id: string; name: string; visits: string; spend_cents: string; last_visit: string
    }>(`
      with refunds as (
        select order_id, sum(amount_cents) as amount_cents from public.pos_refunds
        where store_id=$1 group by order_id
      )
      select c.id, c.name, count(o.id)::text as visits,
        coalesce(sum(greatest(o.total_cents-coalesce(r.amount_cents,0),0)),0)::text as spend_cents,
        max(o.client_generated_at)::text as last_visit
      from public.pos_customers c
      join public.pos_orders o on o.store_id=c.store_id and o.customer_id=c.id
        and o.client_generated_at >= $2 and o.client_generated_at < $3
      left join refunds r on r.order_id=o.id
      where c.store_id=$1
      group by c.id, c.name
      order by sum(greatest(o.total_cents-coalesce(r.amount_cents,0),0)) desc, count(o.id) desc, c.name`, [storeId, startUtc, endUtc]),
    db.query<{ customer_id: string; points_balance: number; lifetime_points: number }>(
      'select customer_id, points_balance, lifetime_points from public.loyalty_accounts where store_id=$1', [storeId]),
    db.query<{ name: string; min_lifetime_points: number }>(
      'select name, min_lifetime_points from public.loyalty_tiers where store_id=$1 order by min_lifetime_points desc, name', [storeId]),
    db.query<{ earned: string; redeemed: string }>(`
      select coalesce(sum(case when delta > 0 then delta else 0 end),0)::text as earned,
        coalesce(sum(case when delta < 0 then -delta else 0 end),0)::text as redeemed
      from public.loyalty_point_ledger
      where store_id=$1 and created_at >= $2 and created_at < $3`, [storeId, startUtc, endUtc]),
    db.query<{ count: string }>('select count(*)::text as count from public.loyalty_accounts where store_id=$1', [storeId]),
    db.query<{ count: string }>('select count(*)::text as count from public.pos_customers where store_id=$1 and client_generated_at >= $2 and client_generated_at < $3', [storeId, startUtc, endUtc]),
  ])
  const accountsByCustomer = new Map(accounts.rows.map(row => [row.customer_id, row]))
  const topGuests = guests.rows.map(row => {
    const account = accountsByCustomer.get(row.id)
    const tier = account ? tiers.rows.find(candidate => candidate.min_lifetime_points <= account.lifetime_points) : undefined
    return {
    id: row.id, name: row.name, visitCount: Number(row.visits), spendCents: Number(row.spend_cents),
    lastVisit: row.last_visit, pointsBalance: Number(account?.points_balance ?? 0), lifetimePoints: Number(account?.lifetime_points ?? 0), tierName: tier?.name ?? null,
    }
  })
  return {
    uniqueGuests: topGuests.length,
    returningGuests: topGuests.filter(row => row.visitCount > 1).length,
    newGuests: Number(created.rows[0]?.count ?? 0),
    enrolledGuests: Number(enrolled.rows[0]?.count ?? 0),
    visits: topGuests.reduce((sum, row) => sum + row.visitCount, 0),
    guestRevenueCents: topGuests.reduce((sum, row) => sum + row.spendCents, 0),
    pointsEarned: Number(loyalty.rows[0]?.earned ?? 0),
    pointsRedeemed: Number(loyalty.rows[0]?.redeemed ?? 0),
    topGuests: topGuests.slice(0, 25),
  }
}

async function customerReportHandler(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireReportAccess(req, storeId)
    const { from, to } = rangeParam(req)
    res.json(await loadCustomerReport(storeId, from, to))
  } catch (reason) { sendApiError(res, reason) }
}
reportsRouter.get('/customers', (req, res) => void customerReportHandler(req, res))

export interface InventoryAlertRow {
  id: string
  name: string
  unit: string
  currentStock: number
  reorderThreshold: number | null
}
export interface InventoryExpiryRow {
  id: string
  ingredientName: string
  remainingQuantity: number
  unit: string
  expiresAt: string
}
export interface InventoryWastageRow {
  ingredientId: string
  ingredientName: string
  quantity: number
  unit: string
  valueCents: number
}
export interface InventoryReport {
  lowStockCount: number
  outOfStockCount: number
  expiredBatchCount: number
  expiringBatchCount: number
  wastageQuantity: number
  wastageValueCents: number
  lowStock: InventoryAlertRow[]
  expiringBatches: InventoryExpiryRow[]
  topWastage: InventoryWastageRow[]
}

export async function loadInventoryReport(storeId: string, from: string, to: string): Promise<InventoryReport> {
  const { startUtc, endUtc } = await reportRange(storeId, from, to)
  const [stock, expiry, wastage] = await Promise.all([
    db.query<{ id: string; name: string; unit: string; current_stock: string; reorder_threshold: string | null }>(`
      select i.id, i.name, u.abbreviation as unit, i.current_stock::text as current_stock,
        i.reorder_threshold::text as reorder_threshold
      from public.ingredients i join public.units u on u.store_id=i.store_id and u.id=i.unit_id
      where i.store_id=$1 and i.active=true
        and (i.current_stock <= 0 or (i.reorder_threshold is not null and i.current_stock <= i.reorder_threshold))
      order by case when i.current_stock <= 0 then 0 else 1 end, i.current_stock, i.name`, [storeId]),
    db.query<{ id: string; ingredient_name: string; remaining_quantity: string; unit: string; expires_at: string }>(`
      select b.id, i.name as ingredient_name, b.remaining_quantity::text as remaining_quantity,
        u.abbreviation as unit, b.expires_at::text as expires_at
      from public.ingredient_batches b
      join public.ingredients i on i.store_id=b.store_id and i.id=b.ingredient_id
      join public.units u on u.store_id=i.store_id and u.id=i.unit_id
      where b.store_id=$1 and b.remaining_quantity > 0 and b.expires_at is not null
        and b.expires_at <= now() + interval '7 days'
      order by b.expires_at, i.name`, [storeId]),
    db.query<{ ingredient_id: string; ingredient_name: string; quantity: string; unit: string; value_cents: string }>(`
      select i.id as ingredient_id, i.name as ingredient_name, abs(sum(m.delta))::text as quantity,
        u.abbreviation as unit,
        round(sum(abs(m.delta) * coalesce(b.cost_per_unit_cents, i.cost_per_unit_cents)))::text as value_cents
      from public.stock_movements m
      join public.ingredients i on i.store_id=m.store_id and i.id=m.ingredient_id
      join public.units u on u.store_id=i.store_id and u.id=i.unit_id
      left join public.ingredient_batches b on b.store_id=m.store_id and b.id=m.batch_id
      where m.store_id=$1 and m.reason='wastage' and m.created_at >= $2 and m.created_at < $3
      group by i.id, i.name, u.abbreviation
      order by round(sum(abs(m.delta) * coalesce(b.cost_per_unit_cents, i.cost_per_unit_cents))) desc,
        abs(sum(m.delta)) desc, i.name`, [storeId, startUtc, endUtc]),
  ])
  const lowStock = stock.rows.map(row => ({
    id: row.id, name: row.name, unit: row.unit, currentStock: Number(row.current_stock),
    reorderThreshold: row.reorder_threshold === null ? null : Number(row.reorder_threshold),
  }))
  const expiringBatches = expiry.rows.map(row => ({
    id: row.id, ingredientName: row.ingredient_name, remainingQuantity: Number(row.remaining_quantity), unit: row.unit, expiresAt: row.expires_at,
  }))
  const topWastage = wastage.rows.map(row => ({
    ingredientId: row.ingredient_id, ingredientName: row.ingredient_name, quantity: Number(row.quantity), unit: row.unit, valueCents: Number(row.value_cents),
  }))
  return {
    lowStockCount: lowStock.filter(row => row.currentStock > 0).length,
    outOfStockCount: lowStock.filter(row => row.currentStock <= 0).length,
    expiredBatchCount: expiringBatches.filter(row => Date.parse(row.expiresAt) < Date.now()).length,
    expiringBatchCount: expiringBatches.filter(row => Date.parse(row.expiresAt) >= Date.now()).length,
    wastageQuantity: topWastage.reduce((sum, row) => sum + row.quantity, 0),
    wastageValueCents: topWastage.reduce((sum, row) => sum + row.valueCents, 0),
    lowStock,
    expiringBatches,
    topWastage,
  }
}

async function inventoryReportHandler(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireReportAccess(req, storeId)
    const { from, to } = rangeParam(req)
    res.json(await loadInventoryReport(storeId, from, to))
  } catch (reason) { sendApiError(res, reason) }
}
reportsRouter.get('/inventory', (req, res) => void inventoryReportHandler(req, res))

export interface DishProfitabilityRow {
  productId: string
  name: string
  unitsSold: number
  netRevenueCents: number
  portionCostCents: number
  estimatedFoodCostCents: number
  grossProfitCents: number
  foodCostBps: number | null
  recipeComplete: boolean
}

export interface FoodCostReport {
  netRevenueCents: number
  estimatedFoodCostCents: number
  grossProfitCents: number
  foodCostBps: number | null
  incompleteRecipeCount: number
  dishes: DishProfitabilityRow[]
}

export async function loadFoodCostReport(storeId: string, from: string, to: string): Promise<FoodCostReport> {
  const { startUtc, endUtc } = await reportRange(storeId, from, to)
  const [products, recipeLines, sales] = await Promise.all([
    db.query<{ product_id: string; name: string; recipe_id: string | null; yield_quantity: string | null }>(`
      select p.id as product_id, p.name, r.id as recipe_id, r.yield_quantity::text as yield_quantity
      from public.pos_products p left join public.recipes r on r.store_id=p.store_id and r.product_id=p.id
      where p.store_id=$1 and p.active=true order by p.name`, [storeId]),
    db.query<{
      recipe_id: string; quantity: string; line_unit_id: string; line_kind: RecipeCostUnit['kind']; line_factor: number | null
      ingredient_unit_id: string; ingredient_kind: RecipeCostUnit['kind']; ingredient_factor: number | null; cost_per_unit_cents: number
    }>(`
      select ri.recipe_id, ri.quantity::text as quantity,
        lu.id as line_unit_id, lu.kind as line_kind, lu.factor_to_base::float8 as line_factor,
        iu.id as ingredient_unit_id, iu.kind as ingredient_kind, iu.factor_to_base::float8 as ingredient_factor,
        i.cost_per_unit_cents
      from public.recipe_ingredients ri
      join public.ingredients i on i.store_id=ri.store_id and i.id=ri.ingredient_id
      join public.units lu on lu.store_id=ri.store_id and lu.id=ri.unit_id
      join public.units iu on iu.store_id=i.store_id and iu.id=i.unit_id
      where ri.store_id=$1`, [storeId]),
    db.query<{ product_id: string; units: string; revenue: string }>(`
      select oi.product_id, sum(oi.quantity)::text as units, sum(oi.taxable_cents)::text as revenue
      from public.pos_order_items oi join public.pos_orders o on o.store_id=oi.store_id and o.id=oi.order_id
      where oi.store_id=$1 and o.client_generated_at >= $2 and o.client_generated_at < $3
        and not exists (select 1 from public.pos_refunds r where r.store_id=o.store_id and r.order_id=o.id)
      group by oi.product_id`, [storeId, startUtc, endUtc]),
  ])
  const linesByRecipe = new Map<string, typeof recipeLines.rows>()
  for (const line of recipeLines.rows) linesByRecipe.set(line.recipe_id, [...(linesByRecipe.get(line.recipe_id) ?? []), line])
  const salesByProduct = new Map(sales.rows.map(row => [row.product_id, row]))
  const dishes = products.rows.map(product => {
    const sale = salesByProduct.get(product.product_id)
    const unitsSold = Number(sale?.units ?? 0)
    const netRevenueCents = Number(sale?.revenue ?? 0)
    const lines = product.recipe_id ? linesByRecipe.get(product.recipe_id) ?? [] : []
    // costRecipe throws on a non-positive quantity or yield rather than returning a per-line
    // "unit_mismatch"-style status -- a single malformed recipe (bad historical data, a race with
    // an in-progress edit) must not 500 the whole report and hide every other dish's numbers.
    // Treated exactly like any other uncostable recipe: this dish shows as "Incomplete" instead.
    let recipe: ReturnType<typeof costRecipe> | null = null
    if (product.recipe_id && product.yield_quantity && lines.length) {
      try {
        recipe = costRecipe(lines.map(line => ({ quantity: Number(line.quantity),
          unit: { id: line.line_unit_id, kind: line.line_kind, factorToBase: line.line_factor },
          ingredient: { unit: { id: line.ingredient_unit_id, kind: line.ingredient_kind, factorToBase: line.ingredient_factor }, costPerUnitCents: line.cost_per_unit_cents } })), Number(product.yield_quantity))
      } catch { recipe = null }
    }
    const portionCostCents = recipe?.portionCostCents ?? 0
    const estimatedFoodCostCents = portionCostCents * unitsSold
    return { productId: product.product_id, name: product.name, unitsSold, netRevenueCents, portionCostCents,
      estimatedFoodCostCents, grossProfitCents: netRevenueCents - estimatedFoodCostCents,
      foodCostBps: foodCostBps(estimatedFoodCostCents, netRevenueCents), recipeComplete: Boolean(recipe?.complete) }
  }).sort((a, b) => b.netRevenueCents - a.netRevenueCents || a.name.localeCompare(b.name))
  const netRevenueCents = dishes.reduce((sum, row) => sum + row.netRevenueCents, 0)
  const estimatedFoodCostCents = dishes.reduce((sum, row) => sum + row.estimatedFoodCostCents, 0)
  return { netRevenueCents, estimatedFoodCostCents, grossProfitCents: netRevenueCents - estimatedFoodCostCents,
    foodCostBps: foodCostBps(estimatedFoodCostCents, netRevenueCents), incompleteRecipeCount: dishes.filter(row => !row.recipeComplete).length, dishes }
}

async function foodCostReportHandler(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req); await requireReportAccess(req, storeId)
    const { from, to } = rangeParam(req)
    res.json(await loadFoodCostReport(storeId, from, to))
  } catch (reason) { sendApiError(res, reason) }
}
reportsRouter.get('/food-cost', (req, res) => void foodCostReportHandler(req, res))

export interface KitchenStationPerformance {
  stationId: string | null
  stationName: string
  itemCount: number
  completedCount: number
  openCount: number
  averagePrepSeconds: number | null
  averageServeSeconds: number | null
}
export interface KitchenPerformanceReport { totalItems: number; completedItems: number; averagePrepSeconds: number | null; stations: KitchenStationPerformance[] }

export async function loadKitchenPerformanceReport(storeId: string, from: string, to: string): Promise<KitchenPerformanceReport> {
  const { startUtc, endUtc } = await reportRange(storeId, from, to)
  const result = await db.query<{
    station_id: string | null; station_name: string; item_count: string; completed_count: string; open_count: string
    average_prep_seconds: string | null; average_serve_seconds: string | null
  }>(`
    select kti.station_id, coalesce(ks.name,'Unassigned') as station_name, count(*)::text as item_count,
      count(*) filter (where kti.ready_at is not null)::text as completed_count,
      count(*) filter (where kti.status in ('queued','preparing','ready'))::text as open_count,
      round(avg(extract(epoch from (kti.ready_at-kti.fired_at))) filter (where kti.ready_at is not null and kti.fired_at is not null))::text as average_prep_seconds,
      round(avg(extract(epoch from (kti.served_at-kti.fired_at))) filter (where kti.served_at is not null and kti.fired_at is not null))::text as average_serve_seconds
    from public.kitchen_ticket_items kti
    join public.kitchen_tickets kt on kt.store_id=kti.store_id and kt.id=kti.ticket_id
    left join public.kitchen_stations ks on ks.store_id=kti.store_id and ks.id=kti.station_id
    where kti.store_id=$1 and kt.created_at >= $2 and kt.created_at < $3
    group by kti.station_id, ks.name order by count(*) desc, station_name`, [storeId, startUtc, endUtc])
  const stations = result.rows.map(row => ({ stationId: row.station_id, stationName: row.station_name,
    itemCount: Number(row.item_count), completedCount: Number(row.completed_count), openCount: Number(row.open_count),
    averagePrepSeconds: row.average_prep_seconds === null ? null : Number(row.average_prep_seconds),
    averageServeSeconds: row.average_serve_seconds === null ? null : Number(row.average_serve_seconds) }))
  const completedItems = stations.reduce((sum, row) => sum + row.completedCount, 0)
  const weightedPrep = stations.reduce((sum, row) => sum + (row.averagePrepSeconds ?? 0) * row.completedCount, 0)
  return { totalItems: stations.reduce((sum, row) => sum + row.itemCount, 0), completedItems,
    averagePrepSeconds: completedItems ? Math.round(weightedPrep / completedItems) : null, stations }
}

// --- Profitability -------------------------------------------------------------------------
//
// A consolidated reconciliation report: gross merchandise sales down to gross profit, with tax,
// tips, and service charge kept as separate reference figures (never folded into any margin
// calculation, since their treatment relative to profit is not yet an agreed product decision).
//
// Refund-event policy (explicit, not left implicit): revenue, discounts, and units sold are
// recognized in the calendar day of the ORIGINAL SALE (order.client_generated_at). A refund is
// recognized -- and reduces net merchandise revenue -- in the calendar day of the REFUND ITSELF
// (pos_refunds.created_at), never restated back onto the original sale's day. A refund issued in a
// later period than its sale therefore reduces that LATER period, matching standard point-of-sale
// practice of never rewriting an already-closed period. This is also why a day's net merchandise
// revenue (and gross profit) can legitimately be negative -- e.g. a quiet day whose only activity
// is refunding an earlier day's sale -- and that is reported honestly, not clamped or hidden.
//
// Cost of goods is ESTIMATED from each sold product's current recipe (costRecipe/foodCostBps, the
// same primitives loadFoodCostReport already uses), applied to the quantity actually sold that
// day -- never reduced for a later refund, because refunding a sale does not un-consume the
// ingredients already used to prepare it (kitchen.ts's consumeRecipeIngredients runs once, at
// serve time, and nothing ever reverses it). This is also the fix for the Food Cost report's own
// pre-existing bug this report deliberately does not copy: that query excludes an order's entire
// item set from costing after ANY refund on it, even a one-cent partial one, silently undercounting
// both revenue and cost for the untouched portion of that order. Here, revenue is reduced by
// exactly the refunded amount (pos_refunds.merchandise_cents, store-wide and date-bucketed by
// refund date, never by excluding whole orders), and cost of goods is entirely unaffected by
// refund status, matching physical reality.
//
// `actualCostAdapter` is the integration seam for a teammate's independent batch-cost work: given
// the same (storeId, from, to), it may resolve a Map<productId, actualCostPerUnitCents> to replace
// the recipe estimate per product, or null to mean "not available" (the default,
// noActualCostAdapter, always returns null). Never stubbed with invented numbers: until a real
// adapter is wired in, every response honestly reports costBasis: 'estimated_recipe' and
// actualCostAvailable: false.

export type ActualCostAdapter = (storeId: string, from: string, to: string) => Promise<Map<string, number> | null>
export const noActualCostAdapter: ActualCostAdapter = async () => null

export interface ProfitabilityDay {
  date: string
  grossMerchandiseSalesCents: number
  discountCents: number
  merchandiseRefundsCents: number
  netMerchandiseRevenueCents: number
  estimatedCostOfGoodsCents: number
  /** Share of that day's item revenue covered by a complete cost (recipe or actual), in bps. Null when the day has no item revenue at all. */
  costCoverageBps: number | null
  wastageValueCents: number
  grossProfitCents: number
  wastageAdjustedGrossProfitCents: number
  grossMarginBps: number | null
  taxCents: number
  tipsCents: number
  serviceChargeCents: number
}

export interface ProfitabilityReport {
  from: string
  to: string
  costBasis: 'estimated_recipe' | 'actual_batch'
  actualCostAvailable: boolean
  totals: ProfitabilityDay
  days: ProfitabilityDay[]
}

function marginBps(profitCents: number, revenueCents: number): number | null {
  if (revenueCents <= 0) return null
  return Math.round((profitCents * 10_000) / revenueCents)
}

// Pure calendar-date arithmetic on the already-validated YYYY-MM-DD strings -- no timezone
// conversion here, matching apps/web/src/screens/ReportingScreens.tsx's own shiftDay. Ensures
// every day in [from, to] appears in the trend, even one with zero activity, so a chart has no
// gaps and a quiet day is visibly zero rather than silently missing.
function dateRangeList(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const dates: string[] = []
  let cursor = Date.UTC(fy, fm - 1, fd)
  const end = Date.UTC(ty, tm - 1, td)
  while (cursor <= end) {
    dates.push(new Date(cursor).toISOString().slice(0, 10))
    cursor += 86_400_000
  }
  return dates
}

export async function loadProfitabilityReport(storeId: string, from: string, to: string, actualCostAdapter: ActualCostAdapter = noActualCostAdapter): Promise<ProfitabilityReport> {
  const { startUtc, endUtc } = await reportRange(storeId, from, to)
  const timezone = await storeTimezone(storeId)
  const dates = dateRangeList(from, to)

  const [orderDays, refundDays, tipDays, itemDays, wastageDays, products, recipeLines, actualCosts] = await Promise.all([
    // Order-level figures only -- never joined to order_items/payments in this same query, which
    // would multiply these per-order sums by however many item/payment rows that order has.
    db.query<{ day: string; gross: string; discount: string; tax: string; service_charge: string }>(`
      select (client_generated_at at time zone $4)::date::text as day,
        coalesce(sum(subtotal_cents),0)::text as gross, coalesce(sum(discount_cents),0)::text as discount,
        coalesce(sum(tax_cents),0)::text as tax, coalesce(sum(service_charge_cents),0)::text as service_charge
      from public.pos_orders
      where store_id=$1 and client_generated_at >= $2 and client_generated_at < $3
      group by 1`, [storeId, startUtc, endUtc, timezone]),
    // Refund-event bucketing: by the refund's OWN created_at, not the original order's sale time.
    // pos_refunds already carries its merchandise/tax/tip/service-charge split directly (split-
    // settlement/refund-integrity migrations), so no join to pos_refund_tenders is needed here.
    db.query<{ day: string; merchandise: string; tax: string; tip: string; service_charge: string }>(`
      select (created_at at time zone $4)::date::text as day,
        coalesce(sum(merchandise_cents),0)::text as merchandise, coalesce(sum(tax_cents),0)::text as tax,
        coalesce(sum(tip_cents),0)::text as tip, coalesce(sum(service_charge_cents),0)::text as service_charge
      from public.pos_refunds
      where store_id=$1 and created_at >= $2 and created_at < $3
      group by 1`, [storeId, startUtc, endUtc, timezone]),
    // Tips live on pos_payments (one or more tenders per order, each snapshotting the order's own
    // sale time) -- grouped directly, with no join to pos_orders at all, so a multi-tender split
    // sale can never multiply anything on the orders side.
    db.query<{ day: string; tips: string }>(`
      select (client_generated_at at time zone $4)::date::text as day, coalesce(sum(tip_cents),0)::text as tips
      from public.pos_payments
      where store_id=$1 and client_generated_at >= $2 and client_generated_at < $3
      group by 1`, [storeId, startUtc, endUtc, timezone]),
    // Item-level quantity and revenue (taxable_cents: post-discount, pre-tax, exactly the
    // per-line merchandise revenue basis), by day and product -- grouping at the (day, product)
    // grain means joining to pos_orders only to read its client_generated_at per row, never to sum
    // an order-level column, so this cannot multiply either. Unlike Food Cost's own product list,
    // this is never filtered by a refund existing on the order: see this function's header note.
    db.query<{ day: string; product_id: string; quantity: string; revenue: string }>(`
      select (o.client_generated_at at time zone $4)::date::text as day, oi.product_id,
        sum(oi.quantity)::text as quantity, sum(oi.taxable_cents)::text as revenue
      from public.pos_order_items oi join public.pos_orders o on o.store_id=oi.store_id and o.id=oi.order_id
      where oi.store_id=$1 and o.client_generated_at >= $2 and o.client_generated_at < $3
      group by 1, 2`, [storeId, startUtc, endUtc, timezone]),
    // Same wastage valuation formula as loadInventoryReport's own wastage query (batch cost when
    // known, else the ingredient's current cost), bucketed by day instead of totaled for the range.
    db.query<{ day: string; value: string }>(`
      select (m.created_at at time zone $4)::date::text as day,
        round(sum(abs(m.delta) * coalesce(b.cost_per_unit_cents, i.cost_per_unit_cents)))::text as value
      from public.stock_movements m
      join public.ingredients i on i.store_id=m.store_id and i.id=m.ingredient_id
      left join public.ingredient_batches b on b.store_id=m.store_id and b.id=m.batch_id
      where m.store_id=$1 and m.reason='wastage' and m.created_at >= $2 and m.created_at < $3
      group by 1`, [storeId, startUtc, endUtc, timezone]),
    // Every product ever sold, active or not -- historical sales of a since-deactivated product
    // must still be included, unlike Food Cost's own product list (which is active=true only).
    db.query<{ product_id: string; recipe_id: string | null; yield_quantity: string | null }>(`
      select p.id as product_id, r.id as recipe_id, r.yield_quantity::text as yield_quantity
      from public.pos_products p left join public.recipes r on r.store_id=p.store_id and r.product_id=p.id
      where p.store_id=$1`, [storeId]),
    db.query<{
      recipe_id: string; quantity: string; line_unit_id: string; line_kind: RecipeCostUnit['kind']; line_factor: number | null
      ingredient_unit_id: string; ingredient_kind: RecipeCostUnit['kind']; ingredient_factor: number | null; cost_per_unit_cents: number
    }>(`
      select ri.recipe_id, ri.quantity::text as quantity,
        lu.id as line_unit_id, lu.kind as line_kind, lu.factor_to_base::float8 as line_factor,
        iu.id as ingredient_unit_id, iu.kind as ingredient_kind, iu.factor_to_base::float8 as ingredient_factor,
        i.cost_per_unit_cents
      from public.recipe_ingredients ri
      join public.ingredients i on i.store_id=ri.store_id and i.id=ri.ingredient_id
      join public.units lu on lu.store_id=ri.store_id and lu.id=ri.unit_id
      join public.units iu on iu.store_id=i.store_id and iu.id=i.unit_id
      where ri.store_id=$1`, [storeId]),
    actualCostAdapter(storeId, from, to),
  ])

  const linesByRecipe = new Map<string, typeof recipeLines.rows>()
  for (const line of recipeLines.rows) linesByRecipe.set(line.recipe_id, [...(linesByRecipe.get(line.recipe_id) ?? []), line])
  const estimatedCostByProduct = new Map<string, { cents: number; complete: boolean }>()
  for (const product of products.rows) {
    const lines = product.recipe_id ? linesByRecipe.get(product.recipe_id) ?? [] : []
    // costRecipe throws on a non-positive line quantity/yield rather than returning an uncostable
    // status -- one malformed recipe must not fail this whole report, same guard loadFoodCostReport
    // already uses; treated exactly like any other uncostable recipe (shows as incomplete).
    let recipe: ReturnType<typeof costRecipe> | null = null
    if (product.recipe_id && product.yield_quantity && lines.length) {
      try {
        recipe = costRecipe(lines.map(line => ({ quantity: Number(line.quantity),
          unit: { id: line.line_unit_id, kind: line.line_kind, factorToBase: line.line_factor },
          ingredient: { unit: { id: line.ingredient_unit_id, kind: line.ingredient_kind, factorToBase: line.ingredient_factor }, costPerUnitCents: line.cost_per_unit_cents } })), Number(product.yield_quantity))
      } catch { recipe = null }
    }
    estimatedCostByProduct.set(product.product_id, { cents: recipe?.portionCostCents ?? 0, complete: Boolean(recipe?.complete) })
  }
  const actualCostAvailable = actualCosts !== null
  function costFor(productId: string): { cents: number; complete: boolean } {
    if (actualCostAvailable && actualCosts!.has(productId)) return { cents: actualCosts!.get(productId)!, complete: true }
    return estimatedCostByProduct.get(productId) ?? { cents: 0, complete: false }
  }

  const orderByDay = new Map(orderDays.rows.map(row => [row.day, row]))
  const refundByDay = new Map(refundDays.rows.map(row => [row.day, row]))
  const tipsByDay = new Map(tipDays.rows.map(row => [row.day, row]))
  const wastageByDay = new Map(wastageDays.rows.map(row => [row.day, row]))
  const itemsByDay = new Map<string, typeof itemDays.rows>()
  for (const row of itemDays.rows) itemsByDay.set(row.day, [...(itemsByDay.get(row.day) ?? []), row])

  let totalCostedRevenue = 0, totalItemRevenue = 0
  const days: ProfitabilityDay[] = dates.map(date => {
    const order = orderByDay.get(date)
    const refund = refundByDay.get(date)
    const wastage = wastageByDay.get(date)
    const items = itemsByDay.get(date) ?? []

    const grossMerchandiseSalesCents = Number(order?.gross ?? 0)
    const discountCents = Number(order?.discount ?? 0)
    const merchandiseRefundsCents = Number(refund?.merchandise ?? 0)
    const netMerchandiseRevenueCents = grossMerchandiseSalesCents - discountCents - merchandiseRefundsCents

    let estimatedCostOfGoodsCents = 0, dayCostedRevenue = 0, dayItemRevenue = 0
    for (const item of items) {
      const quantity = Number(item.quantity), revenue = Number(item.revenue)
      dayItemRevenue += revenue
      const cost = costFor(item.product_id)
      estimatedCostOfGoodsCents += cost.cents * quantity
      if (cost.complete) dayCostedRevenue += revenue
    }
    totalCostedRevenue += dayCostedRevenue
    totalItemRevenue += dayItemRevenue

    const wastageValueCents = Number(wastage?.value ?? 0)
    const grossProfitCents = netMerchandiseRevenueCents - estimatedCostOfGoodsCents

    return {
      date, grossMerchandiseSalesCents, discountCents, merchandiseRefundsCents, netMerchandiseRevenueCents,
      estimatedCostOfGoodsCents, costCoverageBps: dayItemRevenue > 0 ? Math.round((dayCostedRevenue * 10_000) / dayItemRevenue) : null,
      wastageValueCents, grossProfitCents, wastageAdjustedGrossProfitCents: grossProfitCents - wastageValueCents,
      grossMarginBps: marginBps(grossProfitCents, netMerchandiseRevenueCents),
      taxCents: Number(order?.tax ?? 0) - Number(refund?.tax ?? 0),
      tipsCents: Number(tipsByDay.get(date)?.tips ?? 0) - Number(refund?.tip ?? 0),
      serviceChargeCents: Number(order?.service_charge ?? 0) - Number(refund?.service_charge ?? 0),
    }
  })

  const zero = (field: Exclude<keyof ProfitabilityDay, 'date' | 'costCoverageBps' | 'grossMarginBps'>) => days.reduce((sum, day) => sum + day[field], 0)
  const totalNetRevenue = zero('netMerchandiseRevenueCents')
  const totalGrossProfit = zero('grossProfitCents')
  const totals: ProfitabilityDay = {
    date: `${from}..${to}`,
    grossMerchandiseSalesCents: zero('grossMerchandiseSalesCents'),
    discountCents: zero('discountCents'),
    merchandiseRefundsCents: zero('merchandiseRefundsCents'),
    netMerchandiseRevenueCents: totalNetRevenue,
    estimatedCostOfGoodsCents: zero('estimatedCostOfGoodsCents'),
    // Recomputed from the whole range's costed/total item revenue, not an average of per-day bps
    // (which would weight a zero-revenue day the same as the store's busiest day).
    costCoverageBps: totalItemRevenue > 0 ? Math.round((totalCostedRevenue * 10_000) / totalItemRevenue) : null,
    wastageValueCents: zero('wastageValueCents'),
    grossProfitCents: totalGrossProfit,
    wastageAdjustedGrossProfitCents: zero('wastageAdjustedGrossProfitCents'),
    grossMarginBps: marginBps(totalGrossProfit, totalNetRevenue),
    taxCents: zero('taxCents'),
    tipsCents: zero('tipsCents'),
    serviceChargeCents: zero('serviceChargeCents'),
  }

  return { from, to, costBasis: actualCostAvailable ? 'actual_batch' : 'estimated_recipe', actualCostAvailable, totals, days }
}

async function profitabilityReportHandler(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req); await requireReportAccess(req, storeId)
    const { from, to } = rangeParam(req)
    res.json(await loadProfitabilityReport(storeId, from, to))
  } catch (reason) { sendApiError(res, reason) }
}
reportsRouter.get('/profitability', (req, res) => void profitabilityReportHandler(req, res))

async function kitchenPerformanceHandler(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req); await requireReportAccess(req, storeId)
    const { from, to } = rangeParam(req)
    res.json(await loadKitchenPerformanceReport(storeId, from, to))
  } catch (reason) { sendApiError(res, reason) }
}
reportsRouter.get('/kitchen-performance', (req, res) => void kitchenPerformanceHandler(req, res))
