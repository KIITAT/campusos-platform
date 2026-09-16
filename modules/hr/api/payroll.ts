/**
 * Payroll arithmetic, as pure functions.
 *
 * Everything is integer paise, from @campusos/money's discipline: a salary
 * computed in floats is a salary that disagrees with itself by a rupee at the
 * fourth decimal, and payroll is the one place people notice immediately.
 *
 * No statutory tax here, deliberately. The spec is explicit: produce the
 * figures and let the institution's accountant file on them. Encoding TDS slabs
 * that change every February is a specialist problem and a support burden.
 */

export interface Component {
  code: string
  label: string
  kind: 'earning' | 'deduction'
  amountPaise: number
}

export interface PayslipLine extends Component {
  /** What actually went on the payslip after any loss of pay. */
  appliedPaise: number
}

export interface Payslip {
  lines: PayslipLine[]
  grossPaise: number
  deductionsPaise: number
  netPaise: number
  unpaidLeaveDays: number
  lossOfPayPaise: number
  workingDays: number
}

/** Days in the calendar month containing `period`. */
export function daysInMonth(period: Date): number {
  return new Date(period.getUTCFullYear(), period.getUTCMonth() + 1, 0).getDate()
}

/**
 * Whether a dated component was in force during a month. A component that
 * starts mid-month counts for that month: proration by day is a policy choice
 * institutions differ on, and inventing one here would be wrong for most.
 *
 * `ponytail:` whole-month application. If an institution needs day-level
 * proration for mid-month joiners, it belongs here as an explicit setting
 * rather than as a silent default.
 */
export function inForce(
  c: { effectiveFrom: string; effectiveTo: string | null },
  period: string,
): boolean {
  const monthStart = period.slice(0, 7)
  const startsBy = c.effectiveFrom.slice(0, 7) <= monthStart
  const endsAfter = c.effectiveTo === null || c.effectiveTo.slice(0, 7) >= monthStart
  return startsBy && endsAfter
}

/**
 * Loss of pay for unpaid leave: a day's worth of *earnings* per day absent,
 * rounded to whole paise, and never more than the gross.
 *
 * Deductions are not scaled. A provident fund contribution is not smaller
 * because somebody took a day off; it is calculated on what they were paid,
 * which is what `netPaise` already reflects.
 */
export function lossOfPay(
  grossPaise: number,
  unpaidDays: number,
  workingDays: number,
): number {
  if (unpaidDays <= 0 || workingDays <= 0) return 0
  const perDay = Math.round(grossPaise / workingDays)
  return Math.min(grossPaise, perDay * Math.min(unpaidDays, workingDays))
}

/**
 * Build a payslip from the components in force and the unpaid leave taken.
 *
 * The result carries its own line snapshot, because a payslip has to read the
 * same next year when the component rows behind it have been superseded.
 */
export function payslipFor(
  components: Component[],
  opts: { workingDays: number; unpaidLeaveDays?: number },
): Payslip {
  const unpaidLeaveDays = Math.max(0, opts.unpaidLeaveDays ?? 0)
  const earnings = components.filter((c) => c.kind === 'earning')
  const deductions = components.filter((c) => c.kind === 'deduction')

  const fullGross = earnings.reduce((n, c) => n + c.amountPaise, 0)
  const lop = lossOfPay(fullGross, unpaidLeaveDays, opts.workingDays)

  // Loss of pay is spread across the earnings in proportion, so the payslip
  // lines still add up to the gross rather than carrying a mystery adjustment.
  // The remainder lands on the largest line, which is where a rupee is least
  // visible and most defensible.
  const applied = new Map<string, number>()
  let spread = 0
  for (const c of earnings) {
    const share = fullGross === 0 ? 0 : Math.floor((lop * c.amountPaise) / fullGross)
    applied.set(c.code, c.amountPaise - share)
    spread += share
  }
  const remainder = lop - spread
  if (remainder > 0 && earnings.length > 0) {
    const biggest = earnings.reduce((a, b) => (b.amountPaise > a.amountPaise ? b : a))
    applied.set(biggest.code, (applied.get(biggest.code) ?? 0) - remainder)
  }

  const lines: PayslipLine[] = [
    ...earnings.map((c) => ({ ...c, appliedPaise: applied.get(c.code) ?? c.amountPaise })),
    ...deductions.map((c) => ({ ...c, appliedPaise: c.amountPaise })),
  ]

  const grossPaise = lines
    .filter((l) => l.kind === 'earning')
    .reduce((n, l) => n + l.appliedPaise, 0)
  const deductionsPaise = deductions.reduce((n, c) => n + c.amountPaise, 0)

  return {
    lines,
    grossPaise,
    deductionsPaise,
    // Never negative: deductions larger than the pay is a data error the
    // institution must see as zero-and-flagged, not as a negative salary.
    netPaise: Math.max(0, grossPaise - deductionsPaise),
    unpaidLeaveDays,
    lossOfPayPaise: lop,
    workingDays: opts.workingDays,
  }
}

/** Days of one leave span that fall inside a month, both ends inclusive. */
export function daysInPeriod(
  span: { fromOn: string; toOn: string },
  period: string,
): number {
  const monthStart = new Date(`${period.slice(0, 7)}-01T00:00:00Z`)
  const monthEnd = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0),
  )
  const from = new Date(`${span.fromOn}T00:00:00Z`)
  const to = new Date(`${span.toOn}T00:00:00Z`)

  const start = from > monthStart ? from : monthStart
  const end = to < monthEnd ? to : monthEnd
  if (end < start) return 0
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
}

/** Entitlement left this year. Zero entitlement means unlimited but recorded. */
export function leaveRemaining(annualDays: number, takenDays: number): number | null {
  if (annualDays === 0) return null
  return Math.max(0, annualDays - takenDays)
}
