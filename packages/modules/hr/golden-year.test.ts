import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { purposeBalance, trialBalance } from '@campusos/module-finance/api'
import type { AccountPurpose } from '@campusos/module-finance/api'
import {
  createGratuityRule,
  createLeaveType,
  createStaff,
  createTaxRegime,
  decideLeave,
  electRegime,
  endEmployment,
  generatePayroll,
  payGratuity,
  requestLeave,
  setComponent,
  setPayrollSettings,
  setPreviousEmployment,
  setPtSlabs,
  setStatutoryIdentity,
  setTaxDeclarations,
  valueGratuity,
  type Actor,
} from './api'
import { payComponents, payslips } from './schema'

/**
 * The year-end acceptance (P1-06d): ten profiles through April 2026 to March
 * 2027, with two gratuity valuations and one payout, against the worksheet in
 * docs/audit/specs/P1-06d-golden-profiles.md (Appendix A of the plan). The
 * expected figures are the planner's, waiting for a chartered accountant's
 * signature. They are never changed to make this pass.
 */

const SLUG = 'hr-golden-'

interface College { id: string; admin: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}1`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Golden College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const [u] = await authDb
    .insert(users)
    .values({ email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Adm' })
    .returning({ id: users.id })
  return { id: i!.id, admin: { id: u!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: i!.id } }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const NEW_REGIME = {
  code: 'NEW27', name: 'New regime 2026-27', yearStartsMonth: 4, standardDeduction: '75000', cessBp: 400,
  rebateUpTo: '1200000', rebateMax: '60000', rebateMarginalRelief: true,
  slabs: [
    { from: '0', to: '400000', rateBp: 0 },
    { from: '400000', to: '800000', rateBp: 500 },
    { from: '800000', to: '1200000', rateBp: 1000 },
    { from: '1200000', to: '1600000', rateBp: 1500 },
    { from: '1600000', to: '2000000', rateBp: 2000 },
    { from: '2000000', to: '2400000', rateBp: 2500 },
    { from: '2400000', rateBp: 3000 },
  ],
  surcharges: [
    { above: '5000000', rateBp: 1000 },
    { above: '10000000', rateBp: 1500 },
    { above: '20000000', rateBp: 2500 },
  ],
}
const OLD_REGIME = {
  code: 'OLD27', name: 'Old regime 2026-27', yearStartsMonth: 4, standardDeduction: '50000', cessBp: 400,
  rebateUpTo: '500000', rebateMax: '12500', allowsDeductions: true,
  slabs: [
    { from: '0', to: '250000', rateBp: 0 },
    { from: '250000', to: '500000', rateBp: 500 },
    { from: '500000', to: '1000000', rateBp: 2000 },
    { from: '1000000', rateBp: 3000 },
  ],
  surcharges: [
    { above: '5000000', rateBp: 1000 },
    { above: '10000000', rateBp: 1500 },
    { above: '20000000', rateBp: 2500 },
    { above: '50000000', rateBp: 3700 },
  ],
}

/** Appendix A.2, in rupees: the year per person. */
const EXPECTED: Record<string, Record<string, number>> = {
  'G-01': { gross: 204000, pfEmployee: 20160, eps: 13992, epf: 6168, edli: 840, pfAdmin: 840, esiEmployee: 1536, esiEmployer: 6636, pt: 0, tds: 0 },
  'G-02': { gross: 1140000, pfEmployee: 21600, eps: 15000, epf: 6600, edli: 900, pfAdmin: 900, esiEmployee: 0, esiEmployer: 0, pt: 2500, tds: 0 },
  'G-03': { gross: 1290000, pfEmployee: 21600, eps: 15000, epf: 6600, edli: 900, pfAdmin: 900, esiEmployee: 0, esiEmployer: 0, pt: 2500, tds: 15600 },
  'G-04': { gross: 960000, pfEmployee: 21600, eps: 15000, epf: 6600, edli: 900, pfAdmin: 900, esiEmployee: 0, esiEmployer: 0, pt: 2500, tds: 40020 },
  'G-05': { gross: 1680000, pfEmployee: 144000, eps: 15000, epf: 129000, edli: 900, pfAdmin: 6000, esiEmployee: 0, esiEmployer: 0, pt: 2500, tds: 321000 },
  'G-06': { gross: 6000000, pfEmployee: 21600, eps: 0, epf: 21600, edli: 900, pfAdmin: 900, esiEmployee: 0, esiEmployer: 0, pt: 2500, tds: 1552980 },
  'G-07': { gross: 1008000, pfEmployee: 16200, eps: 11250, epf: 4950, edli: 675, pfAdmin: 675, esiEmployee: 0, esiEmployer: 0, pt: 1900, tds: 28320 },
  'G-08': { gross: 390000, pfEmployee: 10800, eps: 7500, epf: 3300, edli: 450, pfAdmin: 450, esiEmployee: 0, esiEmployer: 0, pt: 1200, tds: 0 },
  'G-09': { gross: 234500, pfEmployee: 20484, eps: 14224, epf: 6260, edli: 854, pfAdmin: 854, esiEmployee: 771, esiEmployer: 3333, pt: 0, tds: 0 },
  'G-10': { gross: 1226000, pfEmployee: 101280, eps: 15000, epf: 86280, edli: 900, pfAdmin: 4220, esiEmployee: 0, esiEmployer: 0, pt: 0, tds: 140310 },
}

/** Appendix A.3, in paise: [service years, monthly wage, amount]. */
const AT_SEP: Record<string, [number, number, number]> = {
  'G-01': [6, 1_400_000, 4_846_154],
  'G-02': [3, 5_000_000, 8_653_846],
  'G-03': [11, 6_000_000, 38_076_923],
  'G-04': [7, 5_000_000, 20_192_308],
  'G-05': [3, 10_000_000, 17_307_692],
  'G-06': [25, 30_000_000, 200_000_000],
  'G-07': [0, 8_000_000, 0],
  'G-08': [9, 5_000_000, 25_961_538],
  'G-09': [4, 2_000_000, 4_615_385],
  'G-10': [15, 7_000_000, 60_576_923],
}
const AT_MAR: Record<string, [number, number, number]> = {
  'G-01': [7, 1_400_000, 5_653_846],
  'G-02': [4, 5_000_000, 11_538_462],
  'G-03': [12, 6_000_000, 41_538_462],
  'G-04': [7, 5_000_000, 20_192_308],
  'G-05': [3, 10_000_000, 17_307_692],
  'G-06': [26, 30_000_000, 200_000_000],
  'G-07': [1, 8_000_000, 4_615_385],
  'G-09': [4, 2_000_000, 4_615_385],
  'G-10': [15, 7_000_000, 60_576_923],
}

/** Appendix A.4, in paise. */
const BOOKS = {
  pf_payable: 82_350_600,
  esi_payable: 1_227_600,
  pt_payable: 1_560_000,
  salary_tds_payable: 209_823_000,
  gratuity_provision: 366_038_463,
  employer_cost: 435_415_101,
}

const sumOf = (keys: string[]) => Object.values(EXPECTED).reduce((n, row) => n + keys.reduce((m, k) => m + row[k]!, 0), 0) * 100

const PERIODS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']

test('ten profiles across 2026-27 match the CA worksheet to the paisa', { timeout: 300_000 }, async () => {
  const c = await college()
  const nw = await createTaxRegime(c.admin, NEW_REGIME)
  const old = await createTaxRegime(c.admin, OLD_REGIME)
  await setPayrollSettings(c.admin, { prorationBasis: 'calendar', statutoryFrom: '2026-04', pfRegistered: true, esiRegistered: true, defaultRegimeId: nw.id })
  await setPtSlabs(c.admin, {
    state: 'KA',
    effectiveFrom: '2026-04',
    slabs: [{ from: '0', to: '24999', amount: '0' }, { from: '25000', amount: '200', february: '300' }],
  })
  const r = await createGratuityRule(c.admin, {
    code: 'PGA', name: 'Payment of Gratuity Act', minServiceYears: 5, daysPerYear: 15, divisorDays: 26, wageCodes: ['basic', 'da'], roundUpMonths: 6, max: '2000000',
  })
  const lwp = await createLeaveType(c.admin, { code: 'lwp', name: 'Leave without pay', paid: false })

  type Earn = [code: string, amount: string, wageClass: 'wage' | 'excluded']
  const profiles: { n: number; joinedOn: string; earn: Earn[]; state: string; pfOnActual?: boolean; epsExcluded?: boolean; pan: boolean }[] = [
    { n: 1, joinedOn: '2020-06-15', earn: [['basic', '14000', 'wage'], ['hra', '3000', 'excluded']], state: 'KA', pan: true },
    { n: 2, joinedOn: '2023-04-01', earn: [['basic', '50000', 'wage'], ['special', '25000', 'wage'], ['hra', '20000', 'excluded']], state: 'KA', pan: true },
    { n: 3, joinedOn: '2015-08-20', earn: [['basic', '60000', 'wage'], ['special', '17500', 'wage'], ['hra', '30000', 'excluded']], state: 'KA', pan: true },
    { n: 4, joinedOn: '2019-11-01', earn: [['basic', '50000', 'wage'], ['special', '10000', 'wage'], ['hra', '20000', 'excluded']], state: 'KA', pan: true },
    { n: 5, joinedOn: '2024-02-05', earn: [['basic', '100000', 'wage'], ['hra', '40000', 'excluded']], state: 'KA', pfOnActual: true, pan: false },
    { n: 6, joinedOn: '2001-04-01', earn: [['basic', '300000', 'wage'], ['special', '80000', 'wage'], ['hra', '120000', 'excluded']], state: 'KA', epsExcluded: true, pan: true },
    { n: 7, joinedOn: '2026-07-01', earn: [['basic', '80000', 'wage'], ['hra', '32000', 'excluded']], state: 'KA', pan: true },
    { n: 8, joinedOn: '2018-01-10', earn: [['basic', '45000', 'wage'], ['da', '5000', 'wage'], ['hra', '15000', 'excluded']], state: 'KA', pan: true },
    { n: 9, joinedOn: '2022-10-03', earn: [['basic', '13000', 'wage'], ['hra', '2000', 'excluded']], state: 'KA', pan: true },
    { n: 10, joinedOn: '2012-01-02', earn: [['basic', '70000', 'wage'], ['hra', '28000', 'excluded']], state: 'DL', pfOnActual: true, pan: true },
  ]
  const id: Record<number, string> = {}
  for (const p of profiles) {
    const code = `G-${String(p.n).padStart(2, '0')}`
    const s = await createStaff(c.admin, { employeeCode: code, name: `Profile P${p.n}`, designation: 'Staff', joinedOn: p.joinedOn })
    id[p.n] = s.id
    for (const [ecode, amount, wageClass] of p.earn) {
      await setComponent(c.admin, { staffId: s.id, code: ecode, label: ecode, kind: 'earning', amount, effectiveFrom: '2026-04-01', wageClass })
    }
    await setStatutoryIdentity(c.admin, {
      staffId: s.id,
      ...(p.pan ? { pan: `AAAPG${String(p.n).padStart(4, '0')}A` } : {}),
      workState: p.state,
      pfMember: true,
      pfOnActual: p.pfOnActual ?? false,
      epsExcluded: p.epsExcluded ?? false,
    })
  }
  for (const n of [4, 10]) await electRegime(c.admin, { staffId: id[n]!, regimeId: old.id, taxYear: 2026 })
  await setTaxDeclarations(c.admin, {
    staffId: id[4]!,
    taxYear: 2026,
    rows: [{ head: '80c', declared: '100000', proved: '100000' }, { head: 'rent', declared: '216000', proved: '216000', metro: false }],
  })
  await setPreviousEmployment(c.admin, { staffId: id[7]!, taxYear: 2026, income: '300000', tds: '6000' })
  await setComponent(c.admin, { staffId: id[9]!, code: 'basic', label: 'basic', kind: 'earning', amount: '20000', effectiveFrom: '2026-08-01', wageClass: 'wage' })
  const leave = await requestLeave(c.admin, { staffId: id[9]!, leaveTypeId: lwp.id, fromOn: '2026-06-10', toOn: '2026-06-12', reason: 'three days without pay' })
  await decideLeave(c.admin, { requestId: leave.id, approve: true })
  await withTenant(c.id, (tx) =>
    tx.insert(payComponents).values({
      institutionId: c.id, staffId: id[10]!, code: 'bonus', label: 'Annual bonus', kind: 'earning', amountPaise: 5_000_000,
      effectiveFrom: '2027-02-01', effectiveTo: '2027-02-28', wageClass: 'excluded',
    }),
  )

  let v1!: Awaited<ReturnType<typeof valueGratuity>>
  let v2!: Awaited<ReturnType<typeof valueGratuity>>
  for (const period of PERIODS) {
    if (period === '2026-09') await endEmployment(c.admin, { staffId: id[8]!, leftOn: '2026-09-30', reason: 'resigned to move cities' })
    const run = await generatePayroll(c.admin, { period })
    assert.deepEqual(run.failed, [], period)
    if (period === '2026-09') v1 = await valueGratuity(c.admin, { asOf: '2026-09-30', method: 'accrued', ruleId: r.id })
    if (period === '2026-10') await payGratuity(c.admin, { staffId: id[8]!, ruleId: r.id, paidOn: '2026-10-15' })
    if (period === '2027-03') v2 = await valueGratuity(c.admin, { asOf: '2027-03-31', method: 'accrued', ruleId: r.id })
  }

  // The year per person (A.2).
  const slips = await withTenant(c.id, (tx) => tx.select().from(payslips))
  const got: Record<string, Record<string, number>> = {}
  for (const p of profiles) {
    const code = `G-${String(p.n).padStart(2, '0')}`
    const mine = slips.filter((s) => s.staffId === id[p.n])
    const line = (name: string) =>
      mine.reduce((n, s) => n + (s.lines as { code: string; appliedPaise: number }[]).filter((l) => l.code === name).reduce((m, l) => m + l.appliedPaise, 0), 0)
    const emp = (k: string) => mine.reduce((n, s) => n + ((s.statutory as { employer: Record<string, number> } | null)?.employer[k] ?? 0), 0)
    got[code] = {
      gross: mine.reduce((n, s) => n + s.grossPaise, 0),
      pfEmployee: line('pf_employee'),
      eps: emp('epsPaise'),
      epf: emp('epfPaise'),
      edli: emp('edliPaise'),
      pfAdmin: emp('pfAdminPaise'),
      esiEmployee: line('esi_employee'),
      esiEmployer: emp('esiPaise'),
      pt: line('professional_tax'),
      tds: line('income_tax'),
    }
  }
  const want = Object.fromEntries(Object.entries(EXPECTED).map(([k, row]) => [k, Object.fromEntries(Object.entries(row).map(([f, rupees]) => [f, rupees * 100]))]))
  assert.deepEqual(got, want)

  // The gratuity valuations (A.3).
  assert.equal(v1.obligationPaise, 380_230_769)
  assert.equal(v2.obligationPaise, 366_038_463)
  assert.equal(v2.provisionBeforePaise, 354_269_231)
  assert.equal(v2.adjustmentPaise, 11_769_232)
  const codeOf = new Map(profiles.map((p) => [id[p.n]!, `G-${String(p.n).padStart(2, '0')}`]))
  const asMap = (lines: typeof v1.lines) => Object.fromEntries(lines.map((l) => [codeOf.get(l.staffId)!, [l.serviceYears, l.monthlyWagePaise, l.amountPaise]]))
  assert.deepEqual(asMap(v1.lines), AT_SEP)
  assert.deepEqual(asMap(v2.lines), AT_MAR)

  // The books on 31 March 2027 (A.4).
  const bal = (p: AccountPurpose) => withTenant(c.id, (tx) => purposeBalance(tx, p, '2027-03-31'))
  const pf = sumOf(['pfEmployee', 'eps', 'epf', 'edli', 'pfAdmin'])
  const esi = sumOf(['esiEmployee', 'esiEmployer'])
  const employerCost = sumOf(['eps', 'epf', 'edli', 'pfAdmin', 'esiEmployer']) + 380_230_769 + 11_769_232
  assert.equal(pf, BOOKS.pf_payable)
  assert.equal(esi, BOOKS.esi_payable)
  assert.equal(sumOf(['pt']), BOOKS.pt_payable)
  assert.equal(sumOf(['tds']), BOOKS.salary_tds_payable)
  assert.equal(employerCost, BOOKS.employer_cost)
  assert.equal(await bal('pf_payable'), pf)
  assert.equal(await bal('esi_payable'), esi)
  assert.equal(await bal('pt_payable'), sumOf(['pt']))
  assert.equal(await bal('salary_tds_payable'), sumOf(['tds']))
  assert.equal(await bal('gratuity_provision'), BOOKS.gratuity_provision)
  assert.equal(await bal('employer_cost'), employerCost)
  assert.equal((await trialBalance(c.admin)).differencePaise, 0)
})
