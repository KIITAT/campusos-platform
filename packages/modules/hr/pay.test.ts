import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import { trialBalance } from '@campusos/module-finance/api'
import {
  HrError,
  annualTax,
  assignStructure,
  createGratuityRule,
  createStaff,
  createStructure,
  createTaxRegime,
  electRegime,
  generatePayroll,
  gratuityAmount,
  gratuityQuote,
  listRuns,
  listStaff,
  listWithheld,
  liftWithholding,
  monthlyTax,
  monthsLeftInTaxYear,
  paySalaries,
  payGratuity,
  releasePayslip,
  separate,
  serviceYears,
  setComponent,
  structureAmounts,
  taxYearOf,
  withholdSalary,
  type Actor,
  type StructureLine,
} from './api'

/**
 * Payroll, expanded: structures, income tax, gratuity, withholding and runs.
 *
 * The arithmetic is tested as pure functions first, with figures chosen so the
 * answer can be checked by hand; then through payroll, ending in the ledger.
 * None of the rates below is a statutory rate. They are test data, which is
 * all a rate ever is here.
 */

const code = (e: unknown) => (e as HrError).code

// --- the arithmetic --------------------------------------------------------

const TEACHING: StructureLine[] = [
  { code: 'pf', label: 'Provident fund', kind: 'deduction', calc: 'percent_of', amountPaise: null, percentBp: 1200, of: 'basic', taxable: false },
  { code: 'hra', label: 'HRA', kind: 'earning', calc: 'percent_of', amountPaise: null, percentBp: 4000, of: 'basic', taxable: false },
  { code: 'basic', label: 'Basic', kind: 'earning', calc: 'base', amountPaise: null, percentBp: null, of: null, taxable: true },
  { code: 'ta', label: 'Transport', kind: 'earning', calc: 'fixed', amountPaise: 320_000, percentBp: null, of: null, taxable: true },
]

test('a structure resolves percentages in any order', () => {
  const out = structureAmounts(TEACHING, 5_000_000)
  const amt = (c: string) => out.find((l) => l.code === c)!.amountPaise
  assert.equal(amt('basic'), 5_000_000)
  assert.equal(amt('hra'), 2_000_000)
  assert.equal(amt('pf'), 600_000)
  assert.equal(amt('ta'), 320_000)
})

test('a structure that refers to itself in a circle is refused', () => {
  assert.throws(() =>
    structureAmounts(
      [
        { code: 'a', label: 'A', kind: 'earning', calc: 'percent_of', amountPaise: null, percentBp: 100, of: 'b', taxable: true },
        { code: 'b', label: 'B', kind: 'earning', calc: 'percent_of', amountPaise: null, percentBp: 100, of: 'a', taxable: true },
      ],
      100,
    ),
  )
})

const REGIME = {
  standardDeductionPaise: 5_000_000, // 50,000
  cessBp: 400,
  rebateUpToPaise: 50_000_000, // 5,00,000
  slabs: [
    { fromPaise: 0, toPaise: 30_000_000, rateBp: 0 },
    { fromPaise: 30_000_000, toPaise: 60_000_000, rateBp: 500 },
    { fromPaise: 60_000_000, toPaise: null, rateBp: 1000 },
  ],
}

test('tax: deduction, slabs, cess, rebate', () => {
  // 10,50,000 - 50,000 = 10,00,000. 3L at 0, 3L at 5% = 15,000, 4L at 10% = 40,000.
  // 55,000 plus 4% cess = 57,200.
  assert.equal(annualTax(105_000_000, REGIME), 5_720_000)
  // 5,40,000 - 50,000 = 4,90,000: under the rebate threshold, nothing.
  assert.equal(annualTax(54_000_000, REGIME), 0)
  assert.equal(annualTax(0, REGIME), 0)
})

test('the year is spread over what is left of it', () => {
  assert.equal(taxYearOf('2026-03-01', 4), 2025)
  assert.equal(taxYearOf('2026-04-01', 4), 2026)
  assert.equal(monthsLeftInTaxYear('2026-04-01', 4), 12)
  assert.equal(monthsLeftInTaxYear('2026-10-01', 4), 6)
  assert.equal(monthsLeftInTaxYear('2027-03-01', 4), 1)
  assert.equal(monthlyTax(5_720_000, 0, 12), 476_700)
  assert.equal(monthlyTax(5_720_000, 5_720_000, 3), 0)
})

