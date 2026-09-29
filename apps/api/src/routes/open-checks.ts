import { createHash, randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { ApiError, requireStoreMember, sendApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'
import { applyTableStatusTransition } from './floor.js'
import { createPaidOrder, type ValidatedOperation } from './orders.js'
import { boundedInteger, calculateDiscountedLine, calculateServiceCharge, discountNeedsManagerApproval, MAX_CENTS, sumDiscountedLines, type LineDiscount } from '../../../../packages/domain/src/money.js'
import { ORDER_TYPES, type OrderType } from '../../../../packages/domain/src/order-type.js'
import { canTransitionOpenCheck, isOpenCheckEditable, type OpenCheckStatus } from '../../../../packages/domain/src/open-check.js'

export const openChecksRouter = Router()
export const terminalOpenChecksRouter = Router()

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type JsonRecord = Record<string, unknown>

export function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'validation_failed', `${name} is required.`)
  return value as JsonRecord
}
export function text(value: unknown, name: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(422, 'validation_failed', `${name} is invalid.`)
  return value
}
export function id(value: unknown, name: string): string {
  const result = text(value, name, 36)
  if (!uuid.test(result)) throw new ApiError(422, 'validation_failed', `${name} must be a UUID.`)
  return result
}
export function optionalId(value: unknown, name: string): string | null {
  return value === null || value === undefined ? null : id(value, name)
}
function cents(value: unknown, name: string, max = MAX_CENTS): number {
  try { return boundedInteger(value as number, name, 0, max) }
  catch { throw new ApiError(422, 'validation_failed', `${name} must be valid integer cents.`) }
}
function timestamp(value: unknown, name: string): string {
  const result = text(value, name, 40)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new ApiError(422, 'validation_failed', `${name} must be a valid UTC timestamp.`)
  }
  return result
}
export function orderTypeValue(value: unknown): OrderType {
  if (value === null || value === undefined) return 'dine_in'
  if (typeof value !== 'string' || !ORDER_TYPES.includes(value as OrderType)) throw new ApiError(422, 'validation_failed', 'Order type is invalid.')
  return value as OrderType
}
export function versionValue(value: unknown, name = 'expected_version'): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ApiError(422, 'validation_failed', `${name} must be a positive integer.`)
  return value as number
}
// service_charge_bps travels with the check the same way an order snapshots its rate at checkout
// (orders.ts's validateOperation) -- the rate in effect when the line was rung up, re-derived into
// cents server-side, not independently re-fetched from the store's live setting.
export function serviceChargeBpsValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) throw new ApiError(422, 'validation_failed', 'service_charge_bps is invalid.')
  return value as number
}

async function requireCheckAccess(req: Request, storeId: string, terminal: boolean): Promise<{ employeeId: string | null }> {
  if (terminal) {
    const session = await requireCashierTerminal(req, db)
    if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    return { employeeId: session.employeeId }
  }
  await requireStoreMember(req, storeId)
  return { employeeId: null }
}

function isUniqueViolation(reason: unknown): boolean {
  return Boolean(reason && typeof reason === 'object' && 'code' in reason && (reason as { code?: string }).code === '23505')
}

// --- item parsing, shared by create/edit ------------------------------------------------------
// Same trust model orders.ts's validateOperation already uses: the terminal is trusted hardware,
// so a snapshotted price/tax is accepted as given rather than re-derived from the live catalog on
// every keystroke -- the server's own job here is only to (a) prove the line math is internally
// consistent (calculateDiscountedLine, not whatever the client claims) and (b) prove the product
// actually belongs to this store, both enforced in editOpenCheckCore below.

function parseDiscount(item: JsonRecord, label: string): LineDiscount {
  const kind = item.discount_kind
  if (kind === null || kind === undefined) {
    if (item.discount_value !== null && item.discount_value !== undefined) throw new ApiError(422, 'validation_failed', `${label} discount value must be empty when no discount is applied.`)
    return null
  }
  if (kind !== 'percent' && kind !== 'fixed') throw new ApiError(422, 'validation_failed', `${label} discount kind is invalid.`)
  if (!Number.isSafeInteger(item.discount_value) || (item.discount_value as number) < 0) throw new ApiError(422, 'validation_failed', `${label} discount value is invalid.`)
  return kind === 'percent' ? { kind: 'percent', bps: item.discount_value as number } : { kind: 'fixed', cents: item.discount_value as number }
}

