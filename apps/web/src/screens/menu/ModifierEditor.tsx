import { useEffect, useState } from 'react'
import { Plus, Trash2 } from '../../components/icons'
import type { LocalModifierGroup } from '../../lib/db'
import { draftFromModifierGroups, saveModifierGroups, type ModifierGroupDraft } from './modifier-api'

const emptyGroup = (): ModifierGroupDraft => ({
  name: '',
  selection: 'single',
  required: false,
  options: [{ name: '', price: '0.00', active: true }],
})

export function ModifierEditor({ storeId, productId, groups, currency, disabled, onSaved }: {
  storeId: string
  productId: string
  groups: LocalModifierGroup[]
  currency: string
  disabled?: boolean
  onSaved: (groups: LocalModifierGroup[]) => void
}) {
  const [draft, setDraft] = useState<ModifierGroupDraft[]>(() => draftFromModifierGroups(groups))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => { setDraft(draftFromModifierGroups(groups)); setError(''); setMessage('') }, [productId, groups])

  const patchGroup = (index: number, changes: Partial<ModifierGroupDraft>) => {
    setDraft(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...changes } : row))
  }
  const save = async () => {
    setBusy(true); setError(''); setMessage('')
    try {
      const saved = await saveModifierGroups(storeId, productId, draft)
      onSaved(saved)
      setMessage('Modifier groups saved and ready on the register.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Modifiers could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const optionCount = draft.reduce((sum, group) => sum + group.options.length, 0)

  return <div className="modifier-editor">
    <div className="modifier-editor-intro">
      <div>
        <span className="modifier-editor-eyebrow">SELLING OPTIONS</span>
        <strong>Sizes, choices and add-ons</strong>
        <p>Build the choices staff see at the register. Every adjustment is included before discount and tax.</p>
      </div>
      <button type="button" className="modifier-add-group" disabled={busy || disabled}
        onClick={() => setDraft(rows => [...rows, emptyGroup()])}><Plus size={15} /> New group</button>
    </div>

    {!draft.length && <div className="modifier-empty">
      <span className="modifier-empty-icon"><Plus size={18} /></span>
      <div><strong>No modifier groups yet</strong><p>Add a required Size group or optional extras such as sauces and toppings.</p></div>
      <button type="button" className="text-action" disabled={busy || disabled} onClick={() => setDraft([emptyGroup()])}>Create first group</button>
    </div>}

    <div className="modifier-group-stack">
      {draft.map((group, groupIndex) => <fieldset className="modifier-group-editor" key={groupIndex} disabled={busy || disabled}>
        <div className="modifier-group-titlebar">
          <span className="modifier-group-index">{String(groupIndex + 1).padStart(2, '0')}</span>
          <div><small>MODIFIER GROUP</small><strong>{group.name.trim() || 'Untitled group'}</strong></div>
          <span className="modifier-group-summary">{group.selection === 'single' ? 'One choice' : 'Multiple choices'} · {group.required ? 'Required' : 'Optional'}</span>
          <button type="button" className="modifier-remove-group" aria-label={`Remove ${group.name || 'modifier group'}`}
            onClick={() => setDraft(rows => rows.filter((_, index) => index !== groupIndex))}><Trash2 size={15} /></button>
        </div>

        <div className="modifier-group-controls">
          <label className="modifier-field modifier-field-name"><span>Group name</span>
            <input aria-label={`Modifier group ${groupIndex + 1} name`} value={group.name} maxLength={60}
              placeholder="e.g. Size" onChange={event => patchGroup(groupIndex, { name: event.target.value })} />
          </label>
          <div className="modifier-selection-field">
            <span>Guest can select</span>
            <div className="modifier-segmented" role="group" aria-label={`Selection type for ${group.name || `group ${groupIndex + 1}`}`}>
              <button type="button" aria-pressed={group.selection === 'single'} className={group.selection === 'single' ? 'active' : ''}
                onClick={() => patchGroup(groupIndex, { selection: 'single' })}>One</button>
              <button type="button" aria-pressed={group.selection === 'multi'} className={group.selection === 'multi' ? 'active' : ''}
                onClick={() => patchGroup(groupIndex, { selection: 'multi' })}>Multiple</button>
            </div>
          </div>
          <label className="modifier-required">
            <input type="checkbox" checked={group.required} onChange={event => patchGroup(groupIndex, { required: event.target.checked })} />
            <span className="modifier-toggle" aria-hidden="true"><i /></span>
            <span><strong>Required</strong><small>Staff must choose before adding</small></span>
          </label>
        </div>

        <div className="modifier-options-editor">
          <div className="modifier-options-head">
            <div><strong>Options</strong><span>{group.options.length} configured</span></div>
            <small>PRICE ADJUSTMENT · {currency}</small>
          </div>
          {group.options.map((option, optionIndex) => <div className="modifier-option-row" key={optionIndex}>
            <span className="modifier-option-index">{String(optionIndex + 1).padStart(2, '0')}</span>
            <label><span>Option name</span>
              <input aria-label={`Option ${optionIndex + 1} name`} value={option.name} maxLength={60}
                placeholder={optionIndex ? 'e.g. Large' : 'e.g. Regular'}
                onChange={event => patchGroup(groupIndex, { options: group.options.map((row, index) => index === optionIndex ? { ...row, name: event.target.value } : row) })} />
            </label>
            <label className="modifier-price-field"><span>Adjustment</span><div><b aria-hidden="true">±</b>
              <input aria-label={`Price change for ${option.name || `option ${optionIndex + 1}`}`} inputMode="decimal" value={option.price}
                onChange={event => patchGroup(groupIndex, { options: group.options.map((row, index) => index === optionIndex ? { ...row, price: event.target.value } : row) })} />
            </div></label>
            <button type="button" className="modifier-remove-option" aria-label={`Remove ${option.name || `option ${optionIndex + 1}`}`}
              disabled={group.options.length === 1}
              onClick={() => patchGroup(groupIndex, { options: group.options.filter((_, index) => index !== optionIndex) })}><Trash2 size={14} /></button>
          </div>)}
          <button type="button" className="modifier-add-option"
            onClick={() => patchGroup(groupIndex, { options: [...group.options, { name: '', price: '0.00', active: true }] })}>
            <Plus size={14} /> Add another option
          </button>
        </div>
      </fieldset>)}
    </div>

    {error && <p className="form-notice error" role="alert">{error}</p>}
    {message && <p className="form-notice" role="status">{message}</p>}
    {draft.length > 0 && <div className="modifier-editor-footer">
      <span><strong>{draft.length}</strong> {draft.length === 1 ? 'group' : 'groups'} · <strong>{optionCount}</strong> {optionCount === 1 ? 'option' : 'options'}</span>
      <button type="button" className="cta modifier-save" disabled={busy || disabled}
        onClick={() => void save()}>{busy ? 'Saving modifiers…' : 'Save modifiers'}</button>
    </div>}
  </div>
}
