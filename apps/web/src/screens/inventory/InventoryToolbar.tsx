import { Search } from '../../components/icons'
import { SelectField } from '../../components/SelectField'

export type InventoryFilter = 'all' | 'in_stock' | 'low_stock' | 'out_of_stock' | 'expiring_soon' | 'inactive'
export type InventorySort = 'name' | 'stock_level' | 'recently_updated' | 'expiry'

const FILTERS: { value: InventoryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in_stock', label: 'In Stock' },
  { value: 'low_stock', label: 'Low Stock' },
  { value: 'out_of_stock', label: 'Out of Stock' },
  { value: 'expiring_soon', label: 'Expiring Soon' },
  { value: 'inactive', label: 'Inactive' },
]

// One filter row covers both the quick "Low Stock / Expiring Soon" shortcuts and the fuller
// All/In Stock/... set the spec describes separately -- one control that does both jobs, rather
// than two rows of overlapping buttons ("don't overcrowd the page").
export function InventoryToolbar({ search, onSearchChange, filter, onFilterChange, sort, onSortChange, onAddIngredient, addOpen }: {
  search: string
  onSearchChange: (value: string) => void
  filter: InventoryFilter
  onFilterChange: (value: InventoryFilter) => void
  sort: InventorySort
  onSortChange: (value: InventorySort) => void
  onAddIngredient: () => void
  addOpen: boolean
}) {
  return <div className="inventory-toolbar">
    <div className="inventory-toolbar-row">
      <label className="search" htmlFor="inventory-search"><Search aria-hidden="true" size={16} />
        <input id="inventory-search" type="search" placeholder="Search inventory by name" value={search} onChange={event => onSearchChange(event.target.value)} />
      </label>
      <SelectField className="inventory-sort-select" aria-label="Sort" value={sort} onChange={event => onSortChange(event.target.value as InventorySort)}>
        <option value="name">Name</option>
        <option value="stock_level">Stock level</option>
        <option value="recently_updated">Recently updated</option>
        <option value="expiry">Nearest expiry</option>
      </SelectField>
      <button type="button" className={addOpen ? 'secondary-cta active' : 'secondary-cta'} onClick={onAddIngredient}>{addOpen ? 'Cancel' : '+ Add ingredient'}</button>
    </div>
    <div className="floor-area-tabs">
      {FILTERS.map(item => <button key={item.value} type="button" className={filter === item.value ? 'active' : undefined} onClick={() => onFilterChange(item.value)}>{item.label}</button>)}
    </div>
  </div>
}