function parseItemModifiers(item: JsonRecord, label: string) {
  const raw = item.modifiers
  if (raw === undefined || raw === null) return [] as { option_id: string; group_name: string; option_name: string; price_delta_cents: number }[]
  if (!Array.isArray(raw) || raw.length > 50) throw new ApiError(422, 'validation_failed', `${label} modifiers are invalid.`)
  const rows = raw.map((value, index) => {
    const modifier = record(value, `${label} modifier ${index + 1}`)
    const delta = modifier.price_delta_cents
    if (!Number.isSafeInteger(delta) || (delta as number) < -MAX_CENTS || (delta as number) > MAX_CENTS) throw new ApiError(422, 'validation_failed', `${label} modifier price is invalid.`)
    return { option_id: id(modifier.option_id, 'Modifier option ID'), group_name: text(modifier.group_name, 'Modifier group', 60),
      option_name: text(modifier.option_name, 'Modifier option', 60), price_delta_cents: delta as number }
  })
  if (new Set(rows.map(row => row.option_id)).size !== rows.length) throw new ApiError(422, 'validation_failed', `${label} contains a duplicate modifier option.`)
  return rows
}

export interface ParsedCheckItem {
  id: string; productId: string; snapshotName: string; snapshotSku: string; snapshotPriceCents: number
  snapshotTaxBps: number; catalogVersion: number; quantity: number; discount: LineDiscount
  modifiers: { option_id: string; group_name: string; option_name: string; price_delta_cents: number }[]
  line: ReturnType<typeof calculateDiscountedLine>
}

export function parseCheckItems(raw: unknown): ParsedCheckItem[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) throw new ApiError(422, 'validation_failed', 'A check needs 1 to 100 items.')
  const items = raw.map((rawItem, index) => {
    const item = record(rawItem, `Item ${index + 1}`)
    const label = `Item ${index + 1}`
    if (!Number.isSafeInteger(item.catalog_version) || (item.catalog_version as number) < 1) throw new ApiError(422, 'validation_failed', `${label} catalog version is invalid.`)
    const price = cents(item.snapshot_price_cents, 'Unit price')
    const discount = parseDiscount(item, label)
    let line: ReturnType<typeof calculateDiscountedLine>
    try { line = calculateDiscountedLine(price, item.quantity as number, item.snapshot_tax_bps as number, discount) }
    catch { throw new ApiError(422, 'validation_failed', `${label} has an invalid quantity, tax rate or discount.`) }
    return {
      id: item.id === undefined || item.id === null ? randomUUID() : id(item.id, `${label} ID`),
      productId: id(item.product_id, `${label} product ID`),
      snapshotName: text(item.snapshot_name, `${label} name`),
      snapshotSku: text(item.snapshot_sku, `${label} SKU`, 80),
      snapshotPriceCents: price,
      snapshotTaxBps: item.snapshot_tax_bps as number,
      catalogVersion: item.catalog_version as number,
      quantity: item.quantity as number,
      discount,
      modifiers: parseItemModifiers(item, label),
      line,
    }
  })
  if (new Set(items.map(item => item.id)).size !== items.length) throw new ApiError(422, 'validation_failed', 'Item IDs must be unique within a check.')
  return items
}

// =================================================================================================
// Core operations -- exported, req/res-free, directly testable against PGlite (same shape as
// floor.ts's applyTableStatusTransition/moveTableParty). Each thin HTTP handler below only parses
// the request and resolves the caller's identity/authorization, then delegates here.
// =================================================================================================

export interface CreateOpenCheckParams { orderType: OrderType; tableId: string | null; customerId: string | null; employeeId: string | null }

export async function createOpenCheckCore(storeId: string, params: CreateOpenCheckParams) {
  const client = await db.connect()
  try {
    await client.query('begin')
    if (params.tableId) {
      // A check can only be opened against a table that's seated or already taking orders --
      // prevents opening a second tab on a table mid-service (the partial unique index below is
      // the hard backstop). Web's Floor screen already runs its own seated->ordering transition
      // the moment "Add order" is tapped, before the register (and this call) is ever reached, so
      // 'ordering' has to be accepted as-is here, not re-transitioned into; a 'seated' table (a
      // check opened some other way, without going through Floor's Add-order step first) still
      // gets that same transition, just from here instead.
      const current = await client.query<{ status: string }>('select status from public.restaurant_tables where store_id=$1 and id=$2 and active=true', [storeId, params.tableId])
      if (!current.rows[0]) throw new ApiError(404, 'table_not_found', 'Table not found in this store.')
      if (current.rows[0].status === 'seated') {
        const table = await applyTableStatusTransition(storeId, params.tableId, 'seated', 'ordering')
        if (!table) throw new ApiError(409, 'invalid_transition', 'This table changed since it was last loaded.')
      } else if (current.rows[0].status !== 'ordering') {
        throw new ApiError(409, 'invalid_transition', `Table must be seated or already taking orders before opening a check (currently ${current.rows[0].status}).`)
      }
    }
    const result = await client.query(
      `insert into public.open_checks(store_id, order_type, table_id, customer_id, employee_id)
       values ($1,$2,$3,$4,$5)
       returning id, store_id, status, order_type, table_id, customer_id, employee_id, manager_id, manager_approved_at,
                 version, subtotal_cents, discount_cents, tax_cents, service_charge_cents, total_cents, notes, opened_at, updated_at`,
      [storeId, params.orderType, params.tableId, params.customerId, params.employeeId],
    )
    await client.query('commit')
    return { check: result.rows[0], items: [] as unknown[] }
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    if (isUniqueViolation(reason)) throw new ApiError(409, 'table_already_open', 'This table already has an open check.')
    throw reason
  } finally { client.release() }
}

