import { calculateDiscountedLine, calculateServiceCharge, sumDiscountedLines, boundedInteger, discountNeedsManagerApproval, MAX_CENTS } from '../../../../packages/domain/src/money'
import { posDb, type LocalOrder, type LocalOrderItem, type LocalPayment, type OutboxEntry } from './db'
import { usePosStore, redeemedReward, type CartItem } from './pos-store'

// Evidence that a manager authorized a discount above the cashier's independent 20% authority.
export interface ManagerApprovalEvidence { managerId: string; approvedAt: string }
export type SettlementTender = Omit<LocalPayment, 'order_id'>

export function validateSettlement(tenders: SettlementTender[], total: number): void {
  if (!tenders.length || tenders.length > 20) throw new Error('Provide 1 to 20 payments.')
  if (new Set(tenders.map(tender => tender.id)).size !== tenders.length) throw new Error('Payment IDs must be unique.')
  for (const tender of tenders) {
    for (const amount of [tender.amount_cents, tender.tendered_cents, tender.change_cents, tender.tip_cents ?? 0]) boundedInteger(amount, 'Payment amount', 0, MAX_CENTS)
    if (tender.method !== 'cash' && tender.method !== 'card') throw new Error('Invalid payment method.')
    const due = tender.amount_cents + (tender.tip_cents ?? 0)
    if (tender.amount_cents === 0 && (tender.tip_cents ?? 0) > 0) throw new Error('A tip must belong to a positive sale allocation.')
    if (tender.tendered_cents !== due + tender.change_cents || (tender.method === 'card' && tender.change_cents !== 0)) throw new Error('Each payment must cover its amount and tip; only cash can have change.')
  }
  if (tenders.reduce((sum, tender) => sum + tender.amount_cents, 0) !== total) throw new Error('Payment allocations must equal the check total exactly.')
}

