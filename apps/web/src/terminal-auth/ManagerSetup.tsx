import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { AppLayout } from '../App'
import { requireSupabase } from '../lib/supabase'
import { request } from './api'
import { provisionTerminal } from './cache'
import type { ManagedEmployee, Management } from './types'
import { PageHeader } from '../components/PageHeader'
import { SelectField } from '../components/SelectField'
import { StatusBadge } from '../components/StatusBadge'
import { Monitor, Users } from '../components/icons'
import { STAFF_ROLES, STAFF_ROLE_LABELS } from '../../../../packages/domain/src/staff-role'
import './terminal-auth.css'
import { TerminalHardwareSettings } from './hardware/TerminalHardwareSettings'

export function ManagerSetup({ screen }: { screen: 'terminals' | 'employees' }) {
  const [stores, setStores] = useState<{ id: string; name: string }[]>([])
  const [storeId, setStoreId] = useState('')
  const [management, setManagement] = useState<Management>({ employees: [], devices: [] })
  const [editing, setEditing] = useState<ManagedEmployee>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => { setEditing(undefined); setMessage('') }, [screen])
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const client = requireSupabase()
        const { data: { user }, error: userError } = await client.auth.getUser()
        if (userError) throw userError
        if (!user) throw new Error('Sign in with your owner or manager email account.')
        const { data, error: membershipError } = await client.from('store_memberships').select('store_id').eq('user_id', user.id).eq('active', true).in('role', ['owner', 'manager'])
        if (membershipError) throw membershipError
        if (!data?.length) throw new Error('An active owner or manager membership is required.')
        const result = await client.from('stores').select('id,name').in('id', data.map(row => row.store_id))
        if (result.error) throw result.error
        if (active) { setStores(result.data); setStoreId(result.data[0]?.id ?? '') }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load restaurants.') }
      finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!storeId) return
    let active = true
    setLoading(true); setError(''); setEditing(undefined); setManagement({ employees: [], devices: [] })
    void request<Management>(`/terminal-auth/manage/${storeId}`, undefined, true)
      .then(data => { if (active) setManagement(data) })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load terminal setup.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [storeId])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget, values = new FormData(form)
    setBusy(true); setError(''); setMessage('')
    try {
      if (screen === 'terminals') {
        await provisionTerminal(storeId, String(values.get('name')).trim())
        setMessage('This browser is provisioned. Open cashier sign in to unlock the terminal.')
      } else {
        await request('/terminal-auth/employees', { store_id: storeId, id: editing?.id, name: String(values.get('name')).trim(), role: values.get('role'), active: values.get('active') === 'on', pin: String(values.get('pin') ?? '') }, true)
        setEditing(undefined)
        setMessage('Staff member saved. Refresh connected terminals to update offline access.')
      }
      form.reset()
      setManagement(await request<Management>(`/terminal-auth/manage/${storeId}`, undefined, true))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save setup.') }
    finally { setBusy(false) }
  }
  async function revoke(id: string) {
    setBusy(true); setError(''); setMessage('')
    try {
      await request(`/terminal-auth/devices/${id}/revoke`, { store_id: storeId }, true)
      setManagement(await request<Management>(`/terminal-auth/manage/${storeId}`, undefined, true))
      setMessage('Terminal revoked. Offline access expires within its existing seven-day window; connected terminals lock on refresh.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to revoke terminal.') }
    finally { setBusy(false) }
  }
  async function reactivate(id: string) {
    setBusy(true); setError(''); setMessage('')
    try {
      await request(`/terminal-auth/devices/${id}/reactivate`, { store_id: storeId }, true)
      setManagement(await request<Management>(`/terminal-auth/manage/${storeId}`, undefined, true))
      setMessage('Terminal reactivated. The browser that was using it must sign in again to resume service.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to reactivate terminal.') }
    finally { setBusy(false) }
  }
  const title = screen === 'terminals' ? 'Terminals' : 'Service staff'
  const description = screen === 'terminals' ? 'Provision and manage the devices your team uses at the pass and the host stand.' : 'Create staff PIN access and control who can open a terminal on the floor.'
  return <AppLayout><section className="terminal-admin-page">
    <nav className="breadcrumbs" aria-label="Breadcrumb"><Link to="/settings">Settings</Link><span>/</span><Link to="/settings">Service setup</Link><span>/</span><span>{title}</span></nav>
    <PageHeader kicker="SERVICE SETUP" title={title} subtitle={description} actions={<Link className="secondary-cta" to="/settings">Back to settings</Link>} />
    {error && <p role="alert" className="form-notice error">{error}</p>}
    {message && <p role="status" className="form-notice">{message}</p>}
    <div className="store-picker"><SelectField label="Restaurant" value={storeId} onChange={event => { setStoreId(event.target.value); setMessage('') }} disabled={busy || loading}>{!stores.length && <option value="">No managed restaurants available</option>}{stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</SelectField></div>
    {loading ? <p role="status" className="form-notice">Loading restaurant access…</p> : storeId && <>
      {screen === 'terminals' && <TerminalHardwareSettings storeId={storeId} storeName={stores.find(store => store.id === storeId)?.name ?? 'Selected restaurant'} devices={management.devices} />}
      <div className="terminal-admin-grid">
        <section className="admin-panel" id={screen === 'terminals' ? 'terminal-browser-setup' : undefined}>
          <h2>{screen === 'terminals' ? 'Set up this browser' : editing ? 'Edit staff member' : 'Add staff member'}</h2>
          <p>{screen === 'terminals' ? 'Provision this browser online to assign its terminal identity and receipt prefix.' : 'Service staff sign in with a PIN on a provisioned terminal. They do not need an email invitation.'}</p>
          <form key={`${screen}-${editing?.id ?? 'new'}`} onSubmit={event => void submit(event)}><fieldset disabled={busy}>
            <label>{screen === 'terminals' ? 'Terminal name' : 'Staff name'}<input name="name" required maxLength={80} defaultValue={editing?.name} autoComplete="off" placeholder={screen === 'terminals' ? 'Pass 1' : 'Full name'} /></label>
            {screen === 'employees' && <>
              <label>{editing ? 'New PIN (leave blank to keep current PIN)' : 'PIN'}<input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength={4} maxLength={8} required={!editing} autoComplete="new-password" aria-describedby="pin-help" /></label>
              <p id="pin-help" className="field-help">Use 4 to 8 digits. Give each staff member their own PIN.</p>
              <SelectField label="Floor role" name="role" defaultValue={editing?.role ?? 'cashier'}>
                {STAFF_ROLES.map(role => <option key={role} value={role}>{STAFF_ROLE_LABELS[role]}</option>)}
              </SelectField>
              <label className="terminal-check"><input name="active" type="checkbox" defaultChecked={editing?.active ?? true} />Active staff member</label>
            </>}
            <button className="cta" type="submit">{busy ? 'Saving…' : screen === 'terminals' ? 'Provision this browser' : editing ? 'Save staff member' : 'Add staff member'}</button>
            {editing && <button className="secondary-cta" type="button" onClick={() => setEditing(undefined)}>Cancel edit</button>}
          </fieldset></form>
        </section>
        <section className="admin-panel">
          <div className="panel-title">
            <div><h2>{screen === 'terminals' ? 'Restaurant terminals' : 'Service staff'}</h2><p>{screen === 'terminals' ? 'Each active terminal has a unique receipt prefix.' : 'Only active staff can unlock a terminal.'}</p></div>
            <span className="count-badge">{screen === 'terminals' ? management.devices.filter(device => !device.revoked_at).length : management.employees.filter(employee => employee.active).length} active</span>
          </div>
          <ul className="terminal-list">{screen === 'terminals' ? management.devices.map(device => <li key={device.id}>
            <span className="list-icon" aria-hidden="true"><Monitor size={16} /></span>
            <div><strong>{device.name}</strong><small>Receipt prefix: {device.receipt_prefix}</small></div>
            <StatusBadge tone={device.revoked_at ? 'muted' : 'success'}>{device.revoked_at ? 'Revoked' : 'Active'}</StatusBadge>
            {!device.revoked_at && <button type="button" className="text-button" disabled={busy} onClick={() => { if (window.confirm(`Revoke ${device.name}? Staff using this terminal will need manager provisioning again.`)) void revoke(device.id) }}>Revoke</button>}
            {device.revoked_at && <button type="button" className="text-button" disabled={busy} onClick={() => void reactivate(device.id)}>Reactivate</button>}
          </li>) : management.employees.map(employee => <li key={employee.id}>
            <span className="list-icon" aria-hidden="true"><Users size={16} /></span>
            <div><strong>{employee.name}</strong><small>{STAFF_ROLE_LABELS[employee.role]} PIN</small></div>
            <StatusBadge tone={employee.active ? 'success' : 'muted'}>{employee.active ? 'Active' : 'Inactive'}</StatusBadge>
            <button type="button" className="text-button" disabled={busy} onClick={() => { setEditing(employee); setMessage('') }}>Edit</button>
          </li>)}</ul>
          {(screen === 'terminals' ? !management.devices.length : !management.employees.length) && <div className="list-empty"><Monitor aria-hidden="true" size={20} /><p>No {screen === 'terminals' ? 'terminals' : 'staff'} yet.</p></div>}
        </section>
      </div>
    </>}
  </section></AppLayout>
}
