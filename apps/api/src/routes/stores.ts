import { Router } from 'express'
import { db } from '../db.js'
import { requireStoreMember, requireStoreManager, sendApiError, ApiError } from './auth.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function getStore(req: import('express').Request, res: import('express').Response) {
  try {
    const storeId = String(req.params.id ?? '')
    if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store ID is required.')
    await requireStoreMember(req, storeId)
    const result = await db.query(
      'select id, name, timezone, currency, address, country from public.stores where id=$1',
      [storeId],
    )
    if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Store not found.')
    res.json(result.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

// ---------------------------------------------------------------------------
// PATCH /stores/:id — owner/manager edits business details.
// Partial update: only fields present in the body are changed. name is deliberately
// not editable here — it is set at store creation and not part of this task's scope.
//
// Currency can only change before catalog or sales activity. An offline terminal may have
// paid sales queued in the original currency, so a store-wide conversion cannot safely
// reprice an active store without a coordinated migration across every device.
// ---------------------------------------------------------------------------
async function patchStore(req: import('express').Request, res: import('express').Response) {
  try {
    const storeId = String(req.params.id ?? '')
    if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store ID is required.')
    await requireStoreManager(req, storeId)
    const body = req.body as Record<string, unknown>

    const currentRes = await db.query<{ currency: string }>('select currency from public.stores where id=$1', [storeId])
    if (!currentRes.rows[0]) throw new ApiError(404, 'not_found', 'Store not found.')
    const currentCurrency = currentRes.rows[0].currency

    const updates: string[] = []
    const values: unknown[] = []
    let index = 1
    let newCurrency: string | null = null

    if (body.currency !== undefined) {
      const currency = String(body.currency).trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError(422, 'validation_failed', 'Currency must be a three-letter ISO code.')
      newCurrency = currency
      updates.push(`currency = $${index++}`); values.push(currency)
    }
    if (body.timezone !== undefined) {
      const timezone = String(body.timezone).trim()
      if (!timezone) throw new ApiError(422, 'validation_failed', 'Timezone is required.')
      try { await db.query('select timezone($1, now())', [timezone]) }
      catch { throw new ApiError(422, 'validation_failed', 'Timezone is not a recognized zone name.') }
      updates.push(`timezone = $${index++}`); values.push(timezone)
    }
    if (body.address !== undefined) {
      const address = body.address === null ? null : String(body.address).trim()
      if (address && address.length > 240) throw new ApiError(422, 'validation_failed', 'Address must be 240 characters or fewer.')
      updates.push(`address = $${index++}`); values.push(address || null)
    }
    if (body.country !== undefined) {
      const country = body.country === null ? null : String(body.country).trim().toUpperCase()
      if (country && !/^[A-Z]{2}$/.test(country)) throw new ApiError(422, 'validation_failed', 'Country must be a two-letter ISO code.')
      updates.push(`country = $${index++}`); values.push(country || null)
    }
    if (!updates.length) throw new ApiError(422, 'validation_failed', 'No fields to update were provided.')

    const changingCurrency = newCurrency !== null && newCurrency !== currentCurrency
    const client = await db.connect()
    try {
      await client.query('begin')
      if (changingCurrency) {
        // Product creation and order push also lock this row, so the empty-store check
        // cannot race with either operation.
        await client.query('select last_position from public.pos_sync_feed_state where store_id=$1 for update', [storeId])
        const activity = await client.query(`select
          exists(select 1 from public.pos_products where store_id=$1) as products,
          exists(select 1 from public.pos_orders where store_id=$1) as orders`, [storeId])
        if (activity.rows[0]?.products || activity.rows[0]?.orders) {
          throw new ApiError(409, 'currency_change_blocked', 'Currency can only change before products or sales have been created for this store.')
        }
      }
      values.push(storeId)
      const result = await client.query(
        `update public.stores set ${updates.join(', ')}, updated_at = now() where id = $${index}
         returning id, name, timezone, currency, address, country`,
        values,
      )
      if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Store not found.')

      await client.query('commit')
      res.json(result.rows[0])
    } catch (reason) {
      await client.query('rollback')
      throw reason
    } finally {
      client.release()
    }
  } catch (reason) { sendApiError(res, reason) }
}

export const storesRouter = Router()
storesRouter.get('/:id', (req, res) => void getStore(req, res))
storesRouter.patch('/:id', (req, res) => void patchStore(req, res))
