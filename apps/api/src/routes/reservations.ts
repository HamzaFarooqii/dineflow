import { Router, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { requireCashierCapability } from '../terminal-auth/routes.js'
import { ApiError, requireStoreMember, sendApiError } from './auth.js'
import { applyTableStatusTransition, storeIdParam } from './floor.js'

export const reservationsRouter = Router()
export const terminalReservationsRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PHONE_RE = /^[1-9][0-9]{3,14}$/
const RESERVATION_STATUSES = ['booked', 'arrived', 'seated', 'cancelled', 'no_show'] as const
const WAITLIST_STATUSES = ['waiting', 'seated', 'cancelled', 'no_show'] as const
type EntryKind = 'reservation' | 'waitlist'
type ReservationStatus = typeof RESERVATION_STATUSES[number]
type WaitlistStatus = typeof WAITLIST_STATUSES[number]

interface BookingRow {
  id: string
  store_id: string
  guest_name: string
  guest_phone: string | null
  guest_size: number
  notes: string
  expected_at: string
  status: string
  floor_area_id: string | null
  restaurant_table_id: string | null
  seated_at: string | null
  seated_table_id: string | null
  seated_operation_id: string | null
  created_at: string
  updated_at: string
  wait_minutes?: number
}

function tableName(kind: EntryKind): 'reservations' | 'waitlist_entries' {
  return kind === 'reservation' ? 'reservations' : 'waitlist_entries'
}

function validUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new ApiError(422, 'validation_failed', `${label} must be a valid UUID.`)
  return value
}

function optionalUuid(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return validUuid(value, label)
}

function text(value: unknown, label: string, max: number): string {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > max) throw new ApiError(422, 'validation_failed', `${label} must be 1-${max} characters.`)
  return normalized
}

function optionalText(value: unknown, label: string, max: number): string {
  if (value === undefined || value === null) return ''
  const normalized = String(value).trim()
  if (normalized.length > max) throw new ApiError(422, 'validation_failed', `${label} must be ${max} characters or fewer.`)
  return normalized
}

function optionalPhone(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const normalized = String(value).replace(/\D/g, '')
  if (!PHONE_RE.test(normalized)) throw new ApiError(422, 'validation_failed', 'Guest phone must be 4 to 15 international digits.')
  return normalized
}

function guestSize(value: unknown): number {
  const size = Number(value)
  if (!Number.isInteger(size) || size <= 0 || size > 99) throw new ApiError(422, 'validation_failed', 'Guest size must be 1-99.')
  return size
}

function expectedAt(value: unknown, fallbackNow = false): string {
  if ((value === undefined || value === null || value === '') && fallbackNow) return new Date().toISOString()
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new ApiError(422, 'validation_failed', 'Expected time must be an ISO date/time.')
  return new Date(value).toISOString()
}

function statusFor(kind: EntryKind, value: unknown): ReservationStatus | WaitlistStatus {
  const status = String(value ?? '')
  const allowed = kind === 'reservation' ? RESERVATION_STATUSES : WAITLIST_STATUSES
  if (!(allowed as readonly string[]).includes(status)) throw new ApiError(422, 'validation_failed', 'Status is not valid for this entry.')
  return status as ReservationStatus | WaitlistStatus
}

// Gated to 'register' capability, not 'floor': reservations-seat.test.ts's existing, passing
// coverage has a plain cashier role seating a reservation through this exact terminal path, so a
// cashier walking a waiting guest to their table is established, intended behavior here -- 'floor'
// would have wrongly blocked that. register covers cashier/waiter/manager, matching that evidence.
async function requireAccess(req: Request, storeId: string, terminal: boolean) {
  if (terminal) {
    const session = await requireCashierCapability(req, db, 'register')
    if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
  } else {
    await requireStoreMember(req, storeId)
  }
}

