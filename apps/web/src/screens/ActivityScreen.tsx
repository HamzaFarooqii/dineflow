import { useEffect, useState } from 'react'
import { resolveFinancialAccess } from '../lib/management-access'
import { fetchAuditLog, type ServerAuditEntry } from '../lib/server-audit'
import './reporting.css'

function AccessMessage({ message }: { message: string }) {
  return (
    <section className="reporting-page report-access" role="alert">
      <h2>Activity log unavailable</h2>
      <p>{message}</p>
    </section>
  )
}

const actionLabels: Record<string, string> = {
  'terminal.revoked': 'Terminal revoked',
  'terminal.reactivated': 'Terminal reactivated',
  'employee.created': 'Employee created',
  'employee.updated': 'Employee updated',
}

function describeAction(action: string): string {
  return actionLabels[action] ?? action
}

export function ActivityScreen() {
  const [entries, setEntries] = useState<ServerAuditEntry[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void resolveFinancialAccess()
      .then(access => fetchAuditLog(access.storeId))
      .then(result => { if (active) setEntries(result) })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load the activity log.') })
    return () => { active = false }
  }, [])
  if (error) return <AccessMessage message={error} />
  return (
    <section className="reporting-page activity-page">
      <header className="reporting-heading">
        <div>
          <p className="kicker">STORE ADMINISTRATION</p>
          <h1>Store activity.</h1>
          <p>A record of sensitive management actions taken in this store, newest first.</p>
        </div>
      </header>
      {!entries && <p role="status">Loading activity…</p>}
      {entries && entries.length === 0 && <p className="team-empty">No activity has been recorded for this store yet.</p>}
      {entries && entries.length > 0 && (
        <ul className="activity-list">
          {entries.map(entry => (
            <li key={entry.id}>
              <div className="activity-line">
                <strong>{describeAction(entry.action)}</strong>
                <span>{entry.target}</span>
              </div>
              <small>
                {entry.actorName ?? 'A team member'} · {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.createdAt))}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
