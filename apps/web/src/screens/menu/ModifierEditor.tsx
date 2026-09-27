import { useEffect, useState } from 'react'
import { Plus, Trash2 } from '../../components/icons'
import type { LocalModifierGroup } from '../../lib/db'
import { draftFromModifierGroups, saveModifierGroups, type ModifierGroupDraft } from './modifier-api'

const emptyGroup = (): ModifierGroupDraft => ({ name: '', selection: 'single', required: false,
  options: [{ name: '', price: '0.00', active: true }] })

export function ModifierEditor({ storeId, productId, groups, disabled, onSaved }: {
  storeId: string
  productId: string
  groups: LocalModifierGroup[]
  disabled?: boolean
  onSaved: (groups: LocalModifierGroup[]) => void
}) {
  const [draft, setDraft] = useState<ModifierGroupDraft[]>(() => draftFromModifierGroups(groups))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => { setDraft(draftFromModifierGroups(groups)); setError(''); setMessage('') }, [productId, groups])

  const patchGroup = (index: number, changes: Partial<ModifierGroupDraft>) => setDraft(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...changes } : row))
  const save = async () => {
    setBusy(true); setError(''); setMessage('')
    try {
      const saved = await saveModifierGroups(storeId, productId, draft)
      onSaved(saved)
      setMessage('Modifier groups saved and ready on the register.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Modifiers could not be saved.') }
    finally { setBusy(false) }
  }

  return <div className="modifier-editor">
    <div className="modifier-editor-intro">
      <p>Build required sizes and optional add-ons. Price adjustments are included before discount and tax.</p>
      <button type="button" className="secondary-cta" disabled={busy || disabled} onClick={() => setDraft(rows => [...rows, emptyGroup()])}><Plus size={14} /> Add group</button>
    </div>
    {!draft.length && <div className="modifier-empty">No modifiers on this dish. Add a group such as Size or Add-ons.</div>}
    {draft.map((group, groupIndex) => <fieldset className="modifier-group-editor" key={groupIndex} disabled={busy || disabled}>
      <div className="modifier-group-head">
        <input aria-label={`Modifier group ${groupIndex + 1} name`} value={group.name} maxLength={60} placeholder="Group name, e.g. Size" onChange={event => patchGroup(groupIndex, { name: event.target.value })} />
        <select aria-label={`Selection type for ${group.name || `group ${groupIndex + 1}`}`} value={group.selection} onChange={event => patchGroup(groupIndex, { selection: event.target.value as 'single' | 'multi' })}>
          <option value="single">Choose one</option><option value="multi">Choose multiple</option>
        </select>
        <label className="modifier-required"><input type="checkbox" checked={group.required} onChange={event => patchGroup(groupIndex, { required: event.target.checked })} /> Required</label>
        <button type="button" className="pc-icon-button danger" aria-label={`Remove ${group.name || 'modifier group'}`} onClick={() => setDraft(rows => rows.filter((_, index) => index !== groupIndex))}><Trash2 size={14} /></button>
      </div>
      <div className="modifier-options-editor">
        {group.options.map((option, optionIndex) => <div className="modifier-option-row" key={optionIndex}>
          <input aria-label={`Option ${optionIndex + 1} name`} value={option.name} maxLength={60} placeholder="Option name" onChange={event => patchGroup(groupIndex, { options: group.options.map((row, index) => index === optionIndex ? { ...row, name: event.target.value } : row) })} />
          <label><span>Price change</span><input aria-label={`Price change for ${option.name || `option ${optionIndex + 1}`}`} inputMode="decimal" value={option.price} onChange={event => patchGroup(groupIndex, { options: group.options.map((row, index) => index === optionIndex ? { ...row, price: event.target.value } : row) })} /></label>
          <button type="button" className="text-action danger" disabled={group.options.length === 1} onClick={() => patchGroup(groupIndex, { options: group.options.filter((_, index) => index !== optionIndex) })}>Remove</button>
        </div>)}
        <button type="button" className="text-action" onClick={() => patchGroup(groupIndex, { options: [...group.options, { name: '', price: '0.00', active: true }] })}>+ Add option</button>
      </div>
    </fieldset>)}
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {message && <p className="form-notice" role="status">{message}</p>}
    <button type="button" className="secondary-cta modifier-save" disabled={busy || disabled} onClick={() => void save()}>{busy ? 'Saving modifiers…' : 'Save modifiers'}</button>
  </div>
}
