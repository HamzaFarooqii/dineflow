import type { ReactNode } from 'react'
import { TrendingDown, TrendingUp, Minus } from './icons'

// The one KPI-card component. Before this it was duplicated verbatim under two names --
// ReportingScreens.tsx's ReportCard/.report-card and InventoryScreen's near-identical
// .inventory-summary-card, built independently within days of each other. One component now;
// both screens render through it (docs/DESIGN_SYSTEM.md: reuse, don't reinvent per screen).
export function MetricCard({ label, value, detail, featured = false, delta, className }: {
  label: string
  value: ReactNode
  detail?: ReactNode
  featured?: boolean
  delta?: { direction: 'up' | 'down' | 'flat'; label: string }
  className?: string
}) {
  return <article className={['metric-card', featured && 'featured', className].filter(Boolean).join(' ')}>
    <small>{label}</small>
    <strong>{value}</strong>
    {(detail || delta) && <div className="metric-card-footer">
      {detail && <span>{detail}</span>}
      {delta && <DeltaTag direction={delta.direction} label={delta.label} />}
    </div>}
  </article>
}

function DeltaTag({ direction, label }: { direction: 'up' | 'down' | 'flat'; label: string }) {
  const Icon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus
  return <span className={`delta-tag delta-tag-${direction}`}><Icon aria-hidden="true" size={12} />{label}</span>
}
