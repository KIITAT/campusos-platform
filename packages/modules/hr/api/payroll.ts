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
  /** Deductions the gross could not cover: owed back by the person (ACC-14). */
  arrearsPaise: number
}

/** Days in the calendar month containing `period`. */
export function daysInMonth(period: Date): number {
  return new Date(period.getUTCFullYear(), period.getUTCMonth() + 1, 0).getDate()
}

/** How a part month is paid: by the calendar month's own days, by 30, or by 26 with Sundays off. */
export type ProrationBasis = 'calendar' | 'days_30' | 'days_26'

/** What a month's pay is divided by to make a day's pay. */
export function basisDivisor(basis: ProrationBasis, period: string): number {
  if (basis === 'days_30') return 30
  if (basis === 'days_26') return 26
  return daysInMonth(new Date(`${period.slice(0, 7)}-01T00:00:00Z`))
}

/**
 * Days from `from` to `to`, both inclusive, that count under a basis: every
 * day, except Sundays on the 26-day basis. Zero when `to` is before `from`.
 */
export function countedDays(from: string, to: string, basis: ProrationBasis): number {
  const end = Date.parse(`${to}T00:00:00Z`)
  let n = 0
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    if (basis !== 'days_26' || new Date(t).getUTCDay() !== 0) n++
  }
  return n
}

/**
 * Whether a dated component was in force during a month. A component that
 * starts mid-month counts for that month.
 *
 * `ponytail:` whole-month application of a component that starts or stops mid-month. Joining and leaving are paid by the day (generatePayroll, ACC-15); a mid-month change to a component is not.
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
 * Pay not earned in a month: unpaid leave, and days before joining or after
 * leaving (ACC-15). Employed the whole month: a day's pay per unpaid day, as
 * lossOfPay always has. Employed part of it: they earn the gross times the
 * days employed and not on unpaid leave, over the divisor, never more than
 * the gross. On the calendar basis the two agree to within a few paise.
 */
export function unearnedPay(
  grossPaise: number,
  o: { monthDays: number; employedDays: number; unpaidDays: number; divisor: number },
): number {
  if (grossPaise <= 0) return 0
  if (o.employedDays >= o.monthDays) return lossOfPay(grossPaise, o.unpaidDays, o.divisor)
  const paidDays = Math.max(0, o.employedDays - o.unpaidDays)
  return grossPaise - Math.min(grossPaise, Math.round((grossPaise * paidDays) / o.divisor))
}

/**
 * Build a payslip from the components in force and the unpaid leave taken.
 *
 * The result carries its own line snapshot, because a payslip has to read the
 * same next year when the component rows behind it have been superseded.
 */
