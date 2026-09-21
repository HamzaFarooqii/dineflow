// Shared currency/timezone option lists for the Signup form and the Store Details settings
// screen, so both stay in sync instead of drifting apart as separate copies.

// Common ISO 4217 currencies. Not exhaustive — the backend accepts any three-letter code;
// this list just covers the common cases with a friendly label.
export const CURRENCY_OPTIONS: readonly [string, string][] = [
  ['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'British Pound'], ['CAD', 'Canadian Dollar'],
  ['AUD', 'Australian Dollar'], ['NZD', 'New Zealand Dollar'], ['PKR', 'Pakistani Rupee'],
  ['INR', 'Indian Rupee'], ['AED', 'UAE Dirham'], ['SAR', 'Saudi Riyal'], ['JPY', 'Japanese Yen'],
  ['CNY', 'Chinese Yuan'], ['SGD', 'Singapore Dollar'], ['ZAR', 'South African Rand'],
  ['CHF', 'Swiss Franc'], ['SEK', 'Swedish Krona'], ['NOK', 'Norwegian Krone'], ['DKK', 'Danish Krone'],
  ['MXN', 'Mexican Peso'], ['BRL', 'Brazilian Real'], ['TRY', 'Turkish Lira'], ['EGP', 'Egyptian Pound'],
  ['NGN', 'Nigerian Naira'], ['KES', 'Kenyan Shilling'], ['PHP', 'Philippine Peso'],
  ['IDR', 'Indonesian Rupiah'], ['MYR', 'Malaysian Ringgit'], ['THB', 'Thai Baht'],
  ['VND', 'Vietnamese Dong'], ['BDT', 'Bangladeshi Taka'],
]

export function detectedTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
}

// Full IANA zone list where the runtime supports it; otherwise fall back to just the
// detected zone (plus UTC) so the form still works on an older runtime.
export function timezoneOptions(): string[] {
  try { return Intl.supportedValuesOf('timeZone') } catch { return [detectedTimezone(), 'UTC'] }
}
