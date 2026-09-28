import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreManager, sendApiError, ApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'
import { calendarDayBoundsUtc } from '../lib/timezone.js'

// B5: breaks (paid/unpaid) against an open shift, manager corrections with an immutable audit
// trail, and a payroll-ready CSV export. Extends shifts.ts's clock-in/out model rather than
// building a parallel time-tracking system — same terminal-session auth for start/end, same
// requireStoreManager gate for the owner/manager-only read and correction endpoints.
export const timekeepingRouter = Router()
export const terminalTimekeepingRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}

function idParam(req: Request, name: string): string {
  const value = String(req.params[name] ?? '')
  if (!UUID_RE.test(value)) throw new ApiError(400, 'validation_failed', `A valid ${name} is required.`)
  return value
}

interface BreakRow { id: string; shift_id: string; employee_id: string; paid: boolean; started_at: string; ended_at: string | null }

function isUniqueViolation(reason: unknown): boolean {
  return Boolean(reason && typeof reason === 'object' && 'code' in reason && (reason as { code?: string }).code === '23505')
}

// POST /pos/shifts/breaks/start — starts a paid or unpaid break against the caller's own open
// shift. The DB trigger (shift_breaks_require_open_shift) is the real guard against starting a
// break on a shift that isn't open; the partial unique index (shift_breaks_one_open_per_shift)
// is the real guard against overlapping breaks. Both are enforced at the database level, not
// just the pre-check below, which is a plain select-then-insert and cannot by itself prevent two
// concurrent "start break" requests from both passing it before either insert commits — the
// insert's own unique-violation catch (not the pre-check) is what actually closes that race, and
// without it the race loser fell through to sendApiError's generic 23505 branch, which is
// hard-coded checkout copy ("A sale already uses this receipt...") having nothing to do with a
// break. Same reasoning as the pre-check: turn the real constraint violation into a clear message.
async function startBreak(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    const session = await requireCashierTerminal(req, db)
    if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    const paid = Boolean((req.body as Record<string, unknown> | undefined)?.paid)
    const shift = await db.query<{ id: string }>(
      'select id from public.shifts where store_id=$1 and employee_id=$2 and clocked_out_at is null',
      [storeId, session.employeeId],
    )
    if (!shift.rowCount) throw new ApiError(409, 'no_open_shift', 'Clock in before starting a break.')
    const openBreak = await db.query('select 1 from public.shift_breaks where store_id=$1 and shift_id=$2 and ended_at is null', [storeId, shift.rows[0].id])
    if (openBreak.rowCount) throw new ApiError(409, 'break_already_open', 'A break is already in progress.')
    let result
    try {
      result = await db.query<BreakRow>(
        `insert into public.shift_breaks (store_id, shift_id, employee_id, paid) values ($1,$2,$3,$4)
         returning id, shift_id, employee_id, paid, started_at::text as started_at, ended_at::text as ended_at`,
        [storeId, shift.rows[0].id, session.employeeId, paid],
      )
    } catch (insertReason) {
      if (isUniqueViolation(insertReason)) throw new ApiError(409, 'break_already_open', 'A break is already in progress.')
      throw insertReason
    }
    res.status(201).json({ break: result.rows[0] })
  } catch (reason) { sendApiError(res, reason) }
}

// POST /pos/shifts/breaks/end — closes the caller's own open break. Idempotent-safe like
// clock-out: calling it twice just 404s the second time.
async function endBreak(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    const session = await requireCashierTerminal(req, db)
    if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    const result = await db.query<BreakRow>(
      `update public.shift_breaks set ended_at = now()
       where store_id=$1 and employee_id=$2 and ended_at is null
       returning id, shift_id, employee_id, paid, started_at::text as started_at, ended_at::text as ended_at`,
      [storeId, session.employeeId],
    )
    if (!result.rowCount) throw new ApiError(404, 'no_open_break', 'No open break to end.')
    res.json({ break: result.rows[0] })
  } catch (reason) { sendApiError(res, reason) }
}

// GET /pos/shifts/breaks/current — so the terminal can show Start Break vs End Break correctly
// on load/reload, matching GET /pos/shifts/current's role for clock-in/out.
async function currentBreak(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    const session = await requireCashierTerminal(req, db)
    if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    const result = await db.query<BreakRow>(
      `select id, shift_id, employee_id, paid, started_at::text as started_at, ended_at::text as ended_at
       from public.shift_breaks where store_id=$1 and employee_id=$2 and ended_at is null`,
      [storeId, session.employeeId],
    )
    res.json({ break: result.rows[0] ?? null })
  } catch (reason) { sendApiError(res, reason) }
}

