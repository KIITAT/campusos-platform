/**
 * Arithmetic for the books, done exactly.
 *
 * Money is integer minor units and quantities integer thousandths, so adding
 * them is safe in a double. Multiplying is not: a quantity times a rate times
 * an exchange rate passes 2^53 long before any real invoice does, and a rate
 * typed as 83.2567 is not a double at all. So anything that multiplies goes
 * through BigInt and rounds once, half away from zero -- the rounding an
 * accountant does by hand, and the one GST's rules assume.
 */

const TEN = 10n

/** Round a / b to the nearest integer, halves away from zero. */
export function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero')
  const neg = a < 0n !== b < 0n
  const x = a < 0n ? -a : a
  const y = b < 0n ? -b : b
  const q = (x * 2n + y) / (y * 2n)
  return neg ? -q : q
}

/** a * b / c, rounded once. */
export function mulDiv(a: number | bigint, b: number | bigint, c: number | bigint): number {
  return Number(divRound(BigInt(a) * BigInt(b), BigInt(c)))
}

/** A share in hundredths of a percent: 1800 bp of 1000 is 180. */
export const bpOf = (amount: number, bp: number): number => mulDiv(amount, bp, 10_000)

/**
 * A decimal written by a person, as an integer scaled to `places` digits.
 *
 * Commas, spaces and a currency sign are allowed; more digits after the point
 * than `places` are refused rather than rounded away, because "12.345" typed
 * into a rupee field is a mistake to show, not a number to guess at. Null for
 * anything that is not a number.
 */
export function parseDecimal(input: unknown, places: number): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    input = input.toString()
  }
  if (typeof input !== 'string') return null
  const clean = input.replace(/[\s,₹$€£]/g, '').replace(/^\+/, '')
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(clean)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null
  const [, sign, whole, frac = ''] = m
  if (frac.length > places) return null
  const digits = `${whole || '0'}${frac.padEnd(places, '0')}`
  const value = BigInt(digits) * (sign === '-' ? -1n : 1n)
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(value)
}