async function validateOptionalReferences(storeId: string, floorAreaId: string | null, tableId: string | null) {
  if (floorAreaId) {
    const area = await db.query('select 1 from public.floor_areas where id=$1 and store_id=$2 and active=true', [floorAreaId, storeId])
    if (!area.rowCount) throw new ApiError(422, 'validation_failed', 'Area must belong to this store and be active.')
  }
  if (tableId) {
    const table = await db.query('select 1 from public.restaurant_tables where id=$1 and store_id=$2 and active=true', [tableId, storeId])
    if (!table.rowCount) throw new ApiError(422, 'validation_failed', 'Table must belong to this store and be active.')
  }
}

function mapRow(row: BookingRow): BookingRow {
  return { ...row, wait_minutes: Math.max(0, Number(row.wait_minutes ?? 0)) }
}

async function loadRows(storeId: string, kind: EntryKind, filter: string): Promise<BookingRow[]> {
  const table = tableName(kind)
  const activeStatus = kind === 'reservation' ? "status in ('booked','arrived')" : "status = 'waiting'"
  const where = filter === 'today'
    ? `and expected_at >= timezone(s.timezone, now())::date at time zone s.timezone
       and expected_at < (timezone(s.timezone, now())::date + interval '1 day') at time zone s.timezone`
    : filter === 'upcoming'
      ? `and expected_at >= (timezone(s.timezone, now())::date + interval '1 day') at time zone s.timezone`
      : filter === 'waiting'
        ? `and ${activeStatus}`
        : ''
  const result = await db.query<BookingRow>(
    `select b.*, greatest(0, floor(extract(epoch from (now() - b.expected_at)) / 60))::int as wait_minutes
     from public.${table} b
     join public.stores s on s.id = b.store_id
     where b.store_id = $1 ${where}
     order by b.expected_at asc, b.created_at asc
     limit 200`,
    [storeId],
  )
  return result.rows.map(mapRow)
}

async function list(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    await requireAccess(req, storeId, terminal)
    const filter = String(req.query.filter ?? 'today')
    if (!['today', 'upcoming', 'waiting', 'all'].includes(filter)) throw new ApiError(400, 'validation_failed', 'Unknown booking filter.')
    const [reservations, waitlist] = await Promise.all([loadRows(storeId, 'reservation', filter), loadRows(storeId, 'waitlist', filter)])
    res.json({ reservations, waitlist })
  } catch (reason) { sendApiError(res, reason) }
}

async function conflictWarnings(storeId: string, expected: string, tableId: string | null, ownId: string | null): Promise<string[]> {
  const warnings: string[] = []
  if (tableId) {
    const table = await db.query<{ status: string; label: string }>('select status,label from public.restaurant_tables where id=$1 and store_id=$2 and active=true', [tableId, storeId])
    if (table.rows[0] && table.rows[0].status !== 'available') warnings.push(`Table ${table.rows[0].label} is currently ${table.rows[0].status}.`)
    const overlaps = await db.query<{ guest_name: string }>(
      `select guest_name from public.reservations
       where store_id=$1 and restaurant_table_id=$2 and status in ('booked','arrived')
         and id <> coalesce($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
         and expected_at between $3::timestamptz - interval '90 minutes' and $3::timestamptz + interval '90 minutes'
       limit 3`,
      [storeId, tableId, expected, ownId],
    )
    for (const row of overlaps.rows) warnings.push(`Reservation near this time already exists for ${row.guest_name}.`)
  }
  return warnings
}

