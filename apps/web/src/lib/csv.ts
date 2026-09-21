// Minimal client-side CSV helpers — no external library needed for a single flat summary export.

// Excel/Sheets/LibreOffice treat a cell whose content starts with =, +, -, or @ (or a tab/carriage
// return) as a formula. Any field sourced from user-editable text (e.g. a store name) could contain
// one of these leading characters, so every cell is guarded the same way regardless of source: a
// leading straight quote forces spreadsheet software to read the cell as literal text, matching the
// standard CSV-injection mitigation.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/

export function csvCell(value: string | number): string {
  const raw = String(value)
  const guarded = FORMULA_TRIGGER.test(raw) ? `'${raw}` : raw
  const escaped = guarded.replace(/"/g, '""')
  return /[",\r\n]/.test(guarded) ? `"${escaped}"` : escaped
}

export function buildCsv(rows: (string | number)[][]): string {
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n')
}

export function downloadCsv(filename: string, content: string): void {
  // Prefix a UTF-8 BOM so Excel reliably detects the encoding instead of mis-rendering currency symbols.
  const blob = new Blob(['﻿', content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