// GET /shifts/breaks — owner/manager read of break records in range, for the Hours report.
async function listBreaks(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const from = req.query.from ? new Date(String(req.query.from)) : null
    const to = req.query.to ? new Date(String(req.query.to)) : null
    if ((req.query.from && Number.isNaN(from?.getTime())) || (req.query.to && Number.isNaN(to?.getTime()))) {
      throw new ApiError(422, 'validation_failed', 'from/to must be valid timestamps.')
    }
    const result = await db.query(
      `select b.id, b.shift_id, b.employee_id, b.paid, b.started_at::text as started_at, b.ended_at::text as ended_at
       from public.shift_breaks b
       where b.store_id = $1 and ($2::timestamptz is null or b.started_at >= $2) and ($3::timestamptz is null or b.started_at < $3)
       order by b.started_at desc`,
      [storeId, from, to],
    )
    res.json({ breaks: result.rows })
  } catch (reason) { sendApiError(res, reason) }
}

const CORRECTABLE_SHIFT_FIELDS = ['clocked_in_at', 'clocked_out_at'] as const
const CORRECTABLE_BREAK_FIELDS = ['started_at', 'ended_at', 'paid'] as const

function parseTimestampField(value: unknown, field: string): string | boolean {
  if (field === 'paid') return Boolean(value)
  const parsed = new Date(String(value))
  if (Number.isNaN(parsed.getTime())) throw new ApiError(422, 'validation_failed', `${field} must be a valid timestamp.`)
  return parsed.toISOString()
}

