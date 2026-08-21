/**
 * Money, in paise, as integers.
 *
 * Nothing here takes or returns a rupee float. Parsing happens once at the
 * edge, formatting happens once at the surface, and everything between is an
 * integer count of paise. That is the whole discipline.
 */

/** Indian grouping, because the first users read lakhs, not thousands. */
const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export const formatPaise = (paise: number) => inr.format(paise / 100)

/** Digits only, for a receipt line that must not depend on locale. */
export const plainPaise = (paise: number) =>
  `${paise < 0 ? '-' : ''}${Math.floor(Math.abs(paise) / 100)}.${String(Math.abs(paise) % 100).padStart(2, '0')}`

/**
 * Rupees, as typed by a person, to paise.
 *
 * Deliberately string-first and no `parseFloat`: "1234.56" scaled by
 * multiplying a double gives 123455.99999999999, and a rupee of fee income
 * lost to binary representation is a reconciliation that never balances. The
 * fractional part is read as its own integer instead.
 *
 * Accepts what a clerk actually types: separators, a currency symbol, a
 * trailing or leading space. Rejects anything else rather than guessing.
 */
export function parseRupeesToPaise(input: unknown): number | null {
  if (typeof input === 'number') {
    // Only an already-integral rupee amount is safe to take as a number.
    return Number.isInteger(input) && input >= 0 ? input * 100 : null
  }
  if (typeof input !== 'string') return null

  const cleaned = input.trim().replace(/[₹,\s]/g, '')
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(cleaned)) return null

  const [whole, frac = ''] = cleaned.split('.')
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return Number.isSafeInteger(paise) ? paise : null
}

export interface LedgerLine {
  label: string
  chargedPaise: number
  waivedPaise: number
}

export interface Ledger {
  lines: LedgerLine[]
  chargedPaise: number
  waivedPaise: number
  payablePaise: number
  paidPaise: number
  /** Recorded but not yet matched against the bank. */
  unreconciledPaise: number
  outstandingPaise: number
}

/**
 * The one place a balance is computed, so the dues report, the student view and
 * the receipt cannot disagree about what is owed.
 *
 * Outstanding counts unreconciled payments as paid. The alternative -- chasing
 * a student whose cheque is still clearing -- generates the complaint the
 * report exists to avoid. The unreconciled figure is reported alongside so the
 * accounts office can see the exposure.
 */
export function ledger(
  lines: LedgerLine[],
  payments: { amountPaise: number; reconciledAt: Date | null }[],
): Ledger {
  const chargedPaise = lines.reduce((n, l) => n + l.chargedPaise, 0)
  const waivedPaise = lines.reduce((n, l) => n + l.waivedPaise, 0)
  const paidPaise = payments.reduce((n, p) => n + p.amountPaise, 0)
  const unreconciledPaise = payments
    .filter((p) => p.reconciledAt === null)
    .reduce((n, p) => n + p.amountPaise, 0)

  const payablePaise = chargedPaise - waivedPaise
  return {
    lines,
    chargedPaise,
    waivedPaise,
    payablePaise,
    paidPaise,
    unreconciledPaise,
    // Never negative: an overpayment is a credit to refund, not a debt owed
    // backwards, and reporting it as negative dues reads as an error.
    outstandingPaise: Math.max(0, payablePaise - paidPaise),
  }
}

export const overpaidPaise = (l: Ledger) => Math.max(0, l.paidPaise - l.payablePaise)