async function createEntry(req: Request, res: Response, kind: EntryKind, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    await requireAccess(req, storeId, terminal)
    const body = (req.body ?? {}) as Record<string, unknown>
    const floorAreaId = optionalUuid(body.floor_area_id, 'Area')
    const tableId = optionalUuid(body.restaurant_table_id, 'Table')
    await validateOptionalReferences(storeId, floorAreaId, tableId)
    const expected = expectedAt(body.expected_at, kind === 'waitlist')
    const values = {
      guestName: text(body.guest_name, 'Guest name', 120),
      guestPhone: optionalPhone(body.guest_phone),
      guestSize: guestSize(body.guest_size),
      notes: optionalText(body.notes, 'Notes', 500),
      expected,
      floorAreaId,
      tableId,
    }
    const table = tableName(kind)
    const status = kind === 'reservation' ? 'booked' : 'waiting'
    const result = await db.query<BookingRow>(
      `insert into public.${table}
       (store_id, guest_name, guest_phone, guest_size, notes, expected_at, status, floor_area_id, restaurant_table_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [storeId, values.guestName, values.guestPhone, values.guestSize, values.notes, values.expected, status, values.floorAreaId, values.tableId],
    )
    res.status(201).json({ [kind]: mapRow(result.rows[0]), warnings: await conflictWarnings(storeId, values.expected, tableId, result.rows[0].id) })
  } catch (reason) { sendApiError(res, reason) }
}

async function updateEntry(req: Request, res: Response, kind: EntryKind, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    await requireAccess(req, storeId, terminal)
    const id = validUuid(req.params.id, 'Entry ID')
    const body = (req.body ?? {}) as Record<string, unknown>
    const updates: string[] = []
    const values: unknown[] = []
    let index = 1
    const add = (sql: string, value: unknown) => { updates.push(`${sql} = $${index++}`); values.push(value) }
    if (body.guest_name !== undefined) add('guest_name', text(body.guest_name, 'Guest name', 120))
    if (body.guest_phone !== undefined) add('guest_phone', optionalPhone(body.guest_phone))
    if (body.guest_size !== undefined) add('guest_size', guestSize(body.guest_size))
    if (body.notes !== undefined) add('notes', optionalText(body.notes, 'Notes', 500))
    if (body.expected_at !== undefined) add('expected_at', expectedAt(body.expected_at))
    if (body.floor_area_id !== undefined) add('floor_area_id', optionalUuid(body.floor_area_id, 'Area'))
    if (body.restaurant_table_id !== undefined) add('restaurant_table_id', optionalUuid(body.restaurant_table_id, 'Table'))
    if (body.status !== undefined) {
      const next = statusFor(kind, body.status)
      if (next === 'seated') throw new ApiError(422, 'validation_failed', 'Use the seat action to seat a booking.')
      add('status', next)
    }
    if (!updates.length) throw new ApiError(422, 'validation_failed', 'Nothing to update.')
    const nextAreaId = body.floor_area_id !== undefined ? optionalUuid(body.floor_area_id, 'Area') : null
    const nextTableId = body.restaurant_table_id !== undefined ? optionalUuid(body.restaurant_table_id, 'Table') : null
    await validateOptionalReferences(storeId, nextAreaId, nextTableId)
    updates.push('updated_at = now()')
    values.push(id, storeId)
    const table = tableName(kind)
    const result = await db.query<BookingRow>(
      `update public.${table} set ${updates.join(', ')}
       where id = $${index++} and store_id = $${index} and status <> 'seated'
       returning *`,
      values,
    )
    if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Booking not found or already seated.')
    res.json({ [kind]: mapRow(result.rows[0]), warnings: await conflictWarnings(storeId, result.rows[0].expected_at, result.rows[0].restaurant_table_id, id) })
  } catch (reason) { sendApiError(res, reason) }
}

async function action(req: Request, res: Response, kind: EntryKind, terminal: boolean, status: ReservationStatus | WaitlistStatus) {
  try {
    const storeId = storeIdParam(req)
    await requireAccess(req, storeId, terminal)
    const id = validUuid(req.params.id, 'Entry ID')
    if (status === 'seated') throw new ApiError(422, 'validation_failed', 'Use the seat action.')
    const table = tableName(kind)
    const allowed = kind === 'reservation' ? "status in ('booked','arrived')" : "status = 'waiting'"
    const result = await db.query<BookingRow>(
      `update public.${table} set status=$1, updated_at=now()
       where id=$2 and store_id=$3 and ${allowed}
       returning *`,
      [status, id, storeId],
    )
    if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Booking not found or no longer actionable.')
    res.json({ [kind]: mapRow(result.rows[0]) })
  } catch (reason) { sendApiError(res, reason) }
}

async function lockBooking(client: PoolClient, kind: EntryKind, storeId: string, id: string): Promise<BookingRow> {
  const table = tableName(kind)
  const actionable = kind === 'reservation' ? "status in ('booked','arrived')" : "status = 'waiting'"
  const result = await client.query<BookingRow>(
    `select * from public.${table} where id=$1 and store_id=$2 and (${actionable} or status='seated') for update`,
    [id, storeId],
  )
  if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Booking not found.')
  return result.rows[0]
}

async function seat(req: Request, res: Response, kind: EntryKind, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    await requireAccess(req, storeId, terminal)
    const id = validUuid(req.params.id, 'Entry ID')
    const body = (req.body ?? {}) as Record<string, unknown>
    const tableId = validUuid(body.table_id, 'Table ID')
    const operationId = body.operation_id === undefined ? randomUUID() : validUuid(body.operation_id, 'Operation ID')
    const assignedWaiterId = optionalUuid(body.assigned_waiter_id, 'Waiter')
    const client = await db.connect()
    try {
      await client.query('begin')
      const booking = await lockBooking(client, kind, storeId, id)
      if (booking.status === 'seated') {
        if (booking.seated_operation_id === operationId) {
          await client.query('commit')
          res.json({ [kind]: mapRow(booking), table: null, replayed: true })
          return
        }
        throw new ApiError(409, 'booking_already_seated', 'This booking has already been seated.')
      }
      const table = await applyTableStatusTransition(storeId, tableId, 'available', 'seated', assignedWaiterId, client)
      if (!table) {
        const current = await client.query<{ status: string }>('select status from public.restaurant_tables where id=$1 and store_id=$2 and active=true', [tableId, storeId])
        if (!current.rows[0]) throw new ApiError(404, 'table_not_found', 'Table not found in this store.')
        throw new ApiError(409, 'status_conflict', `This table's status changed to ${current.rows[0].status} since it was last loaded.`)
      }
      const source = tableName(kind)
      const updated = await client.query<BookingRow>(
        `update public.${source}
         set status='seated', seated_at=now(), seated_table_id=$1, restaurant_table_id=$1,
             seated_operation_id=$2, updated_at=now()
         where id=$3 and store_id=$4 and status <> 'seated'
         returning *`,
        [tableId, operationId, id, storeId],
      )
      await client.query('commit')
      res.json({ [kind]: mapRow(updated.rows[0]), table })
    } catch (reason) {
      await client.query('rollback').catch(() => undefined)
      throw reason
    } finally {
      client.release()
    }
  } catch (reason) { sendApiError(res, reason) }
}