export function payslipFor(
  components: Component[],
  opts: {
    /** Days in the month, counted under the basis. */
    workingDays: number
    /** Days employed this month, counted like workingDays; the whole month when absent. */
    employedDays?: number
    /** What a month's pay is divided by for a day; workingDays when absent. */
    divisor?: number
    unpaidLeaveDays?: number
    /**
     * One-off earnings for this month -- leave encashment, an expense
     * reimbursement -- that unpaid leave does not reduce. A day off in March
     * does not make the leave somebody sold back any smaller.
     */
    extras?: Component[]
  },
): Payslip {
  const unpaidLeaveDays = Math.max(0, opts.unpaidLeaveDays ?? 0)
  const earnings = components.filter((c) => c.kind === 'earning')
  const deductions = components.filter((c) => c.kind === 'deduction')

  const fullGross = earnings.reduce((n, c) => n + c.amountPaise, 0)
  const lop = unearnedPay(fullGross, {
    monthDays: opts.workingDays,
    employedDays: opts.employedDays ?? opts.workingDays,
    unpaidDays: unpaidLeaveDays,
    divisor: opts.divisor ?? opts.workingDays,
  })

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

  const extras = (opts.extras ?? []).filter((c) => c.kind === 'earning' && c.amountPaise > 0)

  const earningLines = [
    ...earnings.map((c) => ({ ...c, appliedPaise: applied.get(c.code) ?? c.amountPaise })),
    ...extras.map((c) => ({ ...c, appliedPaise: c.amountPaise })),
  ]
  const grossPaise = earningLines.reduce((n, l) => n + l.appliedPaise, 0)

  // Deductions are taken in the order given until the gross is used up. What
  // is left over is not deducted: it is arrears the person owes (ACC-14).
  let room = grossPaise
  const deductionLines = deductions.map((c) => {
    const taken = Math.min(c.amountPaise, room)
    room -= taken
    return { ...c, appliedPaise: taken }
  })
  const deductionsPaise = deductionLines.reduce((n, l) => n + l.appliedPaise, 0)
  const lines: PayslipLine[] = [...earningLines, ...deductionLines]

  return {
    lines,
    grossPaise,
    deductionsPaise,
    netPaise: grossPaise - deductionsPaise,
    unpaidLeaveDays,
    lossOfPayPaise: lop,
    workingDays: opts.workingDays,
    arrearsPaise: deductions.reduce((n, c) => n + c.amountPaise, 0) - deductionsPaise,
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

// --- structures, tax, gratuity ---------------------------------------------

export interface StructureLine {
  code: string
  label: string
  kind: 'earning' | 'deduction'
  calc: 'base' | 'fixed' | 'percent_of'
  amountPaise: number | null
  percentBp: number | null
  of: string | null
  taxable: boolean
}

/**
 * A structure's lines, as amounts for somebody on a given base.
 *
 * Percentages may refer to lines in any order -- PF at 12% of basic, basic
 * listed last -- so this resolves until nothing changes and refuses a cycle
 * rather than looping on one.
 */
export function structureAmounts(
  lines: StructureLine[],
  basePaise: number,
): (Component & { taxable: boolean })[] {
  const done = new Map<string, number>()
  let progressed = true
  while (progressed && done.size < lines.length) {
    progressed = false
    for (const l of lines) {
      if (done.has(l.code)) continue
      if (l.calc === 'base') done.set(l.code, basePaise)
      else if (l.calc === 'fixed') done.set(l.code, l.amountPaise ?? 0)
      else if (l.of !== null && done.has(l.of)) {
        done.set(l.code, Math.round((done.get(l.of)! * (l.percentBp ?? 0)) / 10_000))
      } else continue
      progressed = true
    }
  }
  if (done.size < lines.length) {
    const stuck = lines.filter((l) => !done.has(l.code)).map((l) => l.code)
    throw new Error(`structure lines refer to each other in a circle, or to nothing: ${stuck.join(', ')}`)
  }
  return lines.map((l) => ({
    code: l.code,
    label: l.label,
    kind: l.kind,
    amountPaise: done.get(l.code)!,
    taxable: l.taxable,
  }))
}

export interface Regime {
  standardDeductionPaise: number
  cessBp: number
  rebateUpToPaise: number | null
  slabs: { fromPaise: number; toPaise: number | null; rateBp: number }[]
}

/**
 * Tax on a year's taxable income under a regime the institution entered:
 * standard deduction off the top, each slab's rate on the part of income that
 * falls in it, a full rebate at or below the threshold if the regime has one,
 * cess on the tax, rounded to the rupee.
 *
 * No rate here is a default. The regime is data.
 */
export function annualTax(taxableIncomePaise: number, regime: Regime): number {
  const income = Math.max(0, taxableIncomePaise - regime.standardDeductionPaise)
  if (regime.rebateUpToPaise !== null && income <= regime.rebateUpToPaise) return 0
  let tax = 0
  for (const s of regime.slabs) {
    if (income <= s.fromPaise) continue
    const top = s.toPaise === null ? income : Math.min(income, s.toPaise)
    tax += ((top - s.fromPaise) * s.rateBp) / 10_000
  }
  tax += (tax * regime.cessBp) / 10_000
  return Math.round(tax / 100) * 100
}

/**
 * This month's deduction toward a year's tax: what is still owed, spread over
 * the months left, this one included. A raise in October is absorbed by the
 * months after it instead of being a surprise in March.
 */
export function monthlyTax(annual: number, alreadyDeducted: number, monthsLeft: number): number {
  if (monthsLeft <= 0) return 0
  return Math.max(0, Math.round((annual - alreadyDeducted) / monthsLeft / 100) * 100)
}

/** The tax year a month falls in, named by the calendar year it starts in. */
export function taxYearOf(period: string, startsMonth: number): number {
  const y = Number(period.slice(0, 4))
  const m = Number(period.slice(5, 7))
  return m >= startsMonth ? y : y - 1
}

/** Months from `period` to the end of its tax year, this one included. */
export function monthsLeftInTaxYear(period: string, startsMonth: number): number {
  const m = Number(period.slice(5, 7))
  return ((startsMonth - m + 11) % 12) + 1
}

export interface GratuityRuleShape {
  minServiceYears: number
  daysPerYear: number
  divisorDays: number
  roundUpMonths: number | null
  maxPaise: number | null
}

/** Completed years between two dates, with a part-year counted whole at `roundUpMonths`. */
export function serviceYears(joinedOn: string, leftOn: string, roundUpMonths: number | null): number {
  const [jy, jm, jd] = joinedOn.split('-').map(Number) as [number, number, number]
  const [ly, lm, ld] = leftOn.split('-').map(Number) as [number, number, number]
  let months = (ly - jy) * 12 + (lm - jm)
  if (ld < jd) months--
  const years = Math.floor(months / 12)
  const rest = months - years * 12
  return roundUpMonths !== null && rest >= roundUpMonths ? years + 1 : years
}

/** Gratuity: wage x days per year / divisor x years, nothing below the minimum service, capped. */
export function gratuityAmount(monthlyWagePaise: number, years: number, rule: GratuityRuleShape): number {
  if (years < rule.minServiceYears) return 0
  const raw = Math.round((monthlyWagePaise * rule.daysPerYear * years) / rule.divisorDays)
  return rule.maxPaise === null ? raw : Math.min(raw, rule.maxPaise)
}
