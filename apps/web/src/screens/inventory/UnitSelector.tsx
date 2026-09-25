import { useMemo, useState } from 'react'
import type { RecipeUnit, UnitKind } from '../menu/recipe-draft'

// A curated starting set of common restaurant units, grouped the way the spec asks -- these are
// suggestions that create a real row in the store's own `units` table (via onCreateUnit,
// Ahmed's /catalog/units endpoint) the first time they're picked, not a separate unit system.
// Reusing the existing units table rather than inventing a parallel one for "common" units.
const COMMON_UNITS: { name: string; abbreviation: string; kind: UnitKind }[] = [
  { name: 'Milligram', abbreviation: 'mg', kind: 'mass' },
  { name: 'Gram', abbreviation: 'g', kind: 'mass' },
  { name: 'Kilogram', abbreviation: 'kg', kind: 'mass' },
  { name: 'Milliliter', abbreviation: 'ml', kind: 'volume' },
  { name: 'Liter', abbreviation: 'L', kind: 'volume' },
  { name: 'Piece', abbreviation: 'pcs', kind: 'count' },
  { name: 'Pack', abbreviation: 'pack', kind: 'count' },
  { name: 'Box', abbreviation: 'box', kind: 'count' },
  { name: 'Bottle', abbreviation: 'btl', kind: 'count' },
  { name: 'Can', abbreviation: 'can', kind: 'count' },
  { name: 'Tray', abbreviation: 'tray', kind: 'count' },
  { name: 'Bag', abbreviation: 'bag', kind: 'count' },
  { name: 'Portion', abbreviation: 'ptn', kind: 'count' },
  { name: 'Slice', abbreviation: 'slice', kind: 'count' },
  { name: 'Scoop', abbreviation: 'scoop', kind: 'count' },
]

const KIND_LABELS: Record<UnitKind, string> = { mass: 'Weight', volume: 'Volume', count: 'Count' }

export function UnitSelector({ units, value, onChange, onCreateUnit }: {
  units: RecipeUnit[]
  value: string
  onChange: (unitId: string) => void
  onCreateUnit: (unit: { name: string; abbreviation: string; kind: UnitKind }) => Promise<RecipeUnit>
}) {
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  const grouped = useMemo(() => {
    const term = search.trim().toLowerCase()
    const filtered = term ? units.filter(unit => unit.name.toLowerCase().includes(term) || unit.abbreviation.toLowerCase().includes(term)) : units
    const groups: Record<UnitKind, RecipeUnit[]> = { mass: [], volume: [], count: [] }
    for (const unit of filtered) groups[unit.kind].push(unit)
    return groups
  }, [units, search])

  const existingAbbreviations = useMemo(() => new Set(units.map(unit => unit.abbreviation.toLowerCase())), [units])
  const suggestions = useMemo(() => {
    const term = search.trim().toLowerCase()
    return COMMON_UNITS.filter(common => !existingAbbreviations.has(common.abbreviation.toLowerCase())
      && (!term || common.name.toLowerCase().includes(term) || common.abbreviation.toLowerCase().includes(term)))
  }, [existingAbbreviations, search])

  async function handleQuickAdd(common: { name: string; abbreviation: string; kind: UnitKind }) {
    setCreating(true); setCreateError('')
    try {
      const created = await onCreateUnit(common)
      onChange(created.id)
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : 'Could not add this unit.')
    } finally { setCreating(false) }
  }

  return <div className="unit-selector">
    <input type="search" className="unit-selector-search" placeholder="Search units…" value={search} onChange={event => setSearch(event.target.value)} aria-label="Search units" />
    <select aria-label="Unit" value={value} onChange={event => onChange(event.target.value)} size={Math.min(8, Math.max(4, units.length + suggestions.length))}>
      {value === '' && <option value="" disabled>Choose a unit</option>}
      {(Object.keys(grouped) as UnitKind[]).map(kind => grouped[kind].length > 0 && <optgroup key={kind} label={KIND_LABELS[kind]}>
        {grouped[kind].map(unit => <option key={unit.id} value={unit.id}>{unit.name} ({unit.abbreviation})</option>)}
      </optgroup>)}
    </select>
    {suggestions.length > 0 && <div className="unit-selector-suggestions">
      <span>Quick add:</span>
      {suggestions.slice(0, 8).map(common => (
        <button key={common.abbreviation} type="button" className="unit-suggestion-chip" disabled={creating} onClick={() => void handleQuickAdd(common)}>
          {common.name} ({common.abbreviation})
        </button>
      ))}
    </div>}
    {createError && <p className="form-notice error" role="alert">{createError}</p>}
  </div>
}
