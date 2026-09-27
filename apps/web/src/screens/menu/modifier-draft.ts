import type { LocalModifierGroup } from '../../lib/db'

export interface ModifierOptionDraft { name: string; price: string; active: boolean }
export interface ModifierGroupDraft { name: string; selection: 'single' | 'multi'; required: boolean; options: ModifierOptionDraft[] }

export function draftFromModifierGroups(groups: LocalModifierGroup[]): ModifierGroupDraft[] {
  return groups.map(group => ({ name: group.name, selection: group.selection, required: group.required,
    options: group.options.map(option => ({ name: option.name, price: (option.price_delta_cents / 100).toFixed(2), active: option.active })) }))
}

export function parseModifierDraft(groups: ModifierGroupDraft[]) {
  if (groups.length > 20) throw new Error('A dish can have at most 20 modifier groups.')
  return groups.map((group, groupIndex) => {
    const name = group.name.trim().replace(/\s+/g, ' ')
    if (!name || name.length > 60) throw new Error(`Group ${groupIndex + 1} needs a name of 1–60 characters.`)
    if (!group.options.length) throw new Error(`${name} needs at least one option.`)
    const options = group.options.map((option, optionIndex) => {
      const optionName = option.name.trim().replace(/\s+/g, ' ')
      if (!optionName || optionName.length > 60) throw new Error(`${name}, option ${optionIndex + 1} needs a name.`)
      if (!/^-?(?:\d+|\d*\.\d{1,2})$/.test(option.price.trim())) throw new Error(`${optionName} needs a valid price adjustment.`)
      const price_delta_cents = Math.round(Number(option.price) * 100)
      if (!Number.isSafeInteger(price_delta_cents) || Math.abs(price_delta_cents) > 1_000_000_000) throw new Error(`${optionName} price adjustment is too large.`)
      return { name: optionName, price_delta_cents, active: option.active }
    })
    if (new Set(options.map(option => option.name.toLocaleLowerCase())).size !== options.length) throw new Error(`${name} has duplicate option names.`)
    return { name, selection: group.selection, required: group.required, options }
  })
}
