import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthShell, useSession } from '../App'
import { requireSupabase } from '../lib/supabase'
import { loadCatalog } from '../lib/catalog'
import { provisionTerminal } from '../terminal-auth/cache'
import { request } from '../terminal-auth/api'
import '../terminal-auth/terminal-auth.css'

type Store = { id: string; name: string; timezone: string; currency: string }
// ISO 4217 active currency codes, sorted alphabetically.
const CURRENCIES = [
  ['AED', 'UAE Dirham'], ['AFN', 'Afghan Afghani'], ['ALL', 'Albanian Lek'], ['AMD', 'Armenian Dram'],
  ['ANG', 'Netherlands Antillean Guilder'], ['AOA', 'Angolan Kwanza'], ['ARS', 'Argentine Peso'], ['AUD', 'Australian Dollar'],
  ['AWG', 'Aruban Florin'], ['AZN', 'Azerbaijani Manat'], ['BAM', 'Bosnia-Herzegovina Convertible Mark'], ['BBD', 'Barbadian Dollar'],
  ['BDT', 'Bangladeshi Taka'], ['BGN', 'Bulgarian Lev'], ['BHD', 'Bahraini Dinar'], ['BIF', 'Burundian Franc'],
  ['BMD', 'Bermudian Dollar'], ['BND', 'Brunei Dollar'], ['BOB', 'Bolivian Boliviano'], ['BRL', 'Brazilian Real'],
  ['BSD', 'Bahamian Dollar'], ['BTN', 'Bhutanese Ngultrum'], ['BWP', 'Botswana Pula'], ['BYN', 'Belarusian Ruble'],
  ['BZD', 'Belize Dollar'], ['CAD', 'Canadian Dollar'], ['CDF', 'Congolese Franc'], ['CHF', 'Swiss Franc'],
  ['CLP', 'Chilean Peso'], ['CNY', 'Chinese Yuan'], ['COP', 'Colombian Peso'], ['CRC', 'Costa Rican Colón'],
  ['CUP', 'Cuban Peso'], ['CVE', 'Cape Verdean Escudo'], ['CZK', 'Czech Koruna'], ['DJF', 'Djiboutian Franc'],
  ['DKK', 'Danish Krone'], ['DOP', 'Dominican Peso'], ['DZD', 'Algerian Dinar'], ['EGP', 'Egyptian Pound'],
  ['ERN', 'Eritrean Nakfa'], ['ETB', 'Ethiopian Birr'], ['EUR', 'Euro'], ['FJD', 'Fijian Dollar'],
  ['FKP', 'Falkland Islands Pound'], ['GBP', 'British Pound'], ['GEL', 'Georgian Lari'], ['GHS', 'Ghanaian Cedi'],
  ['GIP', 'Gibraltar Pound'], ['GMD', 'Gambian Dalasi'], ['GNF', 'Guinean Franc'], ['GTQ', 'Guatemalan Quetzal'],
  ['GYD', 'Guyanese Dollar'], ['HKD', 'Hong Kong Dollar'], ['HNL', 'Honduran Lempira'], ['HTG', 'Haitian Gourde'],
  ['HUF', 'Hungarian Forint'], ['IDR', 'Indonesian Rupiah'], ['ILS', 'Israeli New Shekel'], ['INR', 'Indian Rupee'],
  ['IQD', 'Iraqi Dinar'], ['IRR', 'Iranian Rial'], ['ISK', 'Icelandic Króna'], ['JMD', 'Jamaican Dollar'],
  ['JOD', 'Jordanian Dinar'], ['JPY', 'Japanese Yen'], ['KES', 'Kenyan Shilling'], ['KGS', 'Kyrgyzstani Som'],
  ['KHR', 'Cambodian Riel'], ['KMF', 'Comorian Franc'], ['KPW', 'North Korean Won'], ['KRW', 'South Korean Won'],
  ['KWD', 'Kuwaiti Dinar'], ['KYD', 'Cayman Islands Dollar'], ['KZT', 'Kazakhstani Tenge'], ['LAK', 'Lao Kip'],
  ['LBP', 'Lebanese Pound'], ['LKR', 'Sri Lankan Rupee'], ['LRD', 'Liberian Dollar'], ['LSL', 'Lesotho Loti'],
  ['LYD', 'Libyan Dinar'], ['MAD', 'Moroccan Dirham'], ['MDL', 'Moldovan Leu'], ['MGA', 'Malagasy Ariary'],
  ['MKD', 'Macedonian Denar'], ['MMK', 'Myanmar Kyat'], ['MNT', 'Mongolian Tögrög'], ['MOP', 'Macanese Pataca'],
  ['MRU', 'Mauritanian Ouguiya'], ['MUR', 'Mauritian Rupee'], ['MVR', 'Maldivian Rufiyaa'], ['MWK', 'Malawian Kwacha'],
  ['MXN', 'Mexican Peso'], ['MYR', 'Malaysian Ringgit'], ['MZN', 'Mozambican Metical'], ['NAD', 'Namibian Dollar'],
  ['NGN', 'Nigerian Naira'], ['NIO', 'Nicaraguan Córdoba'], ['NOK', 'Norwegian Krone'], ['NPR', 'Nepalese Rupee'],
  ['NZD', 'New Zealand Dollar'], ['OMR', 'Omani Rial'], ['PAB', 'Panamanian Balboa'], ['PEN', 'Peruvian Sol'],
  ['PGK', 'Papua New Guinean Kina'], ['PHP', 'Philippine Peso'], ['PKR', 'Pakistani Rupee'], ['PLN', 'Polish Złoty'],
  ['PYG', 'Paraguayan Guaraní'], ['QAR', 'Qatari Riyal'], ['RON', 'Romanian Leu'], ['RSD', 'Serbian Dinar'],
  ['RUB', 'Russian Ruble'], ['RWF', 'Rwandan Franc'], ['SAR', 'Saudi Riyal'], ['SBD', 'Solomon Islands Dollar'],
  ['SCR', 'Seychellois Rupee'], ['SDG', 'Sudanese Pound'], ['SEK', 'Swedish Krona'], ['SGD', 'Singapore Dollar'],
  ['SHP', 'Saint Helena Pound'], ['SLE', 'Sierra Leonean Leone'], ['SOS', 'Somali Shilling'], ['SRD', 'Surinamese Dollar'],
  ['SSP', 'South Sudanese Pound'], ['STN', 'São Tomé and Príncipe Dobra'], ['SYP', 'Syrian Pound'], ['SZL', 'Eswatini Lilangeni'],
  ['THB', 'Thai Baht'], ['TJS', 'Tajikistani Somoni'], ['TMT', 'Turkmenistani Manat'], ['TND', 'Tunisian Dinar'],
  ['TOP', "Tongan Pa'anga"], ['TRY', 'Turkish Lira'], ['TTD', 'Trinidad and Tobago Dollar'], ['TWD', 'New Taiwan Dollar'],
  ['TZS', 'Tanzanian Shilling'], ['UAH', 'Ukrainian Hryvnia'], ['UGX', 'Ugandan Shilling'], ['USD', 'US Dollar'],
  ['UYU', 'Uruguayan Peso'], ['UZS', 'Uzbekistani Som'], ['VES', 'Venezuelan Bolívar'], ['VND', 'Vietnamese Đồng'],
  ['VUV', 'Vanuatu Vatu'], ['WST', 'Samoan Tālā'], ['XAF', 'Central African CFA Franc'], ['XCD', 'East Caribbean Dollar'],
  ['XOF', 'West African CFA Franc'], ['XPF', 'CFP Franc'], ['YER', 'Yemeni Rial'], ['ZAR', 'South African Rand'],
  ['ZMW', 'Zambian Kwacha'], ['ZWL', 'Zimbabwean Dollar'],
] as const
const STEPS = [
  { label: 'Restaurant profile', title: 'Name the house.', copy: 'Confirm the details your guests and guest checks will carry.' },
  { label: 'Terminal', title: 'Open the pass.', copy: 'Provision this browser as your first service terminal.' },
  { label: 'Staff', title: 'Bring on your first server.', copy: 'Issue a PIN so your team can open a terminal and start service.' },
] as const