export async function completeLocalSale(items: CartItem[], storeId: string, method: 'cash' | 'card', tenderedCents: number, reference: string | null, customerId: string | null = null, employeeId: string | null = null, approval: ManagerApprovalEvidence | null = null, terminal = false, settlement?: SettlementTender[]) {
  if (!items.length) throw new Error('Add a product before checkout.')
  if (items.some(item => item.storeId !== storeId)) throw new Error('Cart contains a product from another store. Clear the cart and try again.')
  const config = await posDb.store_config.get(storeId)
  if (!config) throw new Error('Store catalog has not been downloaded to this browser.')
  const customer = customerId ? await posDb.customers.get(customerId) : null
  if (customerId && (!customer || customer.store_id !== storeId)) throw new Error('Selected customer does not belong to this store.')
  const lines = items.map(item => calculateDiscountedLine(item.unitPriceCents, item.quantity, item.taxRateBps, item.discount))
  const totals = sumDiscountedLines(lines)
  const serviceChargeBps = config.service_charge_bps ?? 0
  const serviceChargeCents = calculateServiceCharge(totals.subtotalCents - totals.discountCents, serviceChargeBps)
  const grandTotalCents = totals.totalCents + serviceChargeCents
  // The 20%-independent-authority cap exists for a cashier terminal, where discretion is
  // deliberately limited and a manager's PIN raises it (ManagerApprovalModal, gated on `terminal`
  // the same way in RegisterScreen.tsx's own needsApproval/approvalValid). The web register has no
  // such cap to raise in the first place -- every Supabase session that can reach it already
  // belongs to an owner or manager (cashiers only ever get a PIN/terminal session, never a
  // Supabase one), so there's no third party for a modal to summon here. Enforcing the cashier
  // cap on that same person's own web session just blocked every sale with a discount over 20%
  // with no way to ever clear it, on any account, however senior.
  if (terminal && !approval && lines.some(line => discountNeedsManagerApproval(line.subtotalCents, line.discountAppliedCents))) {
    throw new Error('A discount needs manager approval before this sale can complete.')
  }
  if (!settlement) {
  boundedInteger(tenderedCents, 'Tender', 0, MAX_CENTS)
  if (tenderedCents < grandTotalCents) throw new Error('Amount received must cover the sale.')
  if (method === 'card' && tenderedCents !== grandTotalCents) throw new Error('Card amount must equal the sale total.')
  }
  const tenders = settlement ?? [{ id: crypto.randomUUID(), method, amount_cents: grandTotalCents,
    tendered_cents: tenderedCents, change_cents: method === 'cash' ? tenderedCents - grandTotalCents : 0, reference, tip_cents: 0 }]
  validateSettlement(tenders, grandTotalCents)
  const operationId = crypto.randomUUID()
  const now = new Date().toISOString()
  let receiptNumber = ''
  // Read directly off the store rather than taking new parameters here, so this checkout path
  // stays untouched by the register/payment screens (Restaurant POS Transformation Blueprint,
  // docs/09, Day 2) — orderType and activeTableId are cart-scoped the same way discount/approval
  // state already is. table_id only ever travels with a dine-in order.
  const { orderType, activeTableId, deliveryDetails } = usePosStore.getState()
  const tableId = orderType === 'dine_in' ? activeTableId : null
  // Delivery orders need a recipient/address snapshot the API validates and stores immutably
  // (apps/api/src/routes/delivery.ts's deliveryDetailsBody) -- checked here, not just left to the
  // server's 422, so a bad delivery order never gets as far as the offline outbox where it would
  // fail forever on every retry instead of failing once, visibly, at checkout.
  let delivery: { recipient_name: string; contact_phone: string; address: string; delivery_instructions: string | null } | undefined
  if (orderType === 'delivery') {
    const recipientName = deliveryDetails.recipientName.trim()
    const contactPhone = deliveryDetails.contactPhone.replace(/\D/g, '')
    const address = deliveryDetails.address.trim()
    if (!recipientName) throw new Error('Enter the recipient’s name for this delivery.')
    if (!/^[1-9][0-9]{3,14}$/.test(contactPhone)) throw new Error('Enter a valid delivery phone number, with country code.')
    if (!address) throw new Error('Enter a delivery address.')
    delivery = { recipient_name: recipientName, contact_phone: contactPhone, address, delivery_instructions: deliveryDetails.instructions.trim() || null }
  }
  await posDb.transaction('rw', [posDb.orders, posDb.order_items, posDb.payments,
    posDb.outbox, posDb.stock_adjustments, posDb.sync_metadata], async () => {
      const prefixRow = await posDb.sync_metadata.get(`receipt_prefix:${storeId}`)
      const prefix = prefixRow?.value ?? `LOCAL-${crypto.randomUUID().toUpperCase()}-`
      const sequenceKey = `receipt_seq:${storeId}`
      let sequence = Number((await posDb.sync_metadata.get(sequenceKey))?.value ?? '0')
      // Older/local browser state can retain an order after its sequence metadata was lost or
      // reset. Keep the unique receipt constraint and advance to the first unused number.
      do {
        sequence += 1
        if (!Number.isSafeInteger(sequence)) throw new Error('Receipt sequence is exhausted.')
        receiptNumber = `${prefix}${String(sequence).padStart(6, '0')}`
      } while (await posDb.orders.where('receipt_number').equals(receiptNumber).count())
      const order: LocalOrder = { id: operationId, store_id: storeId, receipt_number: receiptNumber,
        subtotal_cents: totals.subtotalCents, discount_cents: totals.discountCents, tax_cents: totals.taxCents,
        service_charge_bps: serviceChargeBps, service_charge_cents: serviceChargeCents, total_cents: grandTotalCents,
        catalog_version: config.catalog_version, client_generated_at: now, sync_status: 'pending',
        currency: config.currency, store_name_snapshot: config.name, timezone_snapshot: config.timezone,
        accepted_checkpoint: null, failure_reason: customer && customer.sync_status !== 'synced' ? 'Waiting for customer upload.' : null,
        customer_id: customerId, employee_id: employeeId, manager_id: approval?.managerId ?? null, manager_approved_at: approval?.approvedAt ?? null,
        order_type: orderType, table_id: tableId }
      const orderItems: LocalOrderItem[] = items.map((item, index) => ({ id: crypto.randomUUID(),
        order_id: operationId, product_id: item.productId, snapshot_name: item.name, snapshot_sku: item.sku,
        snapshot_price_cents: item.unitPriceCents, base_price_cents: item.basePriceCents ?? item.unitPriceCents,
        modifiers: (item.modifiers ?? []).map(modifier => ({ option_id: modifier.optionId, group_name: modifier.groupName,
          option_name: modifier.optionName, price_delta_cents: modifier.priceDeltaCents })),
        snapshot_tax_bps: item.taxRateBps, catalog_version: item.catalogVersion, quantity: item.quantity,
        subtotal_cents: lines[index].subtotalCents, discount_kind: item.discount?.kind ?? null,
        discount_value: item.discount ? (item.discount.kind === 'percent' ? item.discount.bps : item.discount.cents) : null,
        discount_applied_cents: lines[index].discountAppliedCents, taxable_cents: lines[index].taxableCents,
        tax_cents: lines[index].taxCents, total_cents: lines[index].totalCents }))
      const payments: LocalPayment[] = tenders.map(tender => ({ ...tender, order_id: operationId }))
      // Day 4 checkout wiring: if a line's discount came from redeeming a reward, tell the server
      // which reward_rule to deduct points for — the discount amount itself already travels as an
      // ordinary line discount above, exactly like a manual one.
      const reward = redeemedReward(items)
      // Sellable combos (A4): the server payload carries each combo line's selection so it can
      // re-validate against the real catalog and expand it into component order-item rows itself
      // -- the client never invents that expansion. Kept out of the locally-persisted orderItems
      // above; the local receipt only ever needs the already-settled snapshot, not the selection
      // that produced it.
      const payloadItems = orderItems.map((orderItem, index) => {
        const selection = items[index].comboSelection
        return selection?.length ? { ...orderItem, combo_selection: selection.map(entry => ({ group_id: entry.groupId, component_product_id: entry.componentProductId, price_delta_cents: entry.priceDeltaCents })) } : orderItem
      })
      // orders.ts reads recipient/address details off order.delivery specifically (nested, not a
      // sibling of "order" in the payload) -- see validateOperation's `record(order.delivery, ...)`.
      const payload = { operation_id: operationId, order: delivery ? { ...order, delivery } : order, items: payloadItems,
        ...(settlement ? { payments } : { payment: payments[0] }),
        loyalty_redemption: reward ? { reward_rule_id: reward.ruleId } : undefined }
      const outbox: OutboxEntry = { store_id: storeId, operation_id: operationId, order_id: operationId, status: 'pending',
        failure_reason: null, failure_kind: null, reason_code: null, attempt_count: 0,
        lease_owner: null, lease_expires_at: null, accepted_checkpoint: null,
        next_attempt_at: now, created_at: now, payload: JSON.stringify(payload), entity_type: 'order',
        depends_on: customer?.creating_operation_id && customer.sync_status !== 'synced' ? [customer.creating_operation_id] : [] }
      await posDb.sync_metadata.put({ key: `receipt_prefix:${storeId}`, value: prefix })
      await posDb.sync_metadata.put({ key: sequenceKey, value: String(sequence) })
      await posDb.orders.add(order)
      await posDb.order_items.bulkAdd(orderItems)
      await posDb.payments.bulkAdd(payments)
      // Stock adjustments are keyed by [operation_id+product_id]. The cart may contain the same
      // product on multiple lines (different modifiers, notes, or discounts), so writing one row
      // per cart line would attempt to insert the same IndexedDB key twice and abort checkout.
      // Collapse those lines into the single per-product stock movement represented by this store.
      const quantitiesByProduct = new Map<string, number>()
      for (const item of items) quantitiesByProduct.set(item.productId,
        (quantitiesByProduct.get(item.productId) ?? 0) + item.quantity)
      for (const [productId, quantity] of quantitiesByProduct) await posDb.stock_adjustments.add({
        operation_id: operationId, product_id: productId, delta: -quantity, accepted_checkpoint: null })
      await posDb.outbox.add(outbox)
    })
  return { operationId, receiptNumber, totalCents: grandTotalCents }
}
