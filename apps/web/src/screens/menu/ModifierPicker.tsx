import { useMemo, useState } from 'react'
import { formatCents } from '../../../../../packages/domain/src/money'
import { Dialog } from '../../components/Dialog'
import type { LocalModifierGroup, LocalProduct } from '../../lib/db'
import type { SelectedModifier } from '../../lib/pos-store'

export function modifierLineId(productId: string, modifiers: SelectedModifier[]): string {
  return `${productId}:${modifiers.map(modifier => modifier.optionId).sort().join(',')}`
}

function initialSelection(groups: LocalModifierGroup[], selected: SelectedModifier[]) {
  const ids = new Set(selected.map(modifier => modifier.optionId))
  for (const group of groups) {
    const active = group.options.filter(option => option.active)
    if (group.required && group.selection === 'single' && !active.some(option => ids.has(option.id)) && active[0]) ids.add(active[0].id)
  }
  return ids
}

export function ModifierPicker({ product, currency, initial = [], onClose, onApply }: {
  product: LocalProduct
  currency: string
  initial?: SelectedModifier[]
  onClose: () => void
  onApply: (modifiers: SelectedModifier[], unitPriceCents: number) => void
}) {
  const groups = [...(product.modifier_groups ?? [])].sort((a, b) => a.sort_order - b.sort_order)
  const [selected, setSelected] = useState(() => initialSelection(groups, initial))
  const [error, setError] = useState('')
  const selectedModifiers = useMemo(() => groups.flatMap(group => group.options
    .filter(option => option.active && selected.has(option.id))
    .map(option => ({ groupId: group.id, optionId: option.id, groupName: group.name, optionName: option.name, priceDeltaCents: option.price_delta_cents }))), [groups, selected])
  const unitPrice = product.unit_price_cents + selectedModifiers.reduce((sum, modifier) => sum + modifier.priceDeltaCents, 0)

  const toggle = (group: LocalModifierGroup, optionId: string) => {
    setSelected(previous => {
      const next = new Set(previous)
      if (group.selection === 'single') {
        for (const option of group.options) next.delete(option.id)
        next.add(optionId)
      } else if (next.has(optionId)) next.delete(optionId)
      else next.add(optionId)
      return next
    })
    setError('')
  }
  const apply = () => {
    const missing = groups.find(group => group.required && !group.options.some(option => option.active && selected.has(option.id)))
    if (missing) { setError(`Choose at least one option for ${missing.name}.`); return }
    if (unitPrice < 0) { setError('These modifiers would make the dish price negative.'); return }
    onApply(selectedModifiers, unitPrice)
  }

  return <Dialog title={`Customize ${product.name}`} kicker="MODIFIERS" onClose={onClose} className="modifier-picker-dialog">
    <div className="modifier-picker-price"><span>Starting price</span><strong>{formatCents(product.unit_price_cents, currency)}</strong></div>
    <div className="modifier-picker-groups">
      {groups.map(group => <fieldset key={group.id} className="modifier-picker-group">
        <legend><span>{group.name}</span><small>{group.required ? 'Required' : 'Optional'} · {group.selection === 'single' ? 'Choose one' : 'Choose any'}</small></legend>
        <div className="modifier-picker-options">
          {group.options.filter(option => option.active).map(option => {
            const checked = selected.has(option.id)
            return <label key={option.id} className={checked ? 'selected' : ''}>
              <input type={group.selection === 'single' ? 'radio' : 'checkbox'} name={group.selection === 'single' ? group.id : undefined}
                checked={checked} onChange={() => toggle(group, option.id)} />
              <span><strong>{option.name}</strong><small>{option.price_delta_cents === 0 ? 'Included' : `${option.price_delta_cents > 0 ? '+' : '−'}${formatCents(Math.abs(option.price_delta_cents), currency)}`}</small></span>
            </label>
          })}
        </div>
      </fieldset>)}
    </div>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    <div className="modifier-picker-footer"><span>Total per item <strong>{formatCents(unitPrice, currency)}</strong></span><div><button type="button" className="secondary-cta" onClick={onClose}>Cancel</button><button type="button" className="cta" onClick={apply}>Apply modifiers</button></div></div>
  </Dialog>
}
