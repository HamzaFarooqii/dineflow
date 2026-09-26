import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreManager, sendApiError, ApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'

// Clock-in/out (docs/day-plans/day5.md gap-fill). Deliberately minimal v1: no breaks, no payroll
// export -- a timestamped shift row and an hours-worked read, matching the agreed scope. Every
// terminal role can clock in/out (waiter, chef, inventory_manager, rider, cashier, manager alike);
// this isn't gated to a specific capability the way inventory/kitchen writes are.
export const shiftsRouter = Router()
export const terminalShiftsRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}

interface ShiftRow { id: string; employee_id: string; device_id: string; clocked_in_at: string; clocked_out_at: string | null }

// POST /pos/shifts/clock-in — the shifts_one_open_per_employee partial unique index is the real
// guard against a double clock-in; this check exists only to turn that constraint violation into
// a clear error message rather than a raw 23505 leaking to the client.
async function clockIn(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    const session = await requireCashierTerminal(req, db)
    if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    const open = await db.query('select 1 from public.shifts where store_id=$1 and employee_id=$2 and clocked_out_at is null', [storeId, session.employeeId])
    if (open.rowCount) throw new ApiError(409, 'shift_already_open', 'Already clocked in.')
    const result = await db.query<ShiftRow>(
      `insert into public.shifts (store_id, employee_id, device_id) values ($1,$2,$3)
       returning id, employee_id, device_id, clocked_in_at::text as clocked_in_at, clocked_out_at::text as clocked_out_at`,
      [storeId, session.employeeId, session.deviceId],
    )
    res.status(201).json({ shift: result.rows[0] })
  } catch (reason) { sendApiError(res, reason) }
}

// POST /pos/shifts/clock-out — closes the caller's own open shift. Idempotent-safe: calling this
// twice in a row just 404s the second time (no open shift left to close), never double-closes one.
async function clockOut(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    const session = await requireCashierTerminal(req, db)
    if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    const result = await db.query<ShiftRow>(
      `update public.shifts set clocked_out_at = now() where store_id=$1 and employee_id=$2 and clocked_out_at is null
       returning id, employee_id, device_id, clocked_in_at::text as clocked_in_at, clocked_out_at::text as clocked_out_at`,
      [storeId, session.employeeId],
    )
    if (!result.rowCount) throw new ApiError(404, 'no_open_shift', 'No open shift to clock out of.')
    res.json({ shift: result.rows[0] })
  } catch (reason) { sendApiError(res, reason) }
}

// GET /pos/shifts/current — so the terminal can show the right button (Clock In vs Clock Out) on
// load/reload rather than assuming state client-side.
async function currentShift(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    const session = await requireCashierTerminal(req, db)
    if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    const result = await db.query<ShiftRow>(
      `select id, employee_id, device_id, clocked_in_at::text as clocked_in_at, clocked_out_at::text as clocked_out_at
       from public.shifts where store_id=$1 and employee_id=$2 and clocked_out_at is null`,
      [storeId, session.employeeId],
    )
    res.json({ shift: result.rows[0] ?? null })
  } catch (reason) { sendApiError(res, reason) }
}

// GET /shifts — owner/manager read, for an hours-worked report (Bisma's Day 5 reporting work
// builds the actual report UI/aggregation on top of this raw list; this endpoint only surfaces
// the underlying rows). A day-bounded range keeps the response bounded on a long-running store.
async function listShifts(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const from = req.query.from ? new Date(String(req.query.from)) : null
    const to = req.query.to ? new Date(String(req.query.to)) : null
    if ((req.query.from && Number.isNaN(from?.getTime())) || (req.query.to && Number.isNaN(to?.getTime()))) {
      throw new ApiError(422, 'validation_failed', 'from/to must be valid timestamps.')
    }
    const result = await db.query(
      `select s.id, s.employee_id, e.name as employee_name, e.role as employee_role, s.device_id,
              s.clocked_in_at::text as clocked_in_at, s.clocked_out_at::text as clocked_out_at
       from public.shifts s
       join public.terminal_employees e on e.store_id = s.store_id and e.id = s.employee_id
       where s.store_id = $1 and ($2::timestamptz is null or s.clocked_in_at >= $2) and ($3::timestamptz is null or s.clocked_in_at < $3)
       order by s.clocked_in_at desc`,
      [storeId, from, to],
    )
    res.json({ shifts: result.rows })
  } catch (reason) { sendApiError(res, reason) }
}

shiftsRouter.get('/', listShifts)
terminalShiftsRouter.post('/clock-in', clockIn)
terminalShiftsRouter.post('/clock-out', clockOut)
terminalShiftsRouter.get('/current', currentShift)
