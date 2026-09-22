import { formatCents } from '../../../../packages/domain/src/money'
import { saleDate, type SavedReceipt } from './data'

export function SaleReceipt({ receipt, duplicate }: { receipt: SavedReceipt; duplicate: boolean }) {
  const { order, items, payment } = receipt
  const money = (value: number) => formatCents(value, order.currency)
  return <article className="sale-receipt" aria-label="Saved guest check">
    <header><h2>{order.store_name_snapshot}</h2><p className="receipt-kind">{duplicate ? 'DUPLICATE CHECK' : 'GUEST CHECK'}</p>
      <p>Check <strong>{order.receipt_number}</strong></p><p><time dateTime={order.client_generated_at}>{saleDate(order)}</time><br />{order.timezone_snapshot}</p></header>
    <div className="receipt-items">{items.map(item => <section className="receipt-line" key={item.id}>
      <strong>{item.snapshot_name}</strong><small>SKU: {item.snapshot_sku}</small>
      <div><span>{item.quantity} × {money(item.snapshot_price_cents)}</span><b>{money(item.subtotal_cents)}</b></div>
      {Boolean(item.discount_applied_cents) && <div className="receipt-line-discount"><span>Discount {item.discount_kind === 'percent' ? `(${(item.discount_value ?? 0) / 100}%)` : ''}</span><span>−{money(item.discount_applied_cents!)}</span></div>}
      <div><span>Tax</span><span>{money(item.tax_cents)}</span></div>
      <div><span>Line total</span><span>{money(item.total_cents)}</span></div>
    </section>)}</div>
    <dl className="receipt-totals"><div><dt>Subtotal</dt><dd>{money(order.subtotal_cents)}</dd></div>
      {Boolean(order.discount_cents) && <div className="receipt-discount"><dt>Discount</dt><dd>−{money(order.discount_cents!)}</dd></div>}
      <div><dt>Tax</dt><dd>{money(order.tax_cents)}</dd></div><div className="receipt-total"><dt>Total ({order.currency})</dt><dd>{money(order.total_cents)}</dd></div>
      <div><dt>Payment</dt><dd>{payment.method === 'cash' ? 'Cash' : 'Card (external)'}</dd></div>
      <div><dt>Amount paid</dt><dd>{money(payment.amount_cents)}</dd></div><div><dt>Tendered</dt><dd>{money(payment.tendered_cents)}</dd></div>
      <div><dt>Change</dt><dd>{money(payment.change_cents)}</dd></div>
      {payment.method === 'card' && payment.reference && <div><dt>Card reference</dt><dd>{payment.reference}</dd></div>}
      {order.manager_id && <div><dt>Manager approval</dt><dd>Recorded {order.manager_approved_at ? new Date(order.manager_approved_at).toLocaleString() : ''}</dd></div>}
    </dl><footer>Thank you for dining with us.</footer>
  </article>
}