export async function loadCheckDetail(storeId: string, checkId: string) {
  const checkRes = await db.query(
    `select id, store_id, status, order_type, table_id, customer_id, employee_id, manager_id, manager_approved_at,
            version, subtotal_cents::text, discount_cents::text, tax_cents::text, service_charge_cents::text,
            total_cents::text, notes, opened_at, updated_at, closed_at, closed_order_id, voided_at, voided_by_employee_id
     from public.open_checks where store_id=$1 and id=$2`,
    [storeId, checkId],
  )
  const check = checkRes.rows[0]
  if (!check) return null
  const [itemsRes, modifiersRes] = await Promise.all([
    db.query(
      `select id, product_id, snapshot_name, snapshot_sku, snapshot_price_cents::text, snapshot_tax_bps, catalog_version,
              quantity, discount_kind, discount_value, subtotal_cents::text, discount_applied_cents::text,
              taxable_cents::text, tax_cents::text, total_cents::text
       from public.open_check_items where store_id=$1 and check_id=$2 order by added_at`,
      [storeId, checkId],
    ),
    db.query(
      `select cim.check_item_id, cim.snapshot_group_name, cim.snapshot_option_name, cim.price_delta_cents
       from public.open_check_item_modifiers cim
       join public.open_check_items i on i.store_id=cim.store_id and i.id=cim.check_item_id
       where cim.store_id=$1 and i.check_id=$2`,
      [storeId, checkId],
    ),
  ])
  const modifiersByItem = new Map<string, unknown[]>()
  for (const modifier of modifiersRes.rows as { check_item_id: string; snapshot_group_name: string; snapshot_option_name: string; price_delta_cents: number }[]) {
    const list = modifiersByItem.get(modifier.check_item_id) ?? []
    list.push({ group_name: modifier.snapshot_group_name, option_name: modifier.snapshot_option_name, price_delta_cents: modifier.price_delta_cents })
    modifiersByItem.set(modifier.check_item_id, list)
  }
  return {
    check: { ...check, subtotal_cents: Number(check.subtotal_cents), discount_cents: Number(check.discount_cents),
      tax_cents: Number(check.tax_cents), service_charge_cents: Number(check.service_charge_cents), total_cents: Number(check.total_cents) },
    items: (itemsRes.rows as Record<string, unknown>[]).map(item => ({ ...item,
      snapshot_price_cents: Number(item.snapshot_price_cents), subtotal_cents: Number(item.subtotal_cents),
      discount_applied_cents: Number(item.discount_applied_cents), taxable_cents: Number(item.taxable_cents),
      tax_cents: Number(item.tax_cents), total_cents: Number(item.total_cents), modifiers: modifiersByItem.get(item.id as string) ?? [] })),
  }
}

// The client always sends its complete current line list, same "full replace-on-save" shape the
// catalog's recipe builder already uses -- simpler and safer than a patch-style add/remove/update
// protocol for something edited freely across many short round trips. expectedVersion is an
// atomic compare-and-swap, the same primitive applyTableStatusTransition uses for table status:
// a stale save is rejected with the check's real current version rather than silently overwriting
// someone else's more recent edit.
export interface EditOpenCheckParams {
  expectedVersion: number; items: ParsedCheckItem[]; serviceChargeBps: number
  notes: string | null; customerId: string | null; managerId: string | null; managerApprovedAt: string | null
}

