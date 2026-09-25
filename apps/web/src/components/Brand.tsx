import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'

// Shared by App.tsx (the logged-in shell, auth pages) and Landing.tsx (the marketing page) --
// pulled out of App.tsx to avoid a circular import (Landing.tsx would otherwise need to import
// from the very file that imports Landing.tsx to render the "/" route).
export function Mark() { return <span aria-hidden="true" className="leaf-mark">⌁</span> }
export function Brand({ dark = false }: { dark?: boolean }) { return <Link className={`brand ${dark ? 'brand-dark' : ''}`} to="/"><Mark />Dineflow <small>RESTAURANT OPERATING SYSTEM</small></Link> }
export function Button({ children, to, disabled = false, type = 'button', onClick }: { children: ReactNode, to?: string, disabled?: boolean, type?: 'button' | 'submit', onClick?: () => void }) { return to ? <Link className="cta" to={to}>{children}<b aria-hidden="true">→</b></Link> : <button className="cta" type={type} disabled={disabled} onClick={onClick}>{children}<b aria-hidden="true">→</b></button> }
