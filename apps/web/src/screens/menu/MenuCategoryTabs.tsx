import type { LocalCategory } from '../../lib/db'

// Shared menu category filter (Blueprint Section 3) — the single implementation both the
// register and any future restaurant menu surface should use instead of each hand-rolling tabs.
export function MenuCategoryTabs({ categories, selectedId, onSelect }: { categories: LocalCategory[]; selectedId: string; onSelect: (id: string) => void }) {
  return <div className="categories">
    <button type="button" className={selectedId === 'all' ? 'active' : ''} onClick={() => onSelect('all')}>All menu items</button>
    {categories.map(category => <button type="button" key={category.id} className={selectedId === category.id ? 'active' : ''} onClick={() => onSelect(category.id)}>{category.name}</button>)}
  </div>
}
