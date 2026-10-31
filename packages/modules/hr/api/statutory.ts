/**
 * Statutory pay (P1-06a): PF, ESI and professional tax as pure functions.
 *
 * The readings behind every rule here are the planner's, pending a chartered
 * accountant's confirmation (plans/P1-06a.md section 9). Rates live in one
 * constant; a payslip stores its own result, so history never moves.
 */
import type { Component } from './payroll'

export type WageClass = 'wage' | 'excluded' | 'outside'

// ponytail: one version of the rates; a rate change adds an effective-dated version here. Payslips store their results, so history never moves.
export const STATUTORY = {
  pfCeilingPaise: 1_500_000,
  pfEmployeeBp: 1200,
  epsBp: 833,
  edliBp: 50,
  pfAdminBp: 50,
  esiThresholdPaise: 2_100_000,
  esiEmployeeBp: 75,
  esiEmployerBp: 325,
  esiLowDailyWagePaise: 17_600,
} as const

/** ISO 3166-2:IN state and union territory codes. */
export const WORK_STATES = ['AN','AP','AR','AS','BR','CH','CT','DH','DL','GA','GJ','HP','HR','JH','JK','KA','KL','LA','LD','MH','ML','MN','MP','MZ','NL','OD','PB','PY','RJ','SK','TG','TN','TR','UP','UT','WB'] as const

export interface PtSlab { fromPaise: number; toPaise: number | null; amountPaise: number; februaryPaise: number | null }

export interface StatutoryInput {
  period: string                       // YYYY-MM-01
  earnings: { appliedPaise: number; wageClass: WageClass }[]
  paidDays: number                     // calendar
  ncpDays: number                      // calendar
  pfRegistered: boolean
  esiRegistered: boolean
  person: { pfMember: boolean; pfOnActual: boolean; epsExcluded: boolean; esiExempt: boolean; workState: string | null }
  esiCoveredThisPeriod: boolean | null // from the earliest earlier payslip in the ESI period with a record; null if none
  ptSlabs: PtSlab[]                    // the person's state's set in force, already chosen
}

export interface PayslipStatutory {
  codeWagesPaise: number; pfWagesPaise: number; epsWagesPaise: number; edliWagesPaise: number
  ncpDays: number; esiWagesPaise: number; esiCovered: boolean | null; ptState: string | null
  employer: { epsPaise: number; epfPaise: number; edliPaise: number; pfAdminPaise: number; esiPaise: number }
}

export interface StatutoryResult { deductions: Component[]; employerCostPaise: number; record: PayslipStatutory }

/** Round half up to the rupee. */
const R = (paise: number, bp: number) => Math.round((paise * bp) / 1_000_000) * 100
/** Round up to the rupee. */
const C = (paise: number, bp: number) => Math.ceil((paise * bp) / 1_000_000) * 100

const sum = (e: StatutoryInput['earnings'], ...classes: WageClass[]) =>
  e.filter((x) => classes.includes(x.wageClass)).reduce((a, x) => a + x.appliedPaise, 0)

/** Wages under the Code on Social Security s.2(88): exclusions above half of all remuneration are added back. */
export function codeWages(earnings: StatutoryInput['earnings']): number {
  const wage = sum(earnings, 'wage')
  const excluded = sum(earnings, 'excluded')
  return wage + Math.max(0, excluded - Math.floor((wage + excluded) / 2))
}

/** First day of the ESI contribution period (1 April or 1 October) that holds `period`. */
export function esiPeriodStart(period: string): string {
  const y = Number(period.slice(0, 4))
  const m = Number(period.slice(5, 7))
  if (m >= 10) return `${y}-10-01`
  if (m >= 4) return `${y}-04-01`
  return `${y - 1}-10-01`
}

export function statutoryFor(i: StatutoryInput): StatutoryResult {
  const S = STATUTORY
  const deductions: Component[] = []
  const codeW = codeWages(i.earnings)
  const esiWages = sum(i.earnings, 'wage', 'excluded')
  const employer = { epsPaise: 0, epfPaise: 0, edliPaise: 0, pfAdminPaise: 0, esiPaise: 0 }
  let pfWages = 0, epsWages = 0, edliWages = 0

  if (i.pfRegistered && i.person.pfMember) {
    pfWages = codeW
    const base = i.person.pfOnActual ? pfWages : Math.min(pfWages, S.pfCeilingPaise)
    epsWages = i.person.epsExcluded ? 0 : Math.min(pfWages, S.pfCeilingPaise)
    edliWages = Math.min(pfWages, S.pfCeilingPaise)
    const pfEmployee = R(base, S.pfEmployeeBp)
    employer.epsPaise = R(epsWages, S.epsBp)
    employer.epfPaise = pfEmployee - employer.epsPaise
    employer.edliPaise = R(edliWages, S.edliBp)
    employer.pfAdminPaise = R(base, S.pfAdminBp)
    if (pfEmployee > 0) deductions.push({ code: 'pf_employee', label: 'Provident fund', kind: 'deduction', amountPaise: pfEmployee })
  }

  let esiCovered: boolean | null = null
  if (i.esiRegistered && !i.person.esiExempt) {
    esiCovered = i.esiCoveredThisPeriod ?? esiWages <= S.esiThresholdPaise
    if (esiCovered) {
      employer.esiPaise = C(esiWages, S.esiEmployerBp)
      const low = i.paidDays > 0 && esiWages / i.paidDays <= S.esiLowDailyWagePaise
      const esiEmployee = low ? 0 : C(esiWages, S.esiEmployeeBp)
      if (esiEmployee > 0) deductions.push({ code: 'esi_employee', label: 'ESI', kind: 'deduction', amountPaise: esiEmployee })
    }
  }

  let ptState: string | null = null
  if (i.person.workState && i.ptSlabs.length > 0) {
    ptState = i.person.workState
    const slab = i.ptSlabs.find((s) => s.fromPaise <= esiWages && (s.toPaise === null || esiWages <= s.toPaise))
    const pt = slab ? (i.period.slice(5, 7) === '02' && slab.februaryPaise !== null ? slab.februaryPaise : slab.amountPaise) : 0
    if (pt > 0) deductions.push({ code: 'professional_tax', label: 'Professional tax', kind: 'deduction', amountPaise: pt })
  }

  const employerCostPaise = employer.epsPaise + employer.epfPaise + employer.edliPaise + employer.pfAdminPaise + employer.esiPaise
  return {
    deductions,
    employerCostPaise,
    record: {
      codeWagesPaise: codeW, pfWagesPaise: pfWages, epsWagesPaise: epsWages, edliWagesPaise: edliWages,
      ncpDays: i.ncpDays, esiWagesPaise: esiWages, esiCovered, ptState, employer,
    },
  }
}
