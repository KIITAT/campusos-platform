/**
 * The TDS estimator (P1-06b, ACC-17): tax on salary for a month from what the
 * year has actually paid so far, what an earlier employer paid, what this
 * month pays and what the rest of the year is expected to pay.
 *
 * Legal readings here are the planner's until a CA confirms them (P1-06d).
 * Rates, slabs, rebates and surcharge bands are the regime's data, entered by
 * the institution; the Act's caps and the no-PAN rate are `TDS`.
 */

import type { Regime } from './payroll'

// ponytail: one version of the caps; a Finance Act change adds an effective-dated version here. Payslips store their results, so history never moves.
export const TDS = {
  /** s.206AA, or its 2025-Act successor: no PAN, at least 20%. */
  noPanRateBp: 2000,
  /** Proofs only count from this many months before the year ends, this one included. */
  proofMonthsLeft: 3,
  hraMetroBp: 5000,
  hraOtherBp: 4000,
  hraRentFloorBp: 1000,
  /** s.16(iii) professional tax, at most ₹2,500 a year. */
  ptCapPaise: 250_000,
  hraCode: 'hra',
  hraSalaryCodes: ['basic', 'da'],
  caps: { '80c': 15_000_000, '80ccd_1b': 5_000_000, '80d': 10_000_000, '24b': 20_000_000, other: null },
} as const

export type TaxHead = '80c' | '80ccd_1b' | '80d' | '24b' | 'other' | 'rent'

export interface TdsRegime extends Regime {
  rebateMaxPaise: number | null
  rebateMarginalRelief: boolean
  allowsDeductions: boolean
  surcharges: { abovePaise: number; rateBp: number }[]
}

export interface Figures { taxablePaise: number; hraPaise: number; hraSalaryPaise: number; pfPaise: number; ptPaise: number }
export interface Declaration { head: TaxHead; declaredPaise: number; provedPaise: number | null; metro: boolean }

export interface TdsInput {
  regime: TdsRegime
  hasPan: boolean
  /** Months after this one that will be paid in the tax year: 0 for a leaver this month. */
  projectedMonths: number
  earlier: Figures
  earlierTdsPaise: number
  previous: { incomePaise: number; tdsPaise: number }
  /** This month's regular pay; `oneOffPaise` is the taxable extras on top of it. */
  thisMonth: Figures & { oneOffPaise: number }
  /** One month at contracted pay. */
  projected: Figures
  declarations: Declaration[]
}

export interface TaxRecord {
  regimeCode: string
  taxYear: number
  grossPaise: number
  hraExemptPaise: number
  deductionsPaise: number
  incomePaise: number
  annualTaxPaise: number
  oneOffPaise: number
  oneOffTaxPaise: number
  earlierTdsPaise: number
  previousTdsPaise: number
  monthsLeft: number
  noPan: boolean
}

/** s.288A and s.288B: to the nearest ten rupees. */
export const R10 = (p: number) => Math.round(p / 1000) * 1000

/** Each slab's rate on the part of the income that falls in it, unrounded. */
export function slabTax(incomePaise: number, slabs: Regime['slabs']): number {
  let tax = 0
  for (const s of slabs) {
    if (incomePaise <= s.fromPaise) continue
    const top = s.toPaise === null ? incomePaise : Math.min(incomePaise, s.toPaise)
    tax += ((top - s.fromPaise) * s.rateBp) / 10_000
  }
  return tax
}

/** A year's tax on a total income: slabs, rebate and its relief, surcharge and its relief, cess, rounded. */
export function taxOn(incomePaise: number, r: TdsRegime): number {
  let tax = slabTax(incomePaise, r.slabs)
  if (r.rebateUpToPaise !== null) {
    if (incomePaise <= r.rebateUpToPaise) tax -= r.rebateMaxPaise === null ? tax : Math.min(tax, r.rebateMaxPaise)
    else if (r.rebateMarginalRelief) tax = Math.min(tax, incomePaise - r.rebateUpToPaise)
  }
  const bands = [...r.surcharges].sort((a, b) => a.abovePaise - b.abovePaise)
  let k = -1
  bands.forEach((b, i) => {
    if (incomePaise > b.abovePaise) k = i
  })
  let withSur = tax
  if (k >= 0) {
    const T = bands[k]!.abovePaise
    const prev = k > 0 ? bands[k - 1]!.rateBp : 0
    withSur = Math.min(
      tax * (1 + bands[k]!.rateBp / 10_000),
      slabTax(T, r.slabs) * (1 + prev / 10_000) + (incomePaise - T),
    )
  }
  return R10(withSur * (1 + r.cessBp / 10_000))
}