/** An integer scaled by `places`, written back as a decimal: 12500, 3 -> "12.5". */
export function formatDecimal(value: number, places: number, keep = 0): string {
  const neg = value < 0
  const s = Math.abs(value).toString().padStart(places + 1, '0')
  let whole = places ? s.slice(0, -places) : s
  let frac = places ? s.slice(-places) : ''
  while (frac.length > keep && frac.endsWith('0')) frac = frac.slice(0, -1)
  whole = whole.replace(/^0+(?=\d)/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

// --- quantities -----------------------------------------------------------------

export const QTY_PLACES = 3

/** "2.5" -> 2500. */
export const parseQty = (input: unknown): number | null => parseDecimal(input, QTY_PLACES)

/** 2500 -> "2.5". */
export const formatQty = (milli: number): string => formatDecimal(milli, QTY_PLACES)

/** What `milli` units at `rate` minor units each come to. */
export const extend = (milli: number, rate: number): number => mulDiv(milli, rate, 1000)

// --- exchange rates ---------------------------------------------------------------

const RATE_PLACES = 10

/** A rate as typed -- "83.2567" -- scaled to ten places, as a bigint. */
export function rateUnits(rate: string | number): bigint {
  const scaled = parseDecimal(String(rate), RATE_PLACES)
  if (scaled === null || scaled <= 0) {
    // Ten places of a large rate overflows a double; parse as bigint instead.
    const m = /^(\d+)(?:\.(\d{0,10}))?$/.exec(String(rate).trim())
    if (!m) throw new Error(`not an exchange rate: ${rate}`)
    const v = BigInt(`${m[1]}${(m[2] ?? '').padEnd(RATE_PLACES, '0')}`)
    if (v <= 0n) throw new Error(`not an exchange rate: ${rate}`)
    return v
  }
  return BigInt(scaled)
}

/**
 * An amount in a foreign currency's minor units, in the base currency's.
 *
 * `rate` is base units per one foreign unit. The two currencies may count
 * their minor units differently -- yen has none, dinar three -- so the scale
 * is corrected on the way.
 */
export function toBase(amountFc: number, rate: string | number, fcMinor = 2, baseMinor = 2): number {
  const r = rateUnits(rate)
  const num = BigInt(amountFc) * r * TEN ** BigInt(baseMinor)
  const den = TEN ** BigInt(RATE_PLACES) * TEN ** BigInt(fcMinor)
  return Number(divRound(num, den))
}

// --- words ------------------------------------------------------------------------

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

const belowHundred = (n: number): string =>
  n < 20 ? ONES[n]! : [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(' ')

const belowThousand = (n: number): string =>
  [Math.floor(n / 100) ? `${ONES[Math.floor(n / 100)]} Hundred` : '', n % 100 ? belowHundred(n % 100) : '']
    .filter(Boolean)
    .join(' ')

/** Lakh and crore, the Indian way. */
function indianWords(n: number): string {
  if (n === 0) return 'Zero'
  const parts: string[] = []
  const crore = Math.floor(n / 10_000_000)
  const lakh = Math.floor((n % 10_000_000) / 100_000)
  const thousand = Math.floor((n % 100_000) / 1000)
  const rest = n % 1000
  if (crore) parts.push(`${indianWords(crore)} Crore`)
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`)
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`)
  if (rest) parts.push(belowThousand(rest))
  return parts.join(' ')
}

/** Thousand, million, billion, for everybody else. */
function westernWords(n: number): string {
  if (n === 0) return 'Zero'
  const scales = ['', 'Thousand', 'Million', 'Billion', 'Trillion']
  const parts: string[] = []
  let i = 0
  while (n > 0) {
    const chunk = n % 1000
    if (chunk) parts.unshift([belowThousand(chunk), scales[i]].filter(Boolean).join(' '))
    n = Math.floor(n / 1000)
    i++
  }
  return parts.join(' ')
}

const CURRENCY_WORDS: Record<string, [string, string]> = {
  INR: ['Rupees', 'Paise'],
  USD: ['US Dollars', 'Cents'],
  EUR: ['Euros', 'Cents'],
  GBP: ['Pounds', 'Pence'],
  AED: ['Dirhams', 'Fils'],
  SGD: ['Singapore Dollars', 'Cents'],
  AUD: ['Australian Dollars', 'Cents'],
  CAD: ['Canadian Dollars', 'Cents'],
  NPR: ['Nepalese Rupees', 'Paisa'],
  BDT: ['Taka', 'Poisha'],
  LKR: ['Sri Lankan Rupees', 'Cents'],
}

/** "Rupees Twelve Thousand Five Hundred and Fifty Paise Only". */
export function amountInWords(minor: number, currency = 'INR', minorUnits = 2): string {
  const neg = minor < 0
  const abs = Math.abs(minor)
  const scale = 10 ** minorUnits
  const whole = Math.floor(abs / scale)
  const part = abs % scale
  const [major, small] = CURRENCY_WORDS[currency] ?? [currency, 'Hundredths']
  const words = currency === 'INR' ? indianWords(whole) : westernWords(whole)
  const tail = part && minorUnits === 2 ? ` and ${belowHundred(part)} ${small}` : part ? ` and ${part}/${scale}` : ''
  return `${neg ? 'Minus ' : ''}${major} ${words}${tail} Only`
}

// --- showing money ------------------------------------------------------------------

/** Money in its own currency: ₹1,23,456.50, $1,234.50. */
export function formatMoney(minor: number, currency = 'INR', minorUnits = 2): string {
  const locale = currency === 'INR' ? 'en-IN' : 'en-US'
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    }).format(minor / 10 ** minorUnits)
  } catch {
    return `${currency} ${formatDecimal(minor, minorUnits, minorUnits)}`
  }
}

/** Calendar arithmetic on ISO dates, without a time zone getting a say. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, last))
  return target.toISOString().slice(0, 10)
}

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/** The last day of the month an ISO date is in. */
export function monthEnd(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

export const isIsoDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
