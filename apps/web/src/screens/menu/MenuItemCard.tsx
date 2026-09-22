import { formatCents } from '../../../../../packages/domain/src/money'
import type { LocalProduct } from '../../lib/db'
import { DishAvailability } from './DishAvailability'

// The reusable restaurant menu tile (Blueprint Section 3). Shows the kitchen name/course when
// the product carries restaurant data, and falls back to nothing for products that don't yet
// (every restaurant column is nullable — this never assumes they're populated).
export function MenuItemCard({ product, stock, currency, disabled, onSelect }: { product: LocalProduct; stock: number; currency: string; disabled?: boolean; onSelect: () => void }) {
  const unavailable = product.is_available === false
  return <button type="button" className="catalog-card menu-item-card" disabled={disabled || unavailable} onClick={onSelect}>
    {product.image_url ? <img className="product-art-img" src={product.image_url} alt="" aria-hidden="true" /> : <div className="product-art" aria-hidden="true" />}
    <strong>{product.name}</strong>
    <span>{formatCents(product.unit_price_cents, currency)}</span>
    <small>{stock} in stock · {product.sku}</small>
    {(product.kitchen_name || product.course) && <small className="menu-item-station">{product.kitchen_name ?? product.course}</small>}
    <DishAvailability isAvailable={product.is_available} unavailableUntil={product.unavailable_until} />
  </button>
}