/** The amount each head counts for: proved only in the last months of the year. */
export function resolveDeclarations(rows: Declaration[], monthsLeft: number): Map<TaxHead, { amountPaise: number; metro: boolean }> {
  const proofsDue = monthsLeft <= TDS.proofMonthsLeft
  return new Map(
    rows.map((d) => [d.head, { amountPaise: proofsDue ? (d.provedPaise ?? 0) : (d.provedPaise ?? d.declaredPaise), metro: d.metro }]),
  )
}

/** What a payslip's lines add to the year (P1-06b D6, D8, D9). */
export function figuresOf(lines: { code: string; kind: string; appliedPaise: number; taxable?: boolean }[]): Figures {
  const f: Figures = { taxablePaise: 0, hraPaise: 0, hraSalaryPaise: 0, pfPaise: 0, ptPaise: 0 }
  for (const l of lines) {
    const code = l.code.toLowerCase()
    if (l.kind === 'earning') {
      if (l.taxable !== false || code === TDS.hraCode) f.taxablePaise += l.appliedPaise
      if (code === TDS.hraCode) f.hraPaise += l.appliedPaise
      if ((TDS.hraSalaryCodes as readonly string[]).includes(code)) f.hraSalaryPaise += l.appliedPaise
    } else if (code === 'pf_employee') f.pfPaise += l.appliedPaise
    else if (code === 'professional_tax') f.ptPaise += l.appliedPaise
  }
  return f
}

export function estimateTds(i: TdsInput): { monthPaise: number; record: Omit<TaxRecord, 'regimeCode' | 'taxYear'> } {
  const monthsLeft = i.projectedMonths + 1
  const resolved = resolveDeclarations(i.declarations, monthsLeft)
  const year = (k: keyof Figures) => i.earlier[k] + i.thisMonth[k] + i.projected[k] * i.projectedMonths

  const annual = (withOneOff: boolean) => {
    const gross = year('taxablePaise') + i.previous.incomePaise + (withOneOff ? i.thisMonth.oneOffPaise : 0)
    let hraExempt = 0
    let deductions = 0
    if (i.regime.allowsDeductions) {
      const rent = resolved.get('rent')
      if (rent && rent.amountPaise > 0) {
        const salary = year('hraSalaryPaise')
        hraExempt = Math.max(
          0,
          Math.min(
            year('hraPaise'),
            rent.amountPaise - (salary * TDS.hraRentFloorBp) / 10_000,
            (salary * (rent.metro ? TDS.hraMetroBp : TDS.hraOtherBp)) / 10_000,
          ),
        )
      }
      deductions += Math.min(year('ptPaise'), TDS.ptCapPaise)
      for (const [head, cap] of Object.entries(TDS.caps) as [TaxHead, number | null][]) {
        const amount = (resolved.get(head)?.amountPaise ?? 0) + (head === '80c' ? year('pfPaise') : 0)
        deductions += cap === null ? amount : Math.min(amount, cap)
      }
    }
    const income = R10(Math.max(0, gross - i.regime.standardDeductionPaise - hraExempt - deductions))
    let tax = taxOn(income, i.regime)
    if (!i.hasPan && tax > 0) tax = Math.max(tax, R10((income * TDS.noPanRateBp) / 10_000))
    return { gross, hraExempt, deductions, income, tax }
  }

  const full = annual(true)
  const base = annual(false)
  const oneOffTax = Math.max(0, full.tax - base.tax)
  const spread = Math.max(0, base.tax - i.earlierTdsPaise - i.previous.tdsPaise) / monthsLeft
  return {
    monthPaise: Math.round((oneOffTax + spread) / 100) * 100,
    record: {
      grossPaise: full.gross,
      hraExemptPaise: full.hraExempt,
      deductionsPaise: full.deductions,
      incomePaise: full.income,
      annualTaxPaise: full.tax,
      oneOffPaise: i.thisMonth.oneOffPaise,
      oneOffTaxPaise: oneOffTax,
      earlierTdsPaise: i.earlierTdsPaise,
      previousTdsPaise: i.previous.tdsPaise,
      monthsLeft,
      noPan: !i.hasPan,
    },
  }
}
