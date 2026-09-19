/**
 * The fee ledger: what a student was charged, what was forgiven, what has come
 * in, and what is still owed. Fee-specific, so it lives here rather than in the
 * shared money package -- a library fine has no waivers and no reconciliation.
 */

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
  /** What came in, less anything that went back out. */
  paidPaise: number
  refundedPaise: number
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
  refunds: { amountPaise: number }[] = [],
): Ledger {
  const chargedPaise = lines.reduce((n, l) => n + l.chargedPaise, 0)
  const waivedPaise = lines.reduce((n, l) => n + l.waivedPaise, 0)
  const refundedPaise = refunds.reduce((n, r) => n + r.amountPaise, 0)
  // Money returned is money no longer paid: a student refunded in full owes
  // the whole fee again, and a dues report that says otherwise is the reason
  // nobody chases them.
  const paidPaise = payments.reduce((n, p) => n + p.amountPaise, 0) - refundedPaise
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
    refundedPaise,
    unreconciledPaise,
    // Never negative: an overpayment is a credit to refund, not a debt owed
    // backwards, and reporting it as negative dues reads as an error.
    outstandingPaise: Math.max(0, payablePaise - paidPaise),
  }
}

export const overpaidPaise = (l: Ledger) => Math.max(0, l.paidPaise - l.payablePaise)