test('gratuity: completed years, a part-year rounded only when the rule says, a ceiling', () => {
  assert.equal(serviceYears('2020-01-15', '2026-08-14', null), 6)
  assert.equal(serviceYears('2020-01-15', '2026-08-14', 6), 7)
  assert.equal(serviceYears('2020-01-15', '2026-07-14', 6), 6)
  const rule = { minServiceYears: 5, daysPerYear: 15, divisorDays: 26, roundUpMonths: null, maxPaise: null }
  // 52,000 x 15/26 x 6 = 1,80,000
  assert.equal(gratuityAmount(5_200_000, 6, rule), 18_000_000)
  assert.equal(gratuityAmount(5_200_000, 4, rule), 0)
  assert.equal(gratuityAmount(5_200_000, 6, { ...rule, maxPaise: 10_000_000 }), 10_000_000)
})

// --- through payroll -------------------------------------------------------

let n = 0
const SLUG = 'hr-pay-'
after(async () => {
  await authDb.delete(institutions).where(sql`${institutions.slug} like ${SLUG + '%'}`)
})

async function college() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Pay College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const [u, p] = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Bursar' },
      { email: `fac@${tag}.test`, institutionId: i!.id, role: 'faculty', name: 'Fac' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: u!.id, email: null, role: 'institution_admin', institutionId: i!.id }
  const lecturer: Actor = { id: p!.id, email: null, role: 'faculty', institutionId: i!.id }
  const person = await createStaff(admin, {
    employeeCode: 'F-1', name: 'Dr Salaried', designation: 'Assistant Professor',
    department: 'Chemistry', joinedOn: '2019-06-01', userId: lecturer.id,
  })
  const structure = await createStructure(admin, {
    code: 'TEACH', name: 'Teaching staff',
    lines: TEACHING.map((l) => ({ ...l })),
  })
  return { admin, lecturer, person, structure }
}

test('a payslip is built from the structure at the person’s base', async () => {
  const c = await college()
  await assignStructure(c.admin, { staffId: c.person.id, structureId: c.structure.id, base: '50000', effectiveFrom: '2026-04-01' })
  const slip = (await generatePayroll(c.admin, { period: '2026-05' })).payslips[0]!
  assert.equal(slip.grossPaise, 5_000_000 + 2_000_000 + 320_000)
  assert.equal(slip.deductionsPaise, 600_000)
  assert.equal((await listStaff(c.admin))[0]!.monthlyGrossPaise, 7_320_000)
})

test('a per-person component overrides the structure line of the same code', async () => {
  const c = await college()
  await assignStructure(c.admin, { staffId: c.person.id, structureId: c.structure.id, base: '50000', effectiveFrom: '2026-04-01' })
  await setComponent(c.admin, {
    staffId: c.person.id, code: 'ta', label: 'Transport (hill station)', kind: 'earning', amount: '5000', effectiveFrom: '2026-04-01',
  })
  const slip = (await generatePayroll(c.admin, { period: '2026-05' })).payslips[0]!
  const ta = slip.lines.filter((l) => l.code === 'ta')
  assert.equal(ta.length, 1)
  assert.equal(ta[0]!.appliedPaise, 500_000)
})

test('a raise mid-year moves to a new structure assignment; March keeps the old base', async () => {
  const c = await college()
  await assignStructure(c.admin, { staffId: c.person.id, structureId: c.structure.id, base: '50000', effectiveFrom: '2026-01-01' })
  await assignStructure(c.admin, { staffId: c.person.id, structureId: c.structure.id, base: '60000', effectiveFrom: '2026-04-01' })
  const march = (await generatePayroll(c.admin, { period: '2026-03' })).payslips[0]!
  const april = (await generatePayroll(c.admin, { period: '2026-04' })).payslips[0]!
  assert.equal(march.lines.find((l) => l.code === 'basic')!.appliedPaise, 5_000_000)
  assert.equal(april.lines.find((l) => l.code === 'basic')!.appliedPaise, 6_000_000)
})