export async function editOpenCheckCore(storeId: string, checkId: string, params: EditOpenCheckParams) {
  if ((params.managerId === null) !== (params.managerApprovedAt === null)) throw new ApiError(422, 'validation_failed', 'Manager approval evidence is incomplete.')
  const needsApproval = params.items.some(item => discountNeedsManagerApproval(item.line.subtotalCents, item.line.discountAppliedCents))
  if (needsApproval && params.managerId === null) throw new ApiError(422, 'validation_failed', 'A discount on this check requires manager approval.')

  const client = await db.connect()
  try {
    await client.query('begin')
    const lockRes = await client.query<{ status: OpenCheckStatus; version: number }>(
      'select status, version from public.open_checks where store_id=$1 and id=$2 for update', [storeId, checkId])
    const current = lockRes.rows[0]
    if (!current) throw new ApiError(404, 'not_found', 'Open check not found in this store.')
    if (!isOpenCheckEditable(current.status)) throw new ApiError(409, 'check_closed', `This check is ${current.status} and can no longer be edited.`)
    if (current.version !== params.expectedVersion) throw new ApiError(409, 'status_conflict', `This check changed since it was last loaded (now at version ${current.version}).`)

    if (params.managerId) {
      const manager = await client.query("select 1 from public.terminal_employees where store_id=$1 and id=$2 and role='manager' and active=true", [storeId, params.managerId])
      if (!manager.rowCount) throw new ApiError(422, 'validation_failed', 'Manager approval references an employee who is not an active manager for this store.')
    }
    const productIds = [...new Set(params.items.map(item => item.productId))]
    const products = await client.query('select id from public.pos_products where store_id=$1 and id = any($2::uuid[])', [storeId, productIds])
    if (products.rowCount !== productIds.length) throw new ApiError(422, 'cross_store_reference', 'An item refers to a product outside this store.')
    if (params.customerId) {
      const customer = await client.query('select 1 from public.pos_customers where store_id=$1 and id=$2', [storeId, params.customerId])
      if (!customer.rowCount) throw new ApiError(422, 'validation_failed', 'Customer not found in this store.')
    }

    const totals = sumDiscountedLines(params.items.map(item => item.line))
    const serviceChargeCents = calculateServiceCharge(totals.subtotalCents - totals.discountCents, params.serviceChargeBps)
    const grandTotal = totals.totalCents + serviceChargeCents

    await client.query('delete from public.open_check_items where store_id=$1 and check_id=$2', [storeId, checkId])
    for (const item of params.items) {
      await client.query(
        `insert into public.open_check_items(id,store_id,check_id,product_id,snapshot_name,snapshot_sku,snapshot_price_cents,
           snapshot_tax_bps,catalog_version,quantity,discount_kind,discount_value,subtotal_cents,discount_applied_cents,
           taxable_cents,tax_cents,total_cents)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [item.id, storeId, checkId, item.productId, item.snapshotName, item.snapshotSku, item.snapshotPriceCents,
          item.snapshotTaxBps, item.catalogVersion, item.quantity, item.discount?.kind ?? null,
          item.discount ? (item.discount.kind === 'percent' ? item.discount.bps : item.discount.cents) : null,
          item.line.subtotalCents, item.line.discountAppliedCents, item.line.taxableCents, item.line.taxCents, item.line.totalCents],
      )
      for (const modifier of item.modifiers) {
        await client.query(
          `insert into public.open_check_item_modifiers(store_id,check_item_id,snapshot_group_name,snapshot_option_name,price_delta_cents)
           values ($1,$2,$3,$4,$5)`,
          [storeId, item.id, modifier.group_name, modifier.option_name, modifier.price_delta_cents],
        )
      }
    }
    await client.query(
      `update public.open_checks set version = version + 1, subtotal_cents=$3, discount_cents=$4, tax_cents=$5,
         service_charge_cents=$6, total_cents=$7, notes=$8, customer_id=$9, manager_id=$10, manager_approved_at=$11, updated_at=now()
       where store_id=$1 and id=$2`,
      [storeId, checkId, totals.subtotalCents, totals.discountCents, totals.taxCents, serviceChargeCents, grandTotal,
        params.notes, params.customerId, params.managerId, params.managerApprovedAt],
    )
    await client.query('commit')
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    throw reason
  } finally { client.release() }
  const detail = await loadCheckDetail(storeId, checkId)
  if (!detail) throw new ApiError(404, 'not_found', 'Open check not found in this store.')
  return detail
}

export async function voidOpenCheckCore(storeId: string, checkId: string, expectedVersion: number, voidedByEmployeeId: string | null) {
  const client = await db.connect()
  let tableId: string | null = null
  let outcome: 'voided' | 'already_voided'
  try {
    await client.query('begin')
    const lockRes = await client.query<{ status: OpenCheckStatus; version: number; table_id: string | null }>(
      'select status, version, table_id from public.open_checks where store_id=$1 and id=$2 for update', [storeId, checkId])
    const current = lockRes.rows[0]
    if (!current) throw new ApiError(404, 'not_found', 'Open check not found in this store.')
    if (current.status === 'voided') { await client.query('commit'); return { status: 'already_voided' as const } }
    if (!canTransitionOpenCheck(current.status, 'voided')) throw new ApiError(409, 'check_closed', `This check is ${current.status} and can no longer be voided.`)
    if (current.version !== expectedVersion) throw new ApiError(409, 'status_conflict', `This check changed since it was last loaded (now at version ${current.version}).`)

    await client.query(
      `update public.open_checks set status='voided', voided_at=now(), voided_by_employee_id=$3, version=version+1
       where store_id=$1 and id=$2`,
      [storeId, checkId, voidedByEmployeeId],
    )
    await client.query('commit')
    tableId = current.table_id
    outcome = 'voided'
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    throw reason
  } finally { client.release() }
  if (tableId) {
    // Best-effort: release the table back to the floor. Non-blocking -- a stale table status is a
    // Floor-screen cosmetic issue, never a reason to fail (or roll back) a void that already
    // committed. Only fires if the table is still where this check left it; otherwise a manager has
    // already moved it on by hand and this silently does nothing (same reasoning kitchen.ts's
    // served-table hook uses).
    applyTableStatusTransition(storeId, tableId, 'ordering', 'available').catch(() => undefined)
  }
  return { status: outcome }
}

// Turns a durable, editable open check into a real, immutable paid order -- the exact same
// creation path (kitchen ticket, payment, loyalty, stock, change feed, operation ledger) push()
// already uses for a normal register sale, via the shared createPaidOrder in orders.ts. The
// `for update` lock on the open_checks row plus the status check below is what makes "two
// simultaneous close attempts produce one paid order" true regardless of whether the two requests
// share a client-generated operation_id: whichever transaction commits first flips the row to
// 'closed'; the other blocks on the lock, then sees 'closed' once it proceeds and returns the
// order that already exists instead of creating a second one.
export interface CloseOpenCheckParams {
  operationId: string; expectedVersion: number; receiptNumber: string; catalogVersion: number
  clientGeneratedAt: string; serviceChargeBps: number
  // A2: one or more tenders -- cash+card split, itemized, per-seat, or simply the one payment a
  // non-splitting close has always sent (a single-element array works identically).
  payments: { id: string; method: 'cash' | 'card'; amountCents: number; tenderedCents: number; changeCents: number; tipCents: number; reference: string | null }[]
  employeeIdOverride: string | null; loyaltyRedemptionRewardRuleId: string | null
}

export async function closeOpenCheckCore(storeId: string, checkId: string, params: CloseOpenCheckParams, payloadHash: string) {
  const client = await db.connect()
  let tableId: string | null = null
  let result: unknown
  try {
    await client.query('begin')
    await client.query('insert into public.pos_sync_feed_state(store_id) values ($1) on conflict do nothing', [storeId])
    await client.query('select last_position from public.pos_sync_feed_state where store_id = $1 for update', [storeId])

    const replay = await client.query('select payload_hash,result_json from public.pos_operation_ledger where store_id=$1 and operation_id=$2', [storeId, params.operationId])
    if (replay.rows[0]) {
      if (replay.rows[0].payload_hash !== payloadHash) throw new ApiError(409, 'operation_id_conflict', 'This operation ID was used for another sale.')
      await client.query('commit')
      return replay.rows[0].result_json
    }

    const checkRes = await client.query(
      `select status, version, order_type, table_id, customer_id, employee_id, manager_id, manager_approved_at, closed_order_id
       from public.open_checks where store_id=$1 and id=$2 for update`,
      [storeId, checkId],
    )
    const check = checkRes.rows[0]
    if (!check) throw new ApiError(404, 'not_found', 'Open check not found in this store.')
    if (check.status === 'voided') throw new ApiError(409, 'check_voided', 'This check was voided and cannot be closed.')
    if (check.status === 'closed') {
      // Idempotent even without a matching operation_id: a second close attempt (a different
      // client-generated id, a retried tap from a different device) that arrives after the first
      // already committed sees the sale that already happened rather than erroring or re-selling.
      await client.query('commit')
      return { status: 'already_closed', operation_id: check.closed_order_id }
    }
    if (check.version !== params.expectedVersion) throw new ApiError(409, 'status_conflict', `This check changed since it was last loaded (now at version ${check.version}).`)

    const itemsRes = await client.query(
      `select id, product_id, snapshot_name, snapshot_sku, snapshot_price_cents, snapshot_tax_bps, catalog_version,
              quantity, discount_kind, discount_value
       from public.open_check_items where store_id=$1 and check_id=$2 order by added_at`,
      [storeId, checkId],
    )
    if (!itemsRes.rowCount) throw new ApiError(422, 'validation_failed', 'This check has no items to close.')
    const modifiersRes = await client.query(
      `select cim.check_item_id, cim.snapshot_group_name, cim.snapshot_option_name, cim.price_delta_cents
       from public.open_check_item_modifiers cim where cim.store_id=$1 and cim.check_item_id = any($2::uuid[])`,
      [storeId, itemsRes.rows.map(row => row.id)],
    )
    const modifiersByItem = new Map<string, { option_id: string; group_name: string; option_name: string; price_delta_cents: number }[]>()
    for (const modifier of modifiersRes.rows as { check_item_id: string; snapshot_group_name: string; snapshot_option_name: string; price_delta_cents: number }[]) {
      const list = modifiersByItem.get(modifier.check_item_id) ?? []
      list.push({ option_id: modifier.check_item_id, group_name: modifier.snapshot_group_name, option_name: modifier.snapshot_option_name, price_delta_cents: modifier.price_delta_cents })
      modifiersByItem.set(modifier.check_item_id, list)
    }

    const parsedItems = (itemsRes.rows as Record<string, unknown>[]).map(row => {
      const price = Number(row.snapshot_price_cents)
      const discount: LineDiscount = row.discount_kind === 'percent' ? { kind: 'percent', bps: Number(row.discount_value) }
        : row.discount_kind === 'fixed' ? { kind: 'fixed', cents: Number(row.discount_value) } : null
      const line = calculateDiscountedLine(price, Number(row.quantity), Number(row.snapshot_tax_bps), discount)
      const modifiers = modifiersByItem.get(row.id as string) ?? []
      const modifierTotal = modifiers.reduce((sum, modifier) => sum + modifier.price_delta_cents, 0)
      return {
        id: row.id as string, product_id: row.product_id as string, snapshot_name: row.snapshot_name as string, snapshot_sku: row.snapshot_sku as string,
        snapshot_price_cents: price, base_price_cents: price - modifierTotal, modifiers, modifiers_supplied: true,
        snapshot_tax_bps: Number(row.snapshot_tax_bps), catalog_version: Number(row.catalog_version), quantity: Number(row.quantity),
        discount_kind: row.discount_kind as 'percent' | 'fixed' | null, discount_value: row.discount_value === null ? null : Number(row.discount_value),
        subtotal_cents: line.subtotalCents, discount_applied_cents: line.discountAppliedCents, taxable_cents: line.taxableCents,
        tax_cents: line.taxCents, total_cents: line.totalCents,
        // Open checks don't yet support adding a combo product to a check (A1/A4 were built in
        // parallel, never integrated) -- every open-check item is a plain product line.
        combo_selection: null,
      }
    })
    const totals = sumDiscountedLines(parsedItems.map(item => ({ subtotalCents: item.subtotal_cents, discountAppliedCents: item.discount_applied_cents,
      taxableCents: item.taxable_cents, taxCents: item.tax_cents, totalCents: item.total_cents })))
    const serviceChargeCents = calculateServiceCharge(totals.subtotalCents - totals.discountCents, params.serviceChargeBps)
    const grandTotalCents = totals.totalCents + serviceChargeCents

    const needsApproval = parsedItems.some(item => discountNeedsManagerApproval(item.subtotal_cents, item.discount_applied_cents))
    if (needsApproval && !check.manager_id) throw new ApiError(422, 'validation_failed', 'A discount on this check requires manager approval before it can be closed.')

    if (!params.payments.length || params.payments.length > 20) throw new ApiError(422, 'validation_failed', 'A check needs 1 to 20 tenders to close.')
    for (const payment of params.payments) {
      if (payment.amountCents === 0 && payment.tipCents > 0) throw new ApiError(422, 'validation_failed', 'A tip must belong to a positive sale allocation.')
      if ((payment.method === 'cash' && payment.tenderedCents !== payment.amountCents + payment.tipCents + payment.changeCents) ||
          (payment.method === 'card' && (payment.tenderedCents !== payment.amountCents + payment.tipCents || payment.changeCents !== 0))) {
        throw new ApiError(422, 'total_mismatch', 'A tender does not balance.')
      }
    }
    if (new Set(params.payments.map(payment => payment.id)).size !== params.payments.length) throw new ApiError(422, 'validation_failed', 'Tender IDs must be unique.')
    if (params.payments.reduce((sum, payment) => sum + payment.amountCents, 0) !== grandTotalCents) {
      throw new ApiError(422, 'total_mismatch', 'Payments do not balance with the check.')
    }
    if (params.loyaltyRedemptionRewardRuleId && !check.customer_id) throw new ApiError(422, 'validation_failed', 'Loyalty redemption requires a guest on this check.')

    const operation: ValidatedOperation = {
      operationId: params.operationId, storeId, items: parsedItems, totals: { ...totals, totalCents: grandTotalCents }, serviceChargeCents,
      loyaltyRedemption: params.loyaltyRedemptionRewardRuleId ? { rewardRuleId: params.loyaltyRedemptionRewardRuleId } : null,
      // Open checks never carry delivery orders (check.order_type is always dine_in/takeaway) --
      // matches orders.ts's own "null unless order_type is delivery" convention for this field.
      deliveryDetails: null,
      order: { customer_id: check.customer_id, receipt_number: params.receiptNumber, catalog_version: params.catalogVersion,
        order_type: check.order_type, table_id: check.table_id, client_generated_at: params.clientGeneratedAt,
        employee_id: params.employeeIdOverride ?? check.employee_id, manager_id: check.manager_id, manager_approved_at: check.manager_approved_at },
      payments: params.payments.map(payment => ({ id: payment.id, method: payment.method, amount_cents: payment.amountCents,
        tendered_cents: payment.tenderedCents, change_cents: payment.changeCents, tip_cents: payment.tipCents, reference: payment.reference })),
    }

    result = await createPaidOrder(client, operation, payloadHash)
    await client.query(
      `update public.open_checks set status='closed', closed_at=now(), closed_order_id=$3, version=version+1 where store_id=$1 and id=$2`,
      [storeId, checkId, params.operationId],
    )
    await client.query('commit')
    tableId = check.table_id
  } catch (reason) {
    await client.query('rollback').catch(() => undefined)
    throw reason
  } finally { client.release() }
  if (tableId) {
    const releaseFrom = await db.query('select status from public.restaurant_tables where store_id=$1 and id=$2 and active=true', [storeId, tableId])
    const status = releaseFrom.rows[0]?.status
    if (status && ['ordering', 'served', 'bill_requested'].includes(status)) {
      applyTableStatusTransition(storeId, tableId, status, 'dirty').catch(() => undefined)
    }
  }
  return result
}

// =================================================================================================
// Thin HTTP handlers -- request parsing and auth only, manual-QA-only same as every other route
// file's HTTP layer in this codebase (see floor.test.ts's comment on applyTableStatusTransition).
// =================================================================================================

// Parses only the *shape* of one or more tenders (id/method/amounts) -- the balance-against-the-
// check-total check happens in closeOpenCheckCore, which is the only place that actually knows
// the check's real total (computed fresh from its stored items, not trusted from the request).
interface ParsedClosePayment { id: string; method: 'cash' | 'card'; amountCents: number; tenderedCents: number; changeCents: number; tipCents: number; reference: string | null }
function parseClosePayment(raw: unknown, label: string): ParsedClosePayment {
  const payment = record(raw, label)
  const method = payment.method
  if (method !== 'cash' && method !== 'card') throw new ApiError(422, 'validation_failed', `${label} method is invalid.`)
  const amountCents = cents(payment.amount_cents, `${label} amount`)
  const tenderedCents = cents(payment.tendered_cents, `${label} tendered amount`)
  const changeCents = cents(payment.change_cents, `${label} change amount`)
  const tipCents = payment.tip_cents === undefined || payment.tip_cents === null ? 0 : cents(payment.tip_cents, `${label} tip`)
  const reference = payment.reference === null || payment.reference === undefined ? null : text(payment.reference, `${label} reference`, 120)
  return { id: id(payment.id, `${label} ID`), method, amountCents, tenderedCents, changeCents, tipCents, reference }
}
function parseClosePayments(body: JsonRecord) {
  const rawList = body.payments
  const rawSingle = body.payment
  if (rawList !== undefined && rawSingle !== undefined) throw new ApiError(422, 'validation_failed', 'Send either payment or payments, not both.')
  if (rawList !== undefined && !Array.isArray(rawList)) throw new ApiError(422, 'validation_failed', 'Payments must be a list.')
  if (Array.isArray(rawList)) return rawList.map((raw, index) => parseClosePayment(raw, `Tender ${index + 1}`))
  const legacy = record(rawSingle, 'Payment')
  return [parseClosePayment({ ...legacy, id: legacy.id ?? randomUUID() }, 'Payment')]
}

// The check's customer_id (needed to validate a redemption actually has a guest to redeem
// against) is only known once closeOpenCheckCore loads the check row -- so this only parses the
// shape of the request field; the guest check itself happens in closeOpenCheckCore.
function parseLoyaltyRedemptionRewardRuleId(body: JsonRecord): string | null {
  const raw = body.loyalty_redemption
  if (raw === null || raw === undefined) return null
  const redemption = record(raw, 'Loyalty redemption')
  return id(redemption.reward_rule_id, 'Reward rule ID')
}

async function createOpenCheck(req: Request, res: Response, terminal = false) {
  try {
    const body = record(req.body, 'Request body')
    const storeId = id(body.store_id, 'Store ID')
    const access = await requireCheckAccess(req, storeId, terminal)
    const orderType = orderTypeValue(body.order_type)
    const tableId = optionalId(body.table_id, 'Table ID')
    if (tableId && orderType !== 'dine_in') throw new ApiError(422, 'validation_failed', 'A table can only be set for a dine-in check.')
    const customerId = optionalId(body.customer_id, 'Customer ID')
    const employeeId = access.employeeId ?? optionalId(body.employee_id, 'Employee ID')
    const result = await createOpenCheckCore(storeId, { orderType, tableId, customerId, employeeId })
    res.status(201).json(result)
  } catch (reason) { sendApiError(res, reason) }
}

async function listOpenChecks(req: Request, res: Response, terminal = false) {
  try {
    const storeId = id(String(req.query.store_id ?? ''), 'Store ID')
    await requireCheckAccess(req, storeId, terminal)
    const status = req.query.status ? text(req.query.status, 'status', 20) : 'open'
    const result = await db.query(
      `select c.id, c.store_id, c.status, c.order_type, c.table_id, t.label as table_label, c.customer_id, c.employee_id,
              c.manager_id, c.manager_approved_at, c.version, c.subtotal_cents::text, c.discount_cents::text,
              c.tax_cents::text, c.service_charge_cents::text, c.total_cents::text, c.notes, c.opened_at, c.updated_at,
              (select count(*) from public.open_check_items i where i.store_id = c.store_id and i.check_id = c.id) as item_count
       from public.open_checks c
       left join public.restaurant_tables t on t.store_id = c.store_id and t.id = c.table_id
       where c.store_id = $1 and c.status = $2
       order by c.opened_at desc`,
      [storeId, status],
    )
    res.json({ checks: result.rows.map(row => ({ ...row, subtotal_cents: Number(row.subtotal_cents), discount_cents: Number(row.discount_cents),
      tax_cents: Number(row.tax_cents), service_charge_cents: Number(row.service_charge_cents), total_cents: Number(row.total_cents), item_count: Number(row.item_count) })) })
  } catch (reason) { sendApiError(res, reason) }
}

async function getOpenCheck(req: Request, res: Response, terminal = false) {
  try {
    const storeId = id(String(req.query.store_id ?? ''), 'Store ID')
    await requireCheckAccess(req, storeId, terminal)
    const checkId = id(req.params.id, 'Check ID')
    const detail = await loadCheckDetail(storeId, checkId)
    if (!detail) throw new ApiError(404, 'not_found', 'Open check not found in this store.')
    res.json(detail)
  } catch (reason) { sendApiError(res, reason) }
}

async function editOpenCheck(req: Request, res: Response, terminal = false) {
  try {
    const body = record(req.body, 'Request body')
    const storeId = id(body.store_id, 'Store ID')
    await requireCheckAccess(req, storeId, terminal)
    const checkId = id(req.params.id, 'Check ID')
    const expectedVersion = versionValue(body.expected_version)
    const items = parseCheckItems(body.items)
    const serviceChargeBps = serviceChargeBpsValue(body.service_charge_bps)
    const notes = body.notes === null || body.notes === undefined ? null : text(body.notes, 'Notes', 500)
    const customerId = optionalId(body.customer_id, 'Customer ID')
    const managerId = optionalId(body.manager_id, 'Manager ID')
    const managerApprovedAt = body.manager_approved_at === null || body.manager_approved_at === undefined ? null : timestamp(body.manager_approved_at, 'Manager approval time')
    const detail = await editOpenCheckCore(storeId, checkId, { expectedVersion, items, serviceChargeBps, notes, customerId, managerId, managerApprovedAt })
    res.json(detail)
  } catch (reason) { sendApiError(res, reason) }
}

async function voidOpenCheck(req: Request, res: Response, terminal = false) {
  try {
    const body = record(req.body, 'Request body')
    const storeId = id(body.store_id, 'Store ID')
    await requireCheckAccess(req, storeId, terminal)
    const checkId = id(req.params.id, 'Check ID')
    const expectedVersion = versionValue(body.expected_version)
    const voidedByEmployeeId = optionalId(body.voided_by_employee_id, 'Employee ID')
    const result = await voidOpenCheckCore(storeId, checkId, expectedVersion, voidedByEmployeeId)
    res.json(result)
  } catch (reason) { sendApiError(res, reason) }
}

async function closeOpenCheck(req: Request, res: Response, terminal = false) {
  try {
    const body = record(req.body, 'Request body')
    const storeId = id(body.store_id, 'Store ID')
    const access = await requireCheckAccess(req, storeId, terminal)
    const checkId = id(req.params.id, 'Check ID')
    const operationId = id(body.operation_id, 'Operation ID')
    const expectedVersion = versionValue(body.expected_version)
    const receiptNumber = text(body.receipt_number, 'Receipt number', 100)
    if (!Number.isSafeInteger(body.catalog_version) || (body.catalog_version as number) < 1) throw new ApiError(422, 'validation_failed', 'Catalog version is invalid.')
    const clientGeneratedAt = timestamp(body.client_generated_at, 'Sale time')
    const serviceChargeBps = serviceChargeBpsValue(body.service_charge_bps)
    const payments = parseClosePayments(body)

    const hash = createHash('sha256').update(JSON.stringify(req.body)).digest('hex')
    const result = await closeOpenCheckCore(storeId, checkId, {
      operationId, expectedVersion, receiptNumber, catalogVersion: body.catalog_version as number, clientGeneratedAt, serviceChargeBps,
      payments,
      employeeIdOverride: access.employeeId, loyaltyRedemptionRewardRuleId: parseLoyaltyRedemptionRewardRuleId(body),
    }, hash)
    res.json(result)
  } catch (reason) { sendApiError(res, reason) }
}

openChecksRouter.post('/', (req, res) => void createOpenCheck(req, res))
terminalOpenChecksRouter.post('/', (req, res) => void createOpenCheck(req, res, true))
openChecksRouter.get('/', (req, res) => void listOpenChecks(req, res))
terminalOpenChecksRouter.get('/', (req, res) => void listOpenChecks(req, res, true))
openChecksRouter.get('/:id', (req, res) => void getOpenCheck(req, res))
terminalOpenChecksRouter.get('/:id', (req, res) => void getOpenCheck(req, res, true))
openChecksRouter.patch('/:id', (req, res) => void editOpenCheck(req, res))
terminalOpenChecksRouter.patch('/:id', (req, res) => void editOpenCheck(req, res, true))
openChecksRouter.post('/:id/void', (req, res) => void voidOpenCheck(req, res))
terminalOpenChecksRouter.post('/:id/void', (req, res) => void voidOpenCheck(req, res, true))
openChecksRouter.post('/:id/close', (req, res) => void closeOpenCheck(req, res))
terminalOpenChecksRouter.post('/:id/close', (req, res) => void closeOpenCheck(req, res, true))