export function OnboardingWizard() {
  const go = useNavigate()
  const { markOnboardingComplete } = useSession()
  const [step, setStep] = useState(0)
  const [store, setStore] = useState<Store>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [terminalDone, setTerminalDone] = useState(false)
  const [staffDone, setStaffDone] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const client = requireSupabase()
        const { data: { user }, error: userError } = await client.auth.getUser()
        if (userError) throw userError
        if (!user) throw new Error('Your session could not be restored. Please sign in again.')
        const { data: memberships, error: membershipError } = await client.from('store_memberships').select('store_id').eq('user_id', user.id).eq('active', true).eq('role', 'owner').limit(1)
        if (membershipError) throw membershipError
        const storeId = memberships?.[0]?.store_id
        if (!storeId) throw new Error('No restaurant was found for this account.')
        const { data: storeRow, error: storeError } = await client.from('stores').select('id,name,timezone,currency,onboarding_completed_at').eq('id', storeId).single()
        if (storeError) throw storeError
        if (storeRow.onboarding_completed_at) { go('/dashboard', { replace: true }); return }
        if (active) setStore({ id: storeRow.id, name: storeRow.name, timezone: storeRow.timezone, currency: storeRow.currency })
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load your restaurant.') }
      finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [go])

  async function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!store) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name')).trim()
    const currency = String(form.get('currency'))
    const timezone = String(form.get('timezone')).trim()
    setBusy(true); setError('')
    try {
      const client = requireSupabase()
      const { error: updateError } = await client.rpc('update_store_profile', { p_store_id: store.id, p_name: name, p_timezone: timezone, p_currency: currency })
      if (updateError) throw updateError
      setStore({ ...store, name, currency, timezone })
      setStep(1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save the restaurant profile.') }
    finally { setBusy(false) }
  }

  async function submitTerminal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!store) return
    const name = String(new FormData(event.currentTarget).get('name')).trim()
    setBusy(true); setError('')
    try {
      await provisionTerminal(store.id, name)
      setTerminalDone(true)
      setStep(2)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to provision this terminal.') }
    finally { setBusy(false) }
  }

  async function submitStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!store) return
    const form = new FormData(event.currentTarget)
    setBusy(true); setError('')
    try {
      try {
        await request('/terminal-auth/employees', { store_id: store.id, name: String(form.get('name')).trim(), role: 'cashier', active: true, pin: String(form.get('pin') ?? '') }, true)
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to add this staff member.'); return }
      setStaffDone(true)
      await finish()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The staff member was added, but setup could not be finished. Try again.') }
    finally { setBusy(false) }
  }

  async function finish() {
    if (!store) return
    const client = requireSupabase()
    const { error: completeError } = await client.rpc('complete_store_onboarding', { p_store_id: store.id })
    if (completeError) throw completeError
    await loadCatalog(store.id).catch(() => undefined)
    markOnboardingComplete()
    go('/dashboard', { replace: true })
  }

  const stepDone = (index: number) => index < step || (index === 1 && terminalDone) || (index === 2 && staffDone)
  const stepNote = <ol className="onboarding-steps">{STEPS.map((item, index) => <li key={item.label} className={index === step ? 'active' : stepDone(index) ? 'done' : ''}><span aria-hidden="true">{stepDone(index) ? '✓' : index + 1}</span>{item.label}</li>)}</ol>

  if (loading) return <main className="route-pending" role="status">Loading…</main>
  if (error && !store) return <AuthShell title="Something needs your attention." copy="We could not load your store." kicker="SET UP YOUR STORE" note={stepNote}><p role="alert" className="form-notice error">{error}</p></AuthShell>

  return <AuthShell title={STEPS[step].title} copy={STEPS[step].copy} kicker={`STEP ${step + 1} OF ${STEPS.length}`} note={stepNote}>
    <p className="kicker">STEP {step + 1} OF {STEPS.length}</p>
    <h2>{STEPS[step].label}</h2>
    <p className="form-copy">{STEPS[step].copy}</p>
    {error && <p role="alert" className="form-notice error">{error}</p>}
    {step === 0 && store && <form onSubmit={event => void submitProfile(event)} noValidate>
      <label>Store name<input name="name" defaultValue={store.name} required minLength={2} maxLength={120} /></label>
      <label>Currency<select name="currency" defaultValue={store.currency}>{CURRENCIES.map(([code, name]) => <option key={code} value={code}>{code} — {name}</option>)}</select></label>
      <label>Timezone<input name="timezone" defaultValue={store.timezone} required /></label>
      <button className="cta" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Continue'}<b aria-hidden="true">→</b></button>
    </form>}
    {step === 1 && <form onSubmit={event => void submitTerminal(event)} noValidate>
      <label>Terminal name<input name="name" required maxLength={80} placeholder="Front Counter 1" autoComplete="off" /></label>
      <button className="cta" type="submit" disabled={busy}>{busy ? 'Provisioning…' : 'Continue'}<b aria-hidden="true">→</b></button>
    </form>}
    {step === 2 && <form onSubmit={event => void submitStaff(event)} noValidate>
      <label>Cashier name<input name="name" required maxLength={80} autoComplete="off" /></label>
      <label>PIN<input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength={4} maxLength={8} required autoComplete="new-password" /></label>
      <button className="cta" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Finish setup'}<b aria-hidden="true">→</b></button>
    </form>}
  </AuthShell>
}
