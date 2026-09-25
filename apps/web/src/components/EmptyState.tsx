import type { ReactNode } from 'react'

// docs/DESIGN_SYSTEM.md previously documented this as an intentional gap: "a plain <p> with a
// specific message... no dedicated EmptyState component yet." Formalized now that the redesign
// needs the same shape (message + optional next action) in enough places -- Inventory's "No
// ingredients yet / Add your first ingredient", Orders' "No orders yet", etc. -- to be worth one
// real component instead of a bespoke <p> per screen. Text pattern stays the same: state the
// fact, not "no data".
export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state">
    <p className="empty-state-title">{title}</p>
    {description && <p className="empty-state-description">{description}</p>}
    {action && <div className="empty-state-action">{action}</div>}
  </div>
}