test('income tax is deducted on the taxable lines, and trued up as the year goes', async () => {
  const c = await college()
  // Taxable: basic 70,000 + transport 3,200 = 73,200 a month; HRA and PF are not.
  await assignStructure(c.admin, { staffId: c.person.id, structureId: c.structure.id, base: '70000', effectiveFrom: '2026-04-01' })
  const regime = await createTaxRegime(c.admin, {
    code: 'TEST', name: 'Test regime', yearStartsMonth: 4, standardDeduction: '50000', cessBp: 400,
    rebateUpTo: '500000',
    slabs: [
      { from: '0', to: '300000', rateBp: 0 },
      { from: '300000', to: '600000', rateBp: 500 },
      { from: '600000', rateBp: 1000 },
    ],
  })
  await electRegime(c.lecturer, { staffId: c.person.id, regimeId: regime.id, taxYear: 2026 })

  // 73,200 x 12 = 8,78,400; less 50,000 = 8,28,400. 15,000 + 22,840 = 37,840;
  // +4% = 39,353.60, to the rupee 39,354.
  const annual = 3_935_400
  const april = (await generatePayroll(c.admin, { period: '2026-04' })).payslips[0]!
  const t1 = april.lines.find((l) => l.code === 'income_tax')!
  assert.equal(t1.appliedPaise, Math.round(annual / 12 / 100) * 100)

  // A raise in October: the remaining months absorb it.
  await assignStructure(c.admin, { staffId: c.person.id, structureId: c.structure.id, base: '80000', effectiveFrom: '2026-10-01' })
  let paidSoFar = t1.appliedPaise
  for (const m of ['05', '06', '07', '08', '09']) {
    const s = (await generatePayroll(c.admin, { period: `2026-${m}` })).payslips[0]!
    paidSoFar += s.lines.find((l) => l.code === 'income_tax')!.appliedPaise
  }
  const oct = (await generatePayroll(c.admin, { period: '2026-10' })).payslips[0]!
  const octTax = oct.lines.find((l) => l.code === 'income_tax')!.appliedPaise
  // Taxable 83,200 x 12 = 9,98,400 - 50,000 = 9,48,400: 15,000 + 34,840 = 49,840;
  // +4% = 51,833.60, to the rupee 51,834.
  assert.equal(octTax, Math.round((5_183_400 - paidSoFar) / 6 / 100) * 100)
  assert.ok(octTax > t1.appliedPaise)

  // A withholding, so it reaches the withholdings account, not somewhere else.
  assert.equal((await trialBalance(c.admin)).differencePaise, 0)
})

test('no regime chosen, no tax line: nothing is guessed', async () => {
  const c = await college()
  await assignStructure(c.admin, { staffId: c.person.id, structureId: c.structure.id, base: '70000', effectiveFrom: '2026-04-01' })
  const slip = (await generatePayroll(c.admin, { period: '2026-04' })).payslips[0]!
  assert.ok(!slip.lines.some((l) => l.code === 'income_tax'))
})

test('overlapping slabs are refused', async () => {
  const c = await college()
  await assert.rejects(
    () => createTaxRegime(c.admin, {
      code: 'BAD', name: 'Bad', slabs: [
        { from: '0', to: '400000', rateBp: 0 },
        { from: '300000', rateBp: 500 },
      ],
    }),
    (e: unknown) => code(e) === 'bad_slabs',
  )
})

