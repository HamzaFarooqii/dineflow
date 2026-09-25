import type { ReactNode } from 'react'

// The kicker/h1/subtitle/actions row every screen already hand-builds slightly differently
// (.floor-page-head, .reporting-heading, .order-history's own inline header, ...). One component
// going forward; existing screens keep their current markup until their own redesign pass rather
// than being force-migrated in this change.
export function PageHeader({ kicker, title, subtitle, actions }: {
  kicker?: string
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return <div className="page-header">
    <div>
      {kicker && <p className="kicker">{kicker}</p>}
      <h1>{title}</h1>
      {subtitle && <p className="page-header-subtitle">{subtitle}</p>}
    </div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </div>
}
