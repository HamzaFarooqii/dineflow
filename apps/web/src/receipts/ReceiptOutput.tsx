import { useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { SaleReceipt } from './SaleReceipt'
import type { SavedReceipt } from './data'
import './receipts.css'

export function ReceiptOutput({ receipt, fresh = false }: { receipt: SavedReceipt; fresh?: boolean }) {
  const [attempted, setAttempted] = useState(false)
  const [duplicate, setDuplicate] = useState(!fresh)
  const [message, setMessage] = useState('')
  const print = () => {
    flushSync(() => {
      setDuplicate(!fresh || attempted)
      setAttempted(true)
      setMessage('Print dialog requested. This does not confirm physical printing. Your sale remains saved; you can print again.')
    })
    try { window.print() }
    catch { setMessage('The print dialog could not open. Your sale remains saved. Check browser printing support and try again.') }
  }
  return <>
    <div className="receipt-actions"><button className="cta" type="button" onClick={print}>{fresh && !attempted ? 'Print receipt' : 'Print duplicate receipt'}</button></div>
    <p className="screen-note">Choose your 80 mm printer, disable browser headers and footers, and use 100% scale. Opening the dialog does not confirm physical printing.</p>
    <p role="status" className="receipt-feedback">{message}</p>
    <SaleReceipt receipt={receipt} duplicate={duplicate} />
    {createPortal(<div className="sale-print-root"><SaleReceipt receipt={receipt} duplicate={duplicate} /></div>, document.body)}
  </>
}