// Shared correction handler: updates a single field on a shift or break row and writes an
// immutable audit row (timekeeping_corrections) in the same transaction — never a silent
// mutation. The correction table has no update/delete policy and a trigger that rejects any
// attempt to alter or remove a row once written (202609280004), so this insert is a one-way door.
async function correctRecord(
  req: Request, res: Response,
  recordType: 'shift' | 'break', table: 'shifts' | 'shift_breaks', allowedFields: readonly string[],
) {
  const client = await db.connect()
  try {
    const storeId = storeIdParam(req)
    const userId = await requireStoreManager(req, storeId)
    const recordId = idParam(req, 'id')
    const body = req.body as Record<string, unknown>
    const field = String(body.field ?? '')
    if (!allowedFields.includes(field)) throw new ApiError(422, 'validation_failed', `field must be one of: ${allowedFields.join(', ')}.`)
    const reason = String(body.reason ?? '').trim()
    if (reason.length < 1 || reason.length > 500) throw new ApiError(422, 'validation_failed', 'A reason (1-500 chars) is required for every correction.')
    const newValue = parseTimestampField(body.new_value, field)

    await client.query('begin')
    const current = await client.query(`select ${field} as value from public.${table} where store_id=$1 and id=$2 for update`, [storeId, recordId])
    if (!current.rowCount) throw new ApiError(404, 'not_found', 'Record not found in this store.')
    const oldValue = current.rows[0].value
    await client.query(`update public.${table} set ${field} = $1 where store_id=$2 and id=$3`, [newValue, storeId, recordId])
    await client.query(
      `insert into public.timekeeping_corrections (store_id, record_type, record_id, corrected_by, field, old_value, new_value, reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [storeId, recordType, recordId, userId, field, oldValue === null ? null : String(oldValue), String(newValue), reason],
    )
    await client.query('commit')
    res.status(200).json({ status: 'corrected', field, old_value: oldValue, new_value: newValue })
  } catch (reason) {
    await client.query('rollback').catch(() => {})
    sendApiError(res, reason)
  } finally {
    client.release()
  }
}

async function correctShift(req: Request, res: Response) { await correctRecord(req, res, 'shift', 'shifts', CORRECTABLE_SHIFT_FIELDS) }
async function correctBreak(req: Request, res: Response) { await correctRecord(req, res, 'break', 'shift_breaks', CORRECTABLE_BREAK_FIELDS) }

// GET /shifts/corrections — owner/manager read of the correction audit trail for a date range.
async function listCorrections(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const result = await db.query(
      `select c.id, c.record_type, c.record_id, c.corrected_by, c.field, c.old_value, c.new_value, c.reason, c.created_at::text as created_at
       from public.timekeeping_corrections c where c.store_id = $1 order by c.created_at desc limit 500`,
      [storeId],
    )
    res.json({ corrections: result.rows })
  } catch (reason) { sendApiError(res, reason) }
}

function csvField(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// Integer-minutes helper: whole minutes between two ISO instants, floor-rounded down like the
// rest of the codebase's duration math (durationLabel in ReportingScreens.tsx uses seconds the
// same way) so totals never drift from floating point — every input here is already an integer
// millisecond timestamp difference.
function minutesBetween(startIso: string, endIso: string): number {
  return Math.floor((Date.parse(endIso) - Date.parse(startIso)) / 60_000)
}

// GET /shifts/export.csv — payroll-ready CSV: one row per closed shift, with integer
// minute totals (worked minutes net of unpaid break minutes, paid break minutes, unpaid break
// minutes) computed in the store's own timezone for the date-range boundary. Deliberately not a
// payroll calculation engine — no pay rates, no overtime rules, just accurate summed source data.
// Open shifts are excluded from the export (their totals aren't final yet) but are still visible
// in the JSON /shifts and /shifts/breaks endpoints so the UI can show them as in-progress.
async function exportTimekeepingCsv(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const fromDate = String(req.query.from ?? '')
    const toDate = String(req.query.to ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      throw new ApiError(422, 'validation_failed', 'from/to must be YYYY-MM-DD calendar dates.')
    }
    const store = await db.query<{ timezone: string }>('select timezone from public.stores where id=$1', [storeId])
    if (!store.rowCount) throw new ApiError(404, 'not_found', 'Store not found.')
    const timezone = store.rows[0].timezone
    const { startUtc, endUtc } = calendarDayBoundsUtc(fromDate, timezone)
    const { endUtc: rangeEnd } = calendarDayBoundsUtc(toDate, timezone)

    const shifts = await db.query<{
      id: string; employee_id: string; employee_name: string; employee_role: string
      clocked_in_at: string; clocked_out_at: string
    }>(
      `select s.id, s.employee_id, e.name as employee_name, e.role as employee_role,
              s.clocked_in_at::text as clocked_in_at, s.clocked_out_at::text as clocked_out_at
       from public.shifts s
       join public.terminal_employees e on e.store_id = s.store_id and e.id = s.employee_id
       where s.store_id = $1 and s.clocked_in_at >= $2 and s.clocked_in_at < $3 and s.clocked_out_at is not null
       order by e.name, s.clocked_in_at`,
      [storeId, startUtc, rangeEnd],
    )
    const shiftIds = shifts.rows.map(row => row.id)
    const breaksByShift = new Map<string, { paidMinutes: number; unpaidMinutes: number }>()
    if (shiftIds.length) {
      const breaks = await db.query<{ shift_id: string; paid: boolean; started_at: string; ended_at: string }>(
        `select shift_id, paid, started_at::text as started_at, ended_at::text as ended_at
         from public.shift_breaks where store_id = $1 and shift_id = any($2::uuid[]) and ended_at is not null`,
        [storeId, shiftIds],
      )
      for (const row of breaks.rows) {
        const totals = breaksByShift.get(row.shift_id) ?? { paidMinutes: 0, unpaidMinutes: 0 }
        const minutes = minutesBetween(row.started_at, row.ended_at)
        if (row.paid) totals.paidMinutes += minutes; else totals.unpaidMinutes += minutes
        breaksByShift.set(row.shift_id, totals)
      }
    }

    const header = ['employee_name', 'employee_role', 'shift_id', 'clocked_in_at', 'clocked_out_at', 'gross_minutes', 'paid_break_minutes', 'unpaid_break_minutes', 'net_paid_minutes']
    const lines = [header.join(',')]
    for (const shift of shifts.rows) {
      const grossMinutes = minutesBetween(shift.clocked_in_at, shift.clocked_out_at)
      const totals = breaksByShift.get(shift.id) ?? { paidMinutes: 0, unpaidMinutes: 0 }
      const netPaidMinutes = grossMinutes - totals.unpaidMinutes
      lines.push([
        csvField(shift.employee_name), csvField(shift.employee_role), csvField(shift.id),
        csvField(shift.clocked_in_at), csvField(shift.clocked_out_at),
        csvField(grossMinutes), csvField(totals.paidMinutes), csvField(totals.unpaidMinutes), csvField(netPaidMinutes),
      ].join(','))
    }
    const csv = lines.join('\r\n') + '\r\n'
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="timekeeping-${fromDate}-to-${toDate}.csv"`)
    res.status(200).send(csv)
  } catch (reason) { sendApiError(res, reason) }
}

timekeepingRouter.get('/breaks', listBreaks)
timekeepingRouter.get('/corrections', listCorrections)
timekeepingRouter.post('/:id/correct', correctShift)
timekeepingRouter.post('/breaks/:id/correct', correctBreak)
timekeepingRouter.get('/export.csv', exportTimekeepingCsv)

terminalTimekeepingRouter.post('/breaks/start', startBreak)
terminalTimekeepingRouter.post('/breaks/end', endBreak)
terminalTimekeepingRouter.get('/breaks/current', currentBreak)

export { minutesBetween, csvField }
