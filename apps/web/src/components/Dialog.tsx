import { useEffect, useRef, type ReactNode } from 'react'
import { X } from './icons'

// The one dialog shell, extracted from ManagerApprovalModal's focus-trap logic (the app's
// original "one true modal") so it can be shared instead of re-implemented per screen.
// CustomerSelector.tsx currently hand-rolls a second, undocumented overlay
// (.crm-overlay/.crm-dialog) with its own focus handling -- migrating it onto this is follow-up
// work for when the Register/CRM screens get their own redesign pass, not done in this change to
// avoid touching checkout-critical code without dedicated test time. New dialogs should use this
// rather than adding a third hand-rolled overlay.
export function Dialog({ title, onClose, children, labelledBy }: {
  title?: ReactNode
  onClose: () => void
  children: ReactNode
  labelledBy?: string
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
    <div ref={dialog} className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? (title ? titleId : undefined)}>
      {title && <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button ref={closeButton} type="button" className="dialog-close" onClick={onClose} aria-label="Close"><X aria-hidden="true" size={18} /></button>
      </div>}
      {!title && <button ref={closeButton} type="button" className="dialog-close dialog-close-untitled" onClick={onClose} aria-label="Close"><X aria-hidden="true" size={18} /></button>}
      <div className="dialog-body">{children}</div>
    </div>
  </div>
}
