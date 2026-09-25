import { calculateDiscountedLine, formatCents } from '../../../../../packages/domain/src/money'
import type { CartItem } from '../../lib/pos-store'

export type DiscountEditorKind = 'percent' | 'fixed' | 'reward' | 'promo'
export interface RewardOption { id: string; label: string; affordable: boolean }
export interface PromoOption { id: string; label: string }

// The reusable current-order line (Blueprint Section 3). A pure, controlled extraction of the
// register's cart-line markup — all discount/quantity state still lives in RegisterScreen; this
// component only renders it, so behavior is unchanged from before the extraction.
export function RestaurantOrderItem({ item, currency, flagged, approvalValid, discountEditorOpen, discountKind, discountInput, discountError, availableStock,
  rewardOptions, promoOptions, hasCustomer,
  onIncrement, onDecrement, onRemove, onOpenDiscountEditor, onSetDiscountKind, onSetDiscountInput, onRemoveDiscount, onCancelDiscountEditor, onApplyDiscount, onSetNote }: {
  item: CartItem
  currency: string
  flagged: boolean
  approvalValid: boolean
  discountEditorOpen: boolean
  discountKind: DiscountEditorKind
  discountInput: string
  discountError: string
  // Undefined means "stock unknown for this product" (never warn); a number is the last-synced
  // count — see RegisterScreen's oversoldLines comment for why this warns rather than blocks.
  availableStock?: number
  // Reward redemption needs a guest attached (it's their points balance); a promotion doesn't.
  rewardOptions: RewardOption[]
  promoOptions: PromoOption[]
  hasCustomer: boolean
  onIncrement: () => void
  onDecrement: () => void
  onRemove: () => void
  onOpenDiscountEditor: () => void
  onSetDiscountKind: (kind: DiscountEditorKind) => void
  onSetDiscountInput: (value: string) => void
  onRemoveDiscount: () => void
  onCancelDiscountEditor: () => void
  onApplyDiscount: () => void
  onSetNote: (notes: string) => void
}) {
  const line = calculateDiscountedLine(item.unitPriceCents, item.quantity, item.taxRateBps, item.discount)
  const oversold = availableStock !== undefined && item.quantity > availableStock
  return <div className="cart-line-wrap">
    <div className="cart-line"><span><strong>{item.name}</strong><small>{formatCents(item.unitPriceCents, currency)} each</small></span>
      <div className="quantity"><button type="button" aria-label={`Remove one ${item.name}`} onClick={onDecrement}>−</button><b>{item.quantity}</b>
        <button type="button" aria-label={`Add one ${item.name}`} onClick={onIncrement}>+</button></div>
      <button type="button" aria-label={`Remove ${item.name}`} onClick={onRemove}>×</button></div>
    {oversold && <p className="cart-line-stock-warning" role="alert">Only {availableStock} in stock — this line orders {item.quantity - (availableStock ?? 0)} more than available.</p>}
    <div className="cart-line-note-row">
      <input type="text" maxLength={200} value={item.notes ?? ''} placeholder="Note for the kitchen (e.g. no onions)"
        aria-label={`Note for ${item.name}`} onChange={event => onSetNote(event.target.value)} />
      {/* Modifiers/add-ons structure (Blueprint-aligned placeholder): visibly present, not yet
          wired to a data model — no modifier groups exist on pos_products today, so this stays
          disabled rather than fabricating options. Day 2+ work once that schema lands. */}
      <button type="button" className="cart-line-modifiers-placeholder" disabled title="Modifiers — coming soon">+ Modifiers</button>
    </div>
    <div className="cart-line-discount-row">
      <button type="button" className={`discount-button ${item.discount ? 'active' : ''}`} onClick={onOpenDiscountEditor}>
        {item.discountSource?.kind === 'reward' ? `Reward: ${item.discountSource.ruleName}`
          : item.discountSource?.kind === 'promotion' ? `Promo: ${item.discountSource.name}`
          : item.discount ? 'Edit discount' : '% Discount'}
      </button>
      {item.discount ? <div className="cart-line-money">
        <span className="cart-line-original">{formatCents(line.subtotalCents, currency)}</span>
        <span className="cart-line-discount-amount">−{formatCents(line.discountAppliedCents, currency)}</span>
        <b className="cart-line-net">{formatCents(line.totalCents, currency)}</b>
      </div> : <b className="cart-line-net">{formatCents(line.totalCents, currency)}</b>}
    </div>
    {flagged && <p className={`cart-line-approval-flag ${approvalValid ? 'approved' : ''}`} role="status">{approvalValid ? 'Manager-approved discount' : 'Needs manager approval'}</p>}
    {discountEditorOpen && <div className="discount-popover" role="dialog" aria-label={`Discount for ${item.name}`}>
      <div className="discount-toggle">
        <button type="button" className={discountKind === 'percent' ? 'active' : ''} onClick={() => onSetDiscountKind('percent')}>%</button>
        <button type="button" className={discountKind === 'fixed' ? 'active' : ''} onClick={() => onSetDiscountKind('fixed')}>$</button>
        <button type="button" className={discountKind === 'reward' ? 'active' : ''} disabled={!hasCustomer} title={hasCustomer ? undefined : 'Attach a guest to redeem a reward'} onClick={() => onSetDiscountKind('reward')}>Reward</button>
        <button type="button" className={discountKind === 'promo' ? 'active' : ''} onClick={() => onSetDiscountKind('promo')}>Promo</button>
      </div>
      {discountKind === 'percent' || discountKind === 'fixed' ? <label>{discountKind === 'percent' ? 'Percent off' : 'Amount off'}
        <input type="text" inputMode="decimal" autoFocus value={discountInput} onChange={event => onSetDiscountInput(event.target.value)}
          placeholder={discountKind === 'percent' ? '0–100' : '0.00'} /></label>
      : discountKind === 'reward' ? <label>Reward
        {rewardOptions.length
          ? <select autoFocus value={discountInput} onChange={event => onSetDiscountInput(event.target.value)}>
              <option value="">Choose a reward…</option>
              {rewardOptions.map(option => <option key={option.id} value={option.id} disabled={!option.affordable}>{option.label}{option.affordable ? '' : ' (not enough points)'}</option>)}
            </select>
          : <p className="discount-popover-empty">No rewards configured for this restaurant yet.</p>}
      </label>
      : <label>Promotion
        {promoOptions.length
          ? <select autoFocus value={discountInput} onChange={event => onSetDiscountInput(event.target.value)}>
              <option value="">Choose a promotion…</option>
              {promoOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          : <p className="discount-popover-empty">No promotions are running right now.</p>}
      </label>}
      {discountError && <p className="form-notice error" role="alert">{discountError}</p>}
      <div className="discount-actions">
        {item.discount && <button type="button" className="text-action" onClick={onRemoveDiscount}>Remove</button>}
        <button type="button" className="secondary-cta" onClick={onCancelDiscountEditor}>Cancel</button>
        <button type="button" className="cta" onClick={onApplyDiscount}>Apply</button>
      </div>
    </div>}
  </div>
}