function register(router: Router, terminal = false) {
  router.get('/', (req, res) => void list(req, res, terminal))
  router.post('/reservations', (req, res) => void createEntry(req, res, 'reservation', terminal))
  router.patch('/reservations/:id', (req, res) => void updateEntry(req, res, 'reservation', terminal))
  router.post('/reservations/:id/arrive', (req, res) => void action(req, res, 'reservation', terminal, 'arrived'))
  router.post('/reservations/:id/cancel', (req, res) => void action(req, res, 'reservation', terminal, 'cancelled'))
  router.post('/reservations/:id/no-show', (req, res) => void action(req, res, 'reservation', terminal, 'no_show'))
  router.post('/reservations/:id/seat', (req, res) => void seat(req, res, 'reservation', terminal))
  router.post('/waitlist', (req, res) => void createEntry(req, res, 'waitlist', terminal))
  router.patch('/waitlist/:id', (req, res) => void updateEntry(req, res, 'waitlist', terminal))
  router.post('/waitlist/:id/cancel', (req, res) => void action(req, res, 'waitlist', terminal, 'cancelled'))
  router.post('/waitlist/:id/no-show', (req, res) => void action(req, res, 'waitlist', terminal, 'no_show'))
  router.post('/waitlist/:id/seat', (req, res) => void seat(req, res, 'waitlist', terminal))
}

register(reservationsRouter)
register(terminalReservationsRouter, true)
