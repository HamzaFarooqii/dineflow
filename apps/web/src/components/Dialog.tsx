import { useEffect, useRef, type ReactNode } from 'react'
import { X } from './icons'

// The one dialog shell, extracted from ManagerApprovalModal's focus-trap logic (the app's
// original "one true modal") so it can be shared instead of re-implemented per screen.
// CustomerSelector migrated onto this from its own hand-rolled .crm-overlay/.crm-dialog overlay
// during the Sell/POS redesign pass -- its content (a two-column guest finder) is wider than a
// typical confirmation dialog, hence the optional className to opt into the .dialog-panel.wide
// modifier rather than every Dialog defaulting to that width.
export function Dialog({ title, kicker, onClose, children, labelledBy, className }: {
  title?: ReactNode
  kicker?: ReactNode
  onClose: () => void
  children: ReactNode
  labelledBy?: string
  className?: string
}) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useRef(`dialog-title-${Math.random().toString(36).slice(2)}`).current

  useEffect(() => {
    closeButton.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return }
      if (event.key !== 'Tab' || !dialog.current) return
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href]')]
      if (!focusable.length) return
      const first = focusable[0], last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  return <div className="dialog-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialog} className={className ? `dialog-panel ${className}` : 'dialog-panel'} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? (title ? titleId : undefined)}>
      {title && <div className="dialog-head">
        <div>{kicker && <p className="kicker">{kicker}</p>}<h2 id={titleId}>{title}</h2></div>
        <button ref={closeButton} type="button" className="dialog-close" onClick={onClose} aria-label="Close"><X aria-hidden="true" size={18} /></button>
      </div>}
      {!title && <button ref={closeButton} type="button" className="dialog-close dialog-close-untitled" onClick={onClose} aria-label="Close"><X aria-hidden="true" size={18} /></button>}
      <div className="dialog-body">{children}</div>
    </div>
  </div>
}
