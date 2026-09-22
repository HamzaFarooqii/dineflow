import type { RefObject } from 'react'

export function MenuSearch({ value, onChange, onSubmit, inputRef }: { value: string; onChange: (value: string) => void; onSubmit: () => void; inputRef: RefObject<HTMLInputElement | null> }) {
  return <label className="search" htmlFor="catalog-search"><span aria-hidden="true">⌕</span>
    <input id="catalog-search" ref={inputRef} type="search" placeholder="Search the menu by name, SKU or barcode — scan and press Enter" value={value}
      onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onSubmit() } }} />
  </label>
}
