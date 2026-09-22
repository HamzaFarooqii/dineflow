import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { requireSupabase, supabase } from '../lib/supabase'
import { activeStoreId } from '../lib/catalog'
import { request } from './api'
import { readTerminal, type TerminalCache } from './cache'
import { TerminalState } from './TerminalStatus'
import type { Management } from './types'
import './settings-overview.css'

interface StoreAccess { storeId: string; role: string }
interface TeamMember { user_id: string; role: string; active: boolean; joined_at: string; profiles: { full_name: string }[] }
function CardIcon({ children }: { children: string }) { return <span className="settings-icon" aria-hidden="true">{children}</span> }

export function SettingsOverview() {
  const [access, setAccess] = useState<StoreAccess>()
  const [management, setManagement] = useState<Management>({ employees: [], devices: [] })
  const [team, setTeam] = useState<TeamMember[]>([])
  const [terminal, setTerminal] = useState<TerminalCache>()
  const [loading, setLoading] = useState(Boolean(supabase))
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const loadTeam = async (storeId: string) => {
    const client = requireSupabase()
    const { data: memberships, error: membershipError } = await client.from('store_memberships')
      .select('user_id, role, active, joined_at').eq('store_id', storeId).eq('active', true).order('joined_at')
    if (membershipError) throw membershipError
    const ids = (memberships ?? []).map(member => member.user_id)
    const { data: profiles, error: profileError } = ids.length
      ? await client.from('profiles').select('id, full_name').in('id', ids)
      : { data: [], error: null }
    if (profileError) throw profileError
    const names = new Map((profiles ?? []).map(profile => [profile.id, profile.full_name]))
    setTeam((memberships ?? []).map(member => ({ ...member, profiles: names.has(member.user_id) ? [{ full_name: names.get(member.user_id)! }] : [] })))
  }
  const load = async () => {
    if (!supabase) { setLoading(false); return }
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError) throw userError
      if (!user) throw new Error('Sign in with your owner or manager email account.')
      // Resolve the account's chosen store through the same activeStoreId() every other screen
      // uses, instead of independently re-picking "any active membership, limit 1" here — that
      // used to let Settings show a different store than Register/Dashboard for a multi-store user.
      const storeId = await activeStoreId()
      const { data, error: membershipError } = await supabase.from('store_memberships').select('role').eq('user_id', user.id).eq('store_id', storeId).eq('active', true).limit(1)
      if (membershipError) throw membershipError
      const role = data?.[0]?.role
      if (!role) throw new Error('No active store membership was found.')
      setAccess({ storeId, role })
      await loadTeam(storeId)
      if (role === 'owner' || role === 'manager') {
        const [nextManagement, nextTerminal] = await Promise.all([request<Management>(`/terminal-auth/manage/${storeId}`, undefined, true), readTerminal()])
        setManagement(nextManagement); setTerminal(nextTerminal)
      }
    } catch (reason) { setLoadError(reason instanceof Error ? reason.message : 'Unable to load restaurant settings.') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!access) return
    setError(''); setMessage('')
    try {
      const form = new FormData(event.currentTarget)
      const { error: inviteError } = await requireSupabase().rpc('invite_store_member', { p_store_id: access.storeId, p_email: String(form.get('email')).trim(), p_role: String(form.get('role')) })
      if (inviteError) throw inviteError
      event.currentTarget.reset(); await loadTeam(access.storeId); setMessage('Invitation saved. The team member can accept it after signing in.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to invite this team member.') }
  }
  const canManagePos = access?.role === 'owner' || access?.role === 'manager'
  const activeDevices = management.devices.filter(device => !device.revoked_at).length
  const activeEmployees = management.employees.filter(employee => employee.active).length
  const lastSynced = terminal ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(terminal.validated_at)) : ''
  return <section className="settings-page settings-overview">
    <div className="settings-heading"><CardIcon>⚙</CardIcon><div><p className="kicker">RESTAURANT ADMINISTRATION</p><h1>Restaurant settings</h1><p>Manage your team, service terminals, and staff PIN access.</p></div></div>
    {loading ? <p className="form-notice" role="status">Loading restaurant settings…</p> : loadError ? <p className="form-notice error" role="alert">{loadError}</p> : <>
      {canManagePos && <section aria-labelledby="pos-setup-title">
        <h2 id="pos-setup-title" className="settings-section-title">Service setup</h2>
        <div className="pos-setup-cards">
          <article className="setup-card"><CardIcon>⚑</CardIcon><div>
            <div className="card-title"><h3>Restaurant details</h3></div>
            <p>Currency, timezone, address and country used across guest checks and reporting.</p>
            <Link className="cta" to="/settings/store">Edit details <b aria-hidden="true">→</b></Link>
          </div></article>
          <article className="setup-card"><CardIcon>▣</CardIcon><div>
            <div className="card-title"><h3>Terminals</h3><span className="count-badge">{activeDevices} active {activeDevices === 1 ? 'terminal' : 'terminals'}</span></div>
            <p>Provision and manage the devices your team uses at the pass and the host stand.</p>
            <Link className="cta" to="/settings/terminals">Manage terminals <b aria-hidden="true">→</b></Link>
          </div></article>
          <article className="setup-card"><CardIcon>♧</CardIcon><div>
            <div className="card-title"><h3>Service staff</h3><span className="count-badge">{activeEmployees} active {activeEmployees === 1 ? 'staff member' : 'staff'}</span></div>
            <p>Issue staff PINs and control who can open a terminal on the floor.</p>
            <Link className="cta" to="/settings/employees">Manage staff <b aria-hidden="true">→</b></Link>
          </div></article>
          <article className="setup-card"><CardIcon>▤</CardIcon><div>
            <div className="card-title"><h3>Activity log</h3></div>
            <p>Review terminal and staff changes made by your team.</p>
            <Link className="cta" to="/settings/activity">View activity <b aria-hidden="true">→</b></Link>
          </div></article>
        </div>
      </section>}
      <div className="settings-columns">
        <section className="team-section" aria-labelledby="store-team-title">
          <h2 id="store-team-title" className="settings-section-title">Management team</h2>
          <p>Invite the owners and managers who need email access to Dineflow.</p>
          {canManagePos ? <form className="invite-form" onSubmit={submitInvite}>
            <h3>Invite new team member</h3>
            <label>Work email<input name="email" type="email" autoComplete="email" placeholder="name@restaurant.com" required /></label>
            <label>Role<select name="role" defaultValue="manager"><option value="manager">Manager</option><option value="cashier">Cashier</option></select></label>
            <button className="cta" type="submit">Send invite <b aria-hidden="true">→</b></button>
          </form> : <p className="form-notice">You do not have permission to manage this restaurant.</p>}
          <section className="team-members" aria-label="Current store team">
            <h3>Team members ({team.length})</h3>
            {team.length ? <ul>{team.map(member => <li key={member.user_id}>
              <span className="team-avatar">{(member.profiles[0]?.full_name || 'Team member').slice(0, 2).toUpperCase()}</span>
              <span><strong>{member.profiles[0]?.full_name || 'Team member'}</strong><small>{member.role}</small></span>
              <b className={`team-role ${member.role}`}>{member.role}</b>
              <span className="team-active">Active</span>
            </li>)}</ul> : <p className="team-empty">No team members are active in this restaurant yet.</p>}
          </section>
          {error && <p className="form-notice error" role="alert">{error}</p>}
          {message && <p className="form-notice" role="status">{message}</p>}
        </section>
        <aside className="this-terminal-card">
          <h2>This terminal</h2>
          {terminal ? <>
            <div className="terminal-summary"><CardIcon>▣</CardIcon><div>
              <div className="card-title"><h3>{terminal.device.name}</h3><TerminalState terminal={terminal} /></div>
              <p>Receipt prefix: <strong>{terminal.device.receipt_prefix}</strong></p>
            </div></div>
            <dl><div><dt>Receipt prefix</dt><dd>{terminal.device.receipt_prefix}</dd></div><div><dt>Last synced</dt><dd>{lastSynced}</dd></div></dl>
            <Link className="secondary-cta" to="/settings/terminals">Manage terminal</Link>
          </> : <div className="terminal-empty">
            <CardIcon>▣</CardIcon>
            <h3>No terminal connected?</h3>
            <p>Add a terminal to start taking orders and keep service running.</p>
            <Link className="cta" to="/settings/terminals">Add terminal <b aria-hidden="true">+</b></Link>
          </div>}
        </aside>
      </div>
    </>}
  </section>
}
