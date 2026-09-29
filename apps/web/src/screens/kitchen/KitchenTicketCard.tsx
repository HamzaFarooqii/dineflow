import { KITCHEN_TICKET_STATUS_LABELS, KITCHEN_TICKET_STATUS_TONE, type KitchenTicketStatus } from '../../../../../packages/domain/src/kitchen-ticket-status'
import { COURSE_LABELS, type Course } from '../../../../../packages/domain/src/course'
import type { KitchenTicket, KitchenTicketItem } from '../../lib/kitchen'
import { StatusBadge, type BadgeTone } from '../../components/StatusBadge'

// The next forward action for a ticket item — preparing -> ready -> served. 'queued' is
// deliberately absent here for an item that has a course: firing a course fires every item in it
// at once (the course bar below), not one item at a time. An item with no course (still possible
// for a product that predates course data, or was never given one) keeps the old per-item Fire
// button, unchanged. Cancelling isn't exposed here (Definition of Done only asks for advancing);
// the API still enforces the full KITCHEN_TICKET_ITEM_TRANSITIONS contract regardless.
const NEXT_ACTION: Partial<Record<KitchenTicketStatus, { next: KitchenTicketStatus; label: string }>> = {
  queued: { next: 'preparing', label: 'Fire' },
  preparing: { next: 'ready', label: 'Mark ready' },
  ready: { next: 'served', label: 'Serve' },
}

const SLA_TONE: Record<KitchenTicketItem['sla_state'], BadgeTone> = { calm: 'muted', warning: 'saffron', late: 'danger' }
const SLA_LABEL: Record<KitchenTicketItem['sla_state'], string> = { calm: 'On time', warning: 'Due soon', late: 'Late' }

function elapsedLabel(createdAt: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 60_000))
  if (minutes < 1) return 'just fired'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// The reusable Kitchen Display ticket primitive (Blueprint docs/09, Day 2) — mirrors the shape
// of floor/TableCard.tsx: one status chip per item via the shared <StatusBadge>, plus a single
// forward-advance control per item. A3 adds: an SLA chip per item (calm/warning/late, computed
// server-side against each item's own snapshotted prep-time target), and a course fire/hold bar
// for every course that still has queued items on this ticket.
export function KitchenTicketCard({ ticket, orderTypeLabel, busyItemId, busyCourse, onAdvance, onFireCourse, onHoldCourse }: {
  ticket: KitchenTicket
  orderTypeLabel: string
  busyItemId: string | null
  busyCourse: Course | null
  onAdvance: (itemId: string, nextStatus: KitchenTicketStatus) => void
  onFireCourse: (course: Course) => void
  onHoldCourse: (course: Course) => void
}) {
  const queuedCourses = [...new Set(ticket.items.filter(item => item.status === 'queued' && item.course).map(item => item.course as Course))]
  return <article className="kitchen-ticket-card">
    <header className="kitchen-ticket-head">
      <span className="kitchen-ticket-ref">{ticket.table_label ? `Table ${ticket.table_label}` : orderTypeLabel}</span>
      <span className="kitchen-ticket-elapsed">{elapsedLabel(ticket.created_at)}</span>
    </header>
    <p className="kitchen-ticket-meta">{ticket.receipt_number} · {orderTypeLabel}</p>
    {queuedCourses.map(course => {
      const count = ticket.items.filter(item => item.course === course && item.status === 'queued').length
      const held = ticket.items.some(item => item.course === course && item.status === 'queued' && item.held_at)
      return <div key={course} className="kitchen-course-bar">
        <span>{COURSE_LABELS[course]} · {count} item{count === 1 ? '' : 's'} {held && <em>held</em>}</span>
        <div className="kitchen-course-bar-actions">
          {!held && <button type="button" className="text-action" disabled={busyCourse === course} onClick={() => onHoldCourse(course)}>Hold</button>}
          <button type="button" className="secondary-cta" disabled={busyCourse === course} onClick={() => onFireCourse(course)}>{busyCourse === course ? 'Firing…' : `Fire ${COURSE_LABELS[course]}`}</button>
        </div>
      </div>
    })}
    <ul className="kitchen-ticket-items">
      {ticket.items.map(item => {
        const action = item.status === 'queued' && item.course ? undefined : NEXT_ACTION[item.status]
        return <li key={item.id} className="kitchen-ticket-item">
          <span className="kitchen-item-name"><b>{item.quantity}×</b> {item.snapshot_name}{item.station_name && <small> · {item.station_name}</small>}
            {Boolean(item.modifiers?.length) && <small className="kitchen-item-modifiers">{item.modifiers.map(modifier => modifier.option_name).join(' · ')}</small>}
          </span>
          <StatusBadge tone={KITCHEN_TICKET_STATUS_TONE[item.status]}>{KITCHEN_TICKET_STATUS_LABELS[item.status]}</StatusBadge>
          {(item.status === 'preparing' || item.status === 'ready') && <StatusBadge tone={SLA_TONE[item.sla_state]}>{SLA_LABEL[item.sla_state]}</StatusBadge>}
          {action && <button type="button" className="secondary-cta" disabled={busyItemId === item.id}
            onClick={() => onAdvance(item.id, action.next)}>{busyItemId === item.id ? 'Updating…' : action.label}</button>}
        </li>
      })}
    </ul>
  </article>
}
