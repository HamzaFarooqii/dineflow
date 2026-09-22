import { useEffect, useState } from 'react'
import { resolveFinancialAccess } from '../lib/management-access'
import { fetchAuditLog, type ServerAuditEntry } from '../lib/server-audit'
import './activity.css'

function AccessMessage({ message }: { message: string }) {
  return (
    <section className="mise-log-page mise-log-alert" role="alert">
      <div>
        <h2>Activity log unavailable</h2>
        <p>{message}</p>
      </div>
    </section>
  )
}

const actionLabels: Record<string, string> = {
  'terminal.revoked': 'Terminal revoked',
  'terminal.reactivated': 'Terminal reactivated',
  'employee.created': 'Staff member added',
  'employee.updated': 'Staff member updated',
}

// Presentation only: the same semantic vocabulary the closed-check list and sync
// queue use — danger where access was taken away, success where it was restored,
// info for a routine record change.
const actionTones: Record<string, string> = {
  'terminal.revoked': 'danger',
  'terminal.reactivated': 'success',
}

function describeAction(action: string): string {
  return actionLabels[action] ?? action
}

function toneFor(action: string): string {
  return actionTones[action] ?? 'info'
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
    <section className="mise-log-page">
      <header className="mise-log-head">
        <p className="kicker">RESTAURANT ADMINISTRATION</p>
        <h1>Activity log.</h1>
        <p>A record of sensitive management actions taken in this restaurant, newest first.</p>
      </header>
      {!entries && <p role="status">Loading activity…</p>}
      {entries && entries.length === 0 && <p className="mise-log-empty">No activity has been recorded for this restaurant yet.</p>}
      {entries && entries.length > 0 && (
        <ul className="mise-log-list">
          {entries.map(entry => (
            <li key={entry.id}>
              <span className={`mise-log-tag ${toneFor(entry.action)}`}>{describeAction(entry.action)}</span>
              <div className="mise-log-row">
                <strong>{entry.target}</strong>
              </div>
              <small>
                {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.createdAt))}
                <span className="mise-log-actor">{entry.actorName ?? 'A team member'}</span>
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
