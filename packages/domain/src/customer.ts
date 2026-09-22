export function customerName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Guest name is required.')
  const name = value.trim().replace(/\s+/g, ' ')
  if (name.length < 1 || name.length > 30) throw new Error('Guest name must be 1 to 30 characters.')
  return name
}

/** A country code must be supplied. We never infer one from the terminal locale. */
export function normalizedPhone(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new Error('Phone number is invalid.')
  const phone = value.trim()
  if (!/^\+[0-9\s().-]+$/.test(phone)) throw new Error('Enter a phone number starting with + and its country code.')
  const digits = phone.replace(/\D/g, '')
  if (!/^[1-9][0-9]{3,14}$/.test(digits)) throw new Error('Phone number must contain 4 to 15 international digits.')
  return digits
}
