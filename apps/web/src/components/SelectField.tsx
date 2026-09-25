import type { ReactNode, SelectHTMLAttributes } from 'react'
import { ChevronDown } from './icons'

// A styled wrapper around a native <select> -- still a real native select underneath (keyboard
// nav, screen-reader semantics, mobile picker UI all come for free), just no longer bare browser
// chrome. docs/DESIGN_SYSTEM.md previously called a custom dropdown unjustified for one use
// site; there are now five-plus (store switcher, currency/timezone, role pickers, unit picker),
// enough real reuse to give the native select an actual visual treatment instead of leaving it
// unstyled everywhere it appears.
export function SelectField({ label, children, className, ...selectProps }: {
  label?: ReactNode
  className?: string
} & SelectHTMLAttributes<HTMLSelectElement>) {
  const select = <span className="select-field">
    <select className={className} {...selectProps}>{children}</select>
    <ChevronDown aria-hidden="true" size={16} className="select-field-chevron" />
  </span>
  if (!label) return select
  return <label className="select-field-label">{label}{select}</label>
}
