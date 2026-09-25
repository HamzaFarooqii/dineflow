import { useEffect, useState, type FormEvent } from 'react'
import { formatCents } from '../../../../packages/domain/src/money'
import { createPromotion, fetchPromotions, updatePromotion, type Promotion } from '../lib/promotions'
import { requireSupabase } from '../lib/supabase'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import { SelectField } from '../components/SelectField'
import './promotions.css'

// A configured campaign a manager sets up ahead of time -- distinct from the per-line discount a
// cashier applies at checkout in the register (packages/domain/src/money.ts's LineDiscount is
// applied there directly; this screen never touches that flow). Mirrors floor/FloorScreen.tsx's
// resolve-storeId-then-CRUD shape.

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
function fromDatetimeLocal(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isLive(promotion: Promotion, now: Date): boolean {
  if (!promotion.active) return false
  if (promotion.starts_at && now < new Date(promotion.starts_at)) return false
  if (promotion.ends_at && now > new Date(promotion.ends_at)) return false
  return true
}

function discountLabel(promotion: Promotion): string {
  return promotion.discount_kind === 'percent'
    ? `${(promotion.discount_value / 100).toFixed(1)}% off`
    : `${formatCents(promotion.discount_value)} off`
}

interface PromotionForm { name: string; kind: 'percent' | 'fixed'; percent: string; cents: string; startsAt: string; endsAt: string }
const EMPTY_FORM: PromotionForm = { name: '', kind: 'percent', percent: '', cents: '', startsAt: '', endsAt: '' }

function parseFormValue(form: PromotionForm): number | null {
  if (form.kind === 'percent') {
    const percent = Number(form.percent)
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null
    return Math.round(percent * 100)
  }
  const dollars = Number(form.cents)
  if (!Number.isFinite(dollars) || dollars <= 0) return null
  return Math.round(dollars * 100)
}

export function PromotionsScreen() {
  const [storeId, setStoreId] = useState('')
  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState<PromotionForm>(EMPTY_FORM)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState('')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<PromotionForm>(EMPTY_FORM)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState('')

  const reload = async (id: string) => setPromotions(await fetchPromotions(id))

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        if (!navigator.onLine) throw new Error('Connect to manage promotions.')
        const client = requireSupabase()
        const { data: { user }, error: userError } = await client.auth.getUser()
        if (userError || !user) throw new Error('Sign in to manage promotions.')
        const { data, error: membershipError } = await client.from('store_memberships').select('store_id,role')
          .eq('user_id', user.id).eq('active', true).in('role', ['owner', 'manager']).limit(1)
        if (membershipError) throw membershipError
        const id = data?.[0]?.store_id
        if (!id) throw new Error('Store access is unavailable.')
        if (active) setStoreId(id)
        await reload(id)
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Could not load promotions.') }
      finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    const value = parseFormValue(createForm)
    if (!createForm.name.trim() || value === null) {
      setCreateError(createForm.kind === 'percent' ? 'Enter a name and a percent between 0 and 100.' : 'Enter a name and a positive dollar amount.')
      return
    }
    const startsAt = fromDatetimeLocal(createForm.startsAt)
    const endsAt = fromDatetimeLocal(createForm.endsAt)
    if (startsAt && endsAt && startsAt > endsAt) { setCreateError('Start must be before end.'); return }
    setCreateBusy(true); setCreateError('')
    try {
      await createPromotion(storeId, { name: createForm.name.trim(), discount_kind: createForm.kind, discount_value: value, starts_at: startsAt, ends_at: endsAt })
      setCreateForm(EMPTY_FORM); setCreateOpen(false)
      await reload(storeId)
    } catch (reason) { setCreateError(reason instanceof Error ? reason.message : 'Could not create this promotion.') }
    finally { setCreateBusy(false) }
  }

  function openEdit(promotion: Promotion) {
    setEditingId(promotion.id)
    setEditError('')
    setEditForm({
      name: promotion.name, kind: promotion.discount_kind,
      percent: promotion.discount_kind === 'percent' ? String(promotion.discount_value / 100) : '',
      cents: promotion.discount_kind === 'fixed' ? String(promotion.discount_value / 100) : '',
      startsAt: toDatetimeLocal(promotion.starts_at), endsAt: toDatetimeLocal(promotion.ends_at),
    })
  }

  async function handleSaveEdit(promotion: Promotion) {
    const value = parseFormValue(editForm)
    if (!editForm.name.trim() || value === null) {
      setEditError(editForm.kind === 'percent' ? 'Enter a name and a percent between 0 and 100.' : 'Enter a name and a positive dollar amount.')
      return
    }
    const startsAt = fromDatetimeLocal(editForm.startsAt)
    const endsAt = fromDatetimeLocal(editForm.endsAt)
    if (startsAt && endsAt && startsAt > endsAt) { setEditError('Start must be before end.'); return }
    setEditBusy(true); setEditError('')
    try {
      await updatePromotion(storeId, promotion.id, { name: editForm.name.trim(), discount_kind: editForm.kind, discount_value: value, starts_at: startsAt, ends_at: endsAt })
      setEditingId(null)
      await reload(storeId)
    } catch (reason) { setEditError(reason instanceof Error ? reason.message : 'Could not save this promotion.') }
    finally { setEditBusy(false) }
  }

  async function handleToggleActive(promotion: Promotion) {
    if (promotion.active && !window.confirm(`Deactivate "${promotion.name}"? It can be reactivated later.`)) return
    setEditBusy(true)
    try {
      await updatePromotion(storeId, promotion.id, { active: !promotion.active })
      await reload(storeId)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update this promotion.') }
    finally { setEditBusy(false) }
  }

  const now = new Date()

  return <section className="promotions-page">
    <PageHeader
      kicker="RESTAURANT MANAGEMENT"
      title="Promotions"
      subtitle="Campaigns you configure ahead of time. Not applied at checkout automatically yet."
      actions={<button type="button" className="secondary-cta" onClick={() => { setCreateOpen(value => !value); setCreateError('') }}>{createOpen ? 'Cancel' : 'New promotion'}</button>}
    />
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {loading && !error && <p role="status">Loading promotions…</p>}

    {createOpen && <form className="promotions-inline-form" onSubmit={event => void handleCreate(event)}>
      <label>Name<input type="text" maxLength={60} value={createForm.name} onChange={event => setCreateForm(form => ({ ...form, name: event.target.value }))} /></label>
      <SelectField label="Discount type" value={createForm.kind} onChange={event => setCreateForm(form => ({ ...form, kind: event.target.value as 'percent' | 'fixed' }))}>
        <option value="percent">Percent off</option>
        <option value="fixed">Fixed amount off</option>
      </SelectField>
      {createForm.kind === 'percent'
        ? <label>Percent off<input type="number" min={0} max={100} step="0.1" value={createForm.percent} onChange={event => setCreateForm(form => ({ ...form, percent: event.target.value }))} /></label>
        : <label>Dollars off<input type="number" min={0} step="0.01" value={createForm.cents} onChange={event => setCreateForm(form => ({ ...form, cents: event.target.value }))} /></label>}
      <label>Starts (optional)<input type="datetime-local" value={createForm.startsAt} onChange={event => setCreateForm(form => ({ ...form, startsAt: event.target.value }))} /></label>
      <label>Ends (optional)<input type="datetime-local" value={createForm.endsAt} onChange={event => setCreateForm(form => ({ ...form, endsAt: event.target.value }))} /></label>
      <div className="promotions-inline-form-actions">
        <button type="submit" className="secondary-cta" disabled={createBusy}>{createBusy ? 'Adding…' : 'Add promotion'}</button>
      </div>
      {createError && <p className="form-notice error" role="alert">{createError}</p>}
    </form>}

    {!loading && !error && promotions.length === 0 && !createOpen && <p className="promotions-empty">No promotions set up yet. Click "New promotion" to add one.</p>}

    {!loading && !error && promotions.length > 0 && <ul className="promotions-list">
      {promotions.map(promotion => <li key={promotion.id} className="promotions-item">
        {editingId === promotion.id ? <div className="promotions-inline-form promotions-edit-form">
          <label>Name<input type="text" maxLength={60} value={editForm.name} onChange={event => setEditForm(form => ({ ...form, name: event.target.value }))} /></label>
          <SelectField label="Discount type" value={editForm.kind} onChange={event => setEditForm(form => ({ ...form, kind: event.target.value as 'percent' | 'fixed' }))}>
            <option value="percent">Percent off</option>
            <option value="fixed">Fixed amount off</option>
          </SelectField>
          {editForm.kind === 'percent'
            ? <label>Percent off<input type="number" min={0} max={100} step="0.1" value={editForm.percent} onChange={event => setEditForm(form => ({ ...form, percent: event.target.value }))} /></label>
            : <label>Dollars off<input type="number" min={0} step="0.01" value={editForm.cents} onChange={event => setEditForm(form => ({ ...form, cents: event.target.value }))} /></label>}
          <label>Starts (optional)<input type="datetime-local" value={editForm.startsAt} onChange={event => setEditForm(form => ({ ...form, startsAt: event.target.value }))} /></label>
          <label>Ends (optional)<input type="datetime-local" value={editForm.endsAt} onChange={event => setEditForm(form => ({ ...form, endsAt: event.target.value }))} /></label>
          <div className="promotions-inline-form-actions">
            <button type="button" className="text-action" onClick={() => setEditingId(null)}>Cancel</button>
            <button type="button" className="secondary-cta" disabled={editBusy} onClick={() => void handleSaveEdit(promotion)}>{editBusy ? 'Saving…' : 'Save changes'}</button>
          </div>
          {editError && <p className="form-notice error" role="alert">{editError}</p>}
        </div> : <>
          <div className="promotions-item-info">
            <strong>{promotion.name}</strong>
            <span>{discountLabel(promotion)}</span>
            {(promotion.starts_at || promotion.ends_at) && <small>
              {promotion.starts_at ? new Date(promotion.starts_at).toLocaleString() : 'No start'} – {promotion.ends_at ? new Date(promotion.ends_at).toLocaleString() : 'No end'}
            </small>}
          </div>
          <StatusBadge tone={isLive(promotion, now) ? 'success' : promotion.active ? 'muted' : 'danger'}>
            {isLive(promotion, now) ? 'Live now' : promotion.active ? 'Scheduled' : 'Inactive'}
          </StatusBadge>
          <div className="promotions-item-actions">
            <button type="button" className="secondary-cta" onClick={() => openEdit(promotion)}>Edit</button>
            <button type="button" className="text-action" disabled={editBusy} onClick={() => void handleToggleActive(promotion)}>{promotion.active ? 'Deactivate' : 'Reactivate'}</button>
          </div>
        </>}
      </li>)}
    </ul>}
  </section>
}