test('withheld salary accrues, stays out of the run, and is released with a reason', async () => {
  const c = await college()
  const other = await createStaff(c.admin, {
    employeeCode: 'F-2', name: 'Dr Unaffected', designation: 'Lecturer', joinedOn: '2019-06-01',
  })
  for (const s of [c.person.id, other.id]) {
    await assignStructure(c.admin, { staffId: s, structureId: c.structure.id, base: '50000', effectiveFrom: '2026-04-01' })
  }
  await withholdSalary(c.admin, { staffId: c.person.id, fromPeriod: '2026-05', reason: 'unexplained absence under inquiry' })

  const run = await generatePayroll(c.admin, { period: '2026-05' })
  assert.equal(run.generated, 2, 'the payslip is still made: the cost belongs to May')

  const paid = await paySalaries(c.admin, { period: '2026-05', paidOn: '2026-06-01' })
  assert.equal(paid.amountPaise, 6_720_000, 'only the unaffected salary goes out in the run')

  const [held] = await listWithheld(c.admin)
  assert.equal(held!.employeeCode, 'F-1')
  await releasePayslip(c.admin, {
    payslipId: held!.id, paidOn: '2026-06-20', paidFrom: 'bank', reason: 'inquiry closed, absence was approved leave',
  })
  await assert.rejects(
    () => releasePayslip(c.admin, { payslipId: held!.id, paidOn: '2026-06-21', reason: 'paying it twice' }),
    (e: unknown) => code(e) === 'already_released',
  )
  // Salaries payable back to zero once both have gone out.
  const tb = await trialBalance(c.admin)
  assert.equal(tb.rows.find((r) => r.code === '2100')!.balancePaise, 0)
  assert.equal(tb.differencePaise, 0)

  await liftWithholding(c.admin, { staffId: c.person.id })
  const june = await generatePayroll(c.admin, { period: '2026-06' })
  assert.equal(june.generated, 2)
  assert.equal((await listWithheld(c.admin)).length, 1, 'June is not held back')
})

test('gratuity is computed, paid once, after leaving, and costs the employer', async () => {
  const c = await college()
  await assignStructure(c.admin, { staffId: c.person.id, structureId: c.structure.id, base: '52000', effectiveFrom: '2019-06-01' })
  const rule = await createGratuityRule(c.admin, {
    code: 'G', name: 'Test rule', minServiceYears: 5, daysPerYear: 15, divisorDays: 26, wageCodes: ['basic'],
  })
  await assert.rejects(
    () => payGratuity(c.admin, { staffId: c.person.id, ruleId: rule.id, paidOn: '2026-09-01' }),
    (e: unknown) => code(e) === 'still_employed',
  )
  await separate(c.admin, { staffId: c.person.id, kind: 'retirement', lastDayOn: '2026-08-31', reason: 'retired on superannuation' })

  const q = await gratuityQuote(c.admin, c.person.id, rule.id)
  assert.equal(q.serviceYears, 7)
  assert.equal(q.monthlyWagePaise, 5_200_000)
  assert.equal(q.amountPaise, 21_000_000) // 52,000 x 15/26 x 7

  await payGratuity(c.admin, { staffId: c.person.id, ruleId: rule.id, paidOn: '2026-09-10' })
  await assert.rejects(
    () => payGratuity(c.admin, { staffId: c.person.id, ruleId: rule.id, paidOn: '2026-09-11' }),
    (e: unknown) => code(e) === 'already_paid',
  )
  const tb = await trialBalance(c.admin)
  assert.equal(tb.rows.find((r) => r.code === '5110')!.balancePaise, 21_000_000)
  assert.equal(tb.differencePaise, 0)
})

test('every press of generate is a run on record', async () => {
  const c = await college()
  await assignStructure(c.admin, { staffId: c.person.id, structureId: c.structure.id, base: '50000', effectiveFrom: '2026-04-01' })
  await generatePayroll(c.admin, { period: '2026-05' })
  await generatePayroll(c.admin, { period: '2026-05' })
  const runs = await listRuns(c.admin)
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map((r) => [r.generated, r.skipped]).sort(), [[0, 1], [1, 0]])
})

test('a structure has one base line, and nobody else’s runs are visible', async () => {
  const a = await college()
  const b = await college()
  await assert.rejects(
    () => createStructure(a.admin, {
      code: 'X', name: 'No base',
      lines: [{ code: 'ta', label: 'T', kind: 'earning', calc: 'fixed', amountPaise: 100 }],
    }),
    (e: unknown) => code(e) === 'bad_structure',
  )
  await generatePayroll(a.admin, { period: '2026-05' })
  assert.equal((await listRuns(b.admin)).length, 0)
})
