import { KITCHEN_TICKET_STATUS_LABELS, KITCHEN_TICKET_STATUS_TONE, type KitchenTicketStatus } from '../../../../../packages/domain/src/kitchen-ticket-status'
import type { KitchenTicket } from '../../lib/kitchen'
import { StatusBadge } from '../../components/StatusBadge'

// The next forward action for a ticket item — queued -> preparing -> ready -> served. Cancelling
// isn't exposed here (Definition of Done only asks for advancing); the API still enforces the
// full KITCHEN_TICKET_ITEM_TRANSITIONS contract regardless of what this card offers.
const NEXT_ACTION: Partial<Record<KitchenTicketStatus, { next: KitchenTicketStatus; label: string }>> = {
  queued: { next: 'preparing', label: 'Fire' },
  preparing: { next: 'ready', label: 'Mark ready' },
  ready: { next: 'served', label: 'Serve' },
}

function elapsedLabel(createdAt: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 60_000))
  if (minutes < 1) return 'just fired'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// The reusable Kitchen Display ticket primitive (Blueprint docs/09, Day 2) — mirrors the shape
// of floor/TableCard.tsx: one status chip per item via the shared <StatusBadge>, plus a single
// forward-advance control per item.
export function KitchenTicketCard({ ticket, orderTypeLabel, busyItemId, onAdvance }: {
  ticket: KitchenTicket
  orderTypeLabel: string
  busyItemId: string | null
  onAdvance: (itemId: string, nextStatus: KitchenTicketStatus) => void
}) {
  return <article className="kitchen-ticket-card">
    <header className="kitchen-ticket-head">
      <span className="kitchen-ticket-ref">{ticket.table_label ? `Table ${ticket.table_label}` : orderTypeLabel}</span>
      <span className="kitchen-ticket-elapsed">{elapsedLabel(ticket.created_at)}</span>
    </header>
    <p className="kitchen-ticket-meta">{ticket.receipt_number} · {orderTypeLabel}</p>
    <ul className="kitchen-ticket-items">
      {ticket.items.map(item => {
        const action = NEXT_ACTION[item.status]
        return <li key={item.id} className="kitchen-ticket-item">
          <span className="kitchen-item-name"><b>{item.quantity}×</b> {item.snapshot_name}{item.station_name && <small> · {item.station_name}</small>}</span>
          <StatusBadge tone={KITCHEN_TICKET_STATUS_TONE[item.status]}>{KITCHEN_TICKET_STATUS_LABELS[item.status]}</StatusBadge>
          {action && <button type="button" className="secondary-cta" disabled={busyItemId === item.id}
            onClick={() => onAdvance(item.id, action.next)}>{busyItemId === item.id ? 'Updating…' : action.label}</button>}
        </li>
      })}
    </ul>
  </article>
}
