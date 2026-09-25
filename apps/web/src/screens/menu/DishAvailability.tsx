import { StatusBadge } from '../../components/StatusBadge'

// Reads pos_products.is_available / unavailable_until (Blueprint Section 3). Renders nothing
// for an available dish — the badge should only interrupt a cashier's scan when it matters.
export function DishAvailability({ isAvailable, unavailableUntil }: { isAvailable?: boolean; unavailableUntil?: string | null }) {
  if (isAvailable === undefined || isAvailable) return null
  const until = unavailableUntil ? new Date(unavailableUntil) : null
  const untilLabel = until && !Number.isNaN(until.getTime()) ? ` until ${until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''
  return <StatusBadge tone="danger"><span role="status">Unavailable{untilLabel}</span></StatusBadge>
}
