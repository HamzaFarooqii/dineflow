import type { ReactNode } from 'react'

export type BadgeTone = 'success' | 'saffron' | 'info' | 'warning' | 'danger' | 'muted' | 'violet'

// The one status-chip component (docs/DESIGN_SYSTEM.md: "one pattern, reused across floor/
// kitchen/orders, not reinvented per screen"). Formalizes the .floor-status class family that
// already existed as copy-pasted markup in a dozen places into a real component -- same visual
// result, one place to change it. Never relies on color alone: the label text (and an optional
// leading icon) always carries the meaning too.
export function StatusBadge({ tone, children, icon }: { tone: BadgeTone; children: ReactNode; icon?: ReactNode }) {
  return <span className={`status-badge status-badge-${tone}`}>
    {icon && <span aria-hidden="true" className="status-badge-icon">{icon}</span>}
    {children}
  </span>
}
