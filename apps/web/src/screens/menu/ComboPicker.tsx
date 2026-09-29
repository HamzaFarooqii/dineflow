import { useMemo, useState } from 'react'
import { calculateComboPriceCents } from '../../../../../packages/domain/src/combo'
import { formatCents } from '../../../../../packages/domain/src/money'
import { Dialog } from '../../components/Dialog'
import type { LocalProduct } from '../../lib/db'

// Mirrors ModifierPicker's shape exactly, but each choice is a real product (for stock/kitchen
// routing), not a flat name+price option -- see packages/domain/src/combo.ts's header comment.
export function ComboPicker({ product, productsById, currency, onClose, onApply }: {
  product: LocalProduct
  productsById: Map<string, LocalProduct>
  currency: string
  onClose: () => void
  onApply: (selection: { groupId: string; componentProductId: string; priceDeltaCents: number }[], unitPriceCents: number) => void
}) {
  const groups = [...(product.combo?.groups ?? [])].sort((a, b) => a.sort_order - b.sort_order)
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, Set<string>>>(() =>
    Object.fromEntries(groups.map(group => [group.id, new Set<string>()])))
  const [error, setError] = useState('')

  const selection = useMemo(() => groups.flatMap(group => {
    const options = [...(selectedByGroup[group.id] ?? [])]
    return options.map(componentProductId => {
      const option = group.options.find(candidate => candidate.component_product_id === componentProductId)!
      return { groupId: group.id, componentProductId, priceDeltaCents: option.price_delta_cents }
    })
  }), [groups, selectedByGroup])

  const unitPrice = useMemo(() => {
    if (!product.combo) return product.unit_price_cents
    return calculateComboPriceCents(product.combo.pricing_mode, product.unit_price_cents, selection.map(entry => ({
      priceDeltaCents: entry.priceDeltaCents, componentUnitPriceCents: productsById.get(entry.componentProductId)?.unit_price_cents ?? 0,
    })))
  }, [product, selection, productsById])

  const toggle = (groupId: string, maxSelect: number, componentProductId: string) => {
    setSelectedByGroup(previous => {
      const current = new Set(previous[groupId] ?? [])
      if (current.has(componentProductId)) current.delete(componentProductId)
      else {
        if (maxSelect === 1) current.clear()
        else if (current.size >= maxSelect) return previous
        current.add(componentProductId)
      }
      return { ...previous, [groupId]: current }
    })
    setError('')
  }
  const apply = () => {
    for (const group of groups) {
      const count = selectedByGroup[group.id]?.size ?? 0
      if (count < group.min_select) { setError(`Choose at least ${group.min_select} for ${group.name}.`); return }
      if (count > group.max_select) { setError(`Choose at most ${group.max_select} for ${group.name}.`); return }
    }
    onApply(selection, unitPrice)
  }

  return <Dialog title={`Build ${product.name}`} kicker="COMBO" onClose={onClose} className="modifier-picker-dialog">
    <p className="modifier-picker-intro">Pick one option from each group below, then add it to the check.</p>
    <div className="modifier-picker-price"><span>{product.combo?.pricing_mode === 'derived' ? 'Price adds up as you choose' : 'Starting price'}</span><strong>{formatCents(product.unit_price_cents, currency)}</strong></div>
    <div className="modifier-picker-groups">
      {groups.map(group => <fieldset key={group.id} className="modifier-picker-group">
        <legend><span>{group.name}</span><small>{group.min_select === group.max_select ? `Pick ${group.min_select}` : `Pick ${group.min_select} to ${group.max_select}`}</small></legend>
        <div className="modifier-picker-options">
          {[...group.options].sort((a, b) => a.sort_order - b.sort_order).map(option => {
            const componentProduct = productsById.get(option.component_product_id)
            const checked = selectedByGroup[group.id]?.has(option.component_product_id) ?? false
            return <label key={option.id} className={checked ? 'selected' : ''}>
              <input type={group.max_select === 1 ? 'radio' : 'checkbox'} name={group.max_select === 1 ? group.id : undefined}
                checked={checked} onChange={() => toggle(group.id, group.max_select, option.component_product_id)} />
              <span><strong>{componentProduct?.name ?? 'Unavailable item'}</strong>
                <small>{option.price_delta_cents === 0 ? 'Included' : `+${formatCents(option.price_delta_cents, currency)}`}</small></span>
            </label>
          })}
        </div>
      </fieldset>)}
    </div>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    <div className="modifier-picker-footer"><span>Total <strong>{formatCents(unitPrice, currency)}</strong></span>
      <div><button type="button" className="secondary-cta" onClick={onClose}>Cancel</button><button type="button" className="cta" onClick={apply}>Add combo</button></div></div>
  </Dialog>
}
