import { useEffect, useState } from 'react'
import { Plus, Trash2 } from '../../components/icons'
import type { LocalCombo, LocalProduct } from '../../lib/db'
import { saveCombo, deleteCombo, type ComboGroupDraft } from './combo-api'

interface OptionDraft { component_product_id: string; price: string }
interface GroupDraft { name: string; min_select: number; max_select: number; options: OptionDraft[] }

const moneyToCents = (value: string): number => Math.round((Number(value.replace(/[^0-9.-]/g, '')) || 0) * 100)
const centsToMoney = (value: number): string => (value / 100).toFixed(2)

function draftFromCombo(combo: LocalCombo | null | undefined): GroupDraft[] {
  if (!combo) return []
  return combo.groups.map(group => ({
    name: group.name, min_select: group.min_select, max_select: group.max_select,
    options: group.options.map(option => ({ component_product_id: option.component_product_id, price: centsToMoney(option.price_delta_cents) })),
  }))
}
const emptyGroup = (firstProductId: string): GroupDraft => ({ name: '', min_select: 1, max_select: 1, options: [{ component_product_id: firstProductId, price: '0.00' }] })

// Combo builder — same drawer/section convention as ModifierEditor, but each "option" picks a
// real, already-sellable product from this store's own menu (not a flat name+price), since a
// combo component needs a real product identity to drive stock consumption and its own kitchen
// routing at checkout (see packages/domain/src/combo.ts's header comment).
export function ComboEditor({ storeId, productId, combo, products, currency, disabled, onSaved, onRemoved }: {
  storeId: string
  productId: string
  combo: LocalCombo | null | undefined
  products: LocalProduct[]
  currency: string
  disabled?: boolean
  onSaved: (combo: LocalCombo) => void
  onRemoved: () => void
}) {
  const selectable = products.filter(product => product.id !== productId && product.active && !product.combo)
  const [pricingMode, setPricingMode] = useState<'fixed' | 'derived'>(combo?.pricing_mode ?? 'fixed')
  const [draft, setDraft] = useState<GroupDraft[]>(() => draftFromCombo(combo))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => { setPricingMode(combo?.pricing_mode ?? 'fixed'); setDraft(draftFromCombo(combo)); setError(''); setMessage('') }, [productId, combo])

  const patchGroup = (index: number, changes: Partial<GroupDraft>) => setDraft(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...changes } : row))

  const save = async () => {
    setBusy(true); setError(''); setMessage('')
    try {
      const groups: ComboGroupDraft[] = draft.map(group => ({
        name: group.name.trim(), min_select: group.min_select, max_select: group.max_select,
        options: group.options.map(option => ({ component_product_id: option.component_product_id, price_delta_cents: moneyToCents(option.price) })),
      }))
      const saved = await saveCombo(storeId, productId, pricingMode, groups)
      onSaved(saved)
      setMessage('Combo saved and ready on the register.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Combo could not be saved.') }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!window.confirm('Remove this combo configuration? The dish goes back to being a plain menu item.')) return
    setBusy(true); setError('')
    try { await deleteCombo(storeId, productId); onRemoved() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Combo could not be removed.') }
    finally { setBusy(false) }
  }

  if (!selectable.length) return <div className="modifier-editor"><p className="screen-note">Save at least one other active menu item before building a combo — a combo needs real dishes to choose from.</p></div>

  return <div className="modifier-editor combo-editor">
    <div className="modifier-editor-intro">
      <div><span className="modifier-editor-eyebrow">SELLABLE COMBO</span><strong>Bundle this dish with other menu items</strong>
        <p>Guests pick one component per group at the register. Stock and the kitchen ticket are routed per selected component, same as if it were ordered on its own.</p></div>
      <button type="button" className="modifier-add-group" disabled={busy || disabled}
        onClick={() => setDraft(rows => [...rows, emptyGroup(selectable[0].id)])}><Plus size={15} /> New group</button>
    </div>

    <div className="modifier-selection-field">
      <span>Pricing</span>
      <div className="modifier-segmented" role="group" aria-label="Combo pricing mode">
        <button type="button" aria-pressed={pricingMode === 'fixed'} className={pricingMode === 'fixed' ? 'active' : ''} onClick={() => setPricingMode('fixed')}>Fixed price</button>
        <button type="button" aria-pressed={pricingMode === 'derived'} className={pricingMode === 'derived' ? 'active' : ''} onClick={() => setPricingMode('derived')}>Sum of components</button>
      </div>
      <small>{pricingMode === 'fixed' ? 'Charges this dish’s own menu price, plus any selected upsell.' : 'Charges the sum of each selected component’s own price, plus any upsell.'}</small>
    </div>

    {!draft.length && <div className="modifier-empty">
      <span className="modifier-empty-icon"><Plus size={18} /></span>
      <div><strong>No combo groups yet</strong><p>Add a "Choose a side" or "Choose a drink" group.</p></div>
      <button type="button" className="text-action" disabled={busy || disabled} onClick={() => setDraft([emptyGroup(selectable[0].id)])}>Create first group</button>
    </div>}

    <div className="modifier-group-stack">
      {draft.map((group, groupIndex) => <fieldset className="modifier-group-editor" key={groupIndex} disabled={busy || disabled}>
        <div className="modifier-group-titlebar">
          <span className="modifier-group-index">{String(groupIndex + 1).padStart(2, '0')}</span>
          <div><small>COMBO GROUP</small><strong>{group.name.trim() || 'Untitled group'}</strong></div>
          <span className="modifier-group-summary">choose {group.min_select}-{group.max_select}</span>
          <button type="button" className="modifier-remove-group" aria-label={`Remove ${group.name || 'combo group'}`}
            onClick={() => setDraft(rows => rows.filter((_, index) => index !== groupIndex))}><Trash2 size={15} /></button>
        </div>
        <div className="modifier-group-controls">
          <label className="modifier-field modifier-field-name"><span>Group name</span>
            <input value={group.name} maxLength={60} placeholder="e.g. Choose a side" onChange={event => patchGroup(groupIndex, { name: event.target.value })} />
          </label>
          <label className="modifier-field"><span>Min select</span>
            <input type="number" min={0} max={group.max_select} value={group.min_select} onChange={event => patchGroup(groupIndex, { min_select: Math.max(0, Number(event.target.value) || 0) })} />
          </label>
          <label className="modifier-field"><span>Max select</span>
            <input type="number" min={Math.max(1, group.min_select)} value={group.max_select} onChange={event => patchGroup(groupIndex, { max_select: Math.max(1, Number(event.target.value) || 1) })} />
          </label>
        </div>
        <div className="modifier-options-editor">
          <div className="modifier-options-head"><div><strong>Options</strong><span>{group.options.length} configured</span></div><small>UPSELL · {currency}</small></div>
          {group.options.map((option, optionIndex) => <div className="modifier-option-row" key={optionIndex}>
            <span className="modifier-option-index">{String(optionIndex + 1).padStart(2, '0')}</span>
            <label><span>Component</span>
              <select value={option.component_product_id} onChange={event => patchGroup(groupIndex, { options: group.options.map((row, index) => index === optionIndex ? { ...row, component_product_id: event.target.value } : row) })}>
                {selectable.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}
              </select>
            </label>
            <label className="modifier-price-field"><span>Upsell</span><div><b aria-hidden="true">+</b>
              <input inputMode="decimal" value={option.price} onChange={event => patchGroup(groupIndex, { options: group.options.map((row, index) => index === optionIndex ? { ...row, price: event.target.value } : row) })} />
            </div></label>
            <button type="button" className="modifier-remove-option" disabled={group.options.length === 1}
              onClick={() => patchGroup(groupIndex, { options: group.options.filter((_, index) => index !== optionIndex) })}><Trash2 size={14} /></button>
          </div>)}
          <button type="button" className="modifier-add-option" onClick={() => patchGroup(groupIndex, { options: [...group.options, { component_product_id: selectable[0].id, price: '0.00' }] })}>
            <Plus size={14} /> Add another option
          </button>
        </div>
      </fieldset>)}
    </div>

    {error && <p className="form-notice error" role="alert">{error}</p>}
    {message && <p className="form-notice" role="status">{message}</p>}
    <div className="modifier-editor-footer">
      {combo && <button type="button" className="text-action" disabled={busy || disabled} onClick={() => void remove()}>Remove combo</button>}
      <button type="button" className="cta modifier-save" disabled={busy || disabled || !draft.length}
        onClick={() => void save()}>{busy ? 'Saving combo…' : 'Save combo'}</button>
    </div>
  </div>
}
