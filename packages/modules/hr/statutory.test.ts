// Planner-computed golden cases (P1-06a). The CA confirms them in P1-06d.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codeWages, esiPeriodStart, statutoryFor, type PtSlab, type StatutoryInput, type WageClass } from './api/statutory'

const KA: PtSlab[] = [
  { fromPaise: 0, toPaise: 2_499_900, amountPaise: 0, februaryPaise: null },
  { fromPaise: 2_500_000, toPaise: null, amountPaise: 20_000, februaryPaise: 30_000 },
]

const e = (appliedPaise: number, wageClass: WageClass = 'wage') => ({ appliedPaise, wageClass })

function run(earnings: StatutoryInput['earnings'], over: Partial<Omit<StatutoryInput, 'person'>> & { person?: Partial<StatutoryInput['person']> } = {}) {
  const { person, ...rest } = over
  return statutoryFor({
    period: '2026-03-01',
    earnings,
    paidDays: 31,
    ncpDays: 0,
    pfRegistered: true,
    esiRegistered: true,
    person: { pfMember: true, pfOnActual: false, epsExcluded: false, esiExempt: false, workState: 'KA', ...person },
    esiCoveredThisPeriod: null,
    ptSlabs: KA,
    ...rest,
  })
}

const amounts = (r: ReturnType<typeof statutoryFor>) => Object.fromEntries(r.deductions.map((d) => [d.code, d.amountPaise]))

test('A: above the ceiling, HRA excluded, PT slab', () => {
  const r = run([e(4_000_000), e(1_600_000, 'excluded')])
  assert.deepEqual(amounts(r), { pf_employee: 180_000, professional_tax: 20_000 })
  assert.deepEqual(r.record.employer, { epsPaise: 125_000, epfPaise: 55_000, edliPaise: 7_500, pfAdminPaise: 7_500, esiPaise: 0 })
  assert.equal(r.record.esiCovered, false)
  assert.equal(r.employerCostPaise, 195_000)
  assert.equal(r.record.codeWagesPaise, 4_000_000)
})

test('B: below the ceiling and the ESI threshold', () => {
  const r = run([e(1_200_000), e(200_000, 'excluded')])
  assert.deepEqual(amounts(r), { pf_employee: 144_000, esi_employee: 10_500 })
  assert.deepEqual(r.record.employer, { epsPaise: 100_000, epfPaise: 44_000, edliPaise: 6_000, pfAdminPaise: 6_000, esiPaise: 45_500 })
  assert.equal(r.employerCostPaise, 201_500)
})

test('C: the 50% proviso adds excess exclusions to wages', () => {
  const r = run([e(1_000_000), e(800_000, 'excluded'), e(400_000, 'excluded')])
  assert.equal(r.record.codeWagesPaise, 1_100_000)
  assert.equal(amounts(r).pf_employee, 132_000)
  assert.deepEqual(r.record.employer, { epsPaise: 91_600, epfPaise: 40_400, edliPaise: 5_500, pfAdminPaise: 5_500, esiPaise: 0 })
  assert.equal(r.record.esiCovered, false)
})

test('D: PF on actual wages above the ceiling', () => {
  const r = run([e(3_000_000)], { person: { pfOnActual: true } })
  assert.equal(amounts(r).pf_employee, 360_000)
  assert.deepEqual(r.record.employer, { epsPaise: 125_000, epfPaise: 235_000, edliPaise: 7_500, pfAdminPaise: 15_000, esiPaise: 0 })
})

test('E1: ESI covered in October', () => {
  const r = run([e(2_000_000)], { period: '2026-10-01', person: { workState: null } })
  assert.equal(amounts(r).esi_employee, 15_000)
  assert.equal(r.record.employer.esiPaise, 65_000)
  assert.equal(r.record.esiCovered, true)
  assert.equal(r.record.ptState, null)
})

test('E2: still covered in November above the threshold', () => {
  const r = run([e(2_300_000)], { period: '2026-11-01', esiCoveredThisPeriod: true, person: { workState: null } })
  assert.equal(amounts(r).esi_employee, 17_300)
  assert.equal(r.record.employer.esiPaise, 74_800)
  assert.equal(r.record.esiCovered, true)
})

test('E3: a new period decides again', () => {
  const r = run([e(2_300_000)], { period: '2027-04-01', esiCoveredThisPeriod: null, person: { workState: null } })
  assert.equal(amounts(r).esi_employee, undefined)
  assert.equal(r.record.employer.esiPaise, 0)
  assert.equal(r.record.esiCovered, false)
})

test('F: low daily wage, employer pays ESI alone', () => {
  const r = run([e(500_000)])
  assert.deepEqual(amounts(r), { pf_employee: 60_000 })
  assert.deepEqual(r.record.employer, { epsPaise: 41_700, epfPaise: 18_300, edliPaise: 2_500, pfAdminPaise: 2_500, esiPaise: 16_300 })
})

test('G: loss of pay, calendar NCP days', () => {
  const r = run([e(1_129_034)], { paidDays: 25, ncpDays: 6 })
  assert.deepEqual(amounts(r), { pf_employee: 135_500, esi_employee: 8_500 })
  assert.deepEqual(r.record.employer, { epsPaise: 94_000, epfPaise: 41_500, edliPaise: 5_600, pfAdminPaise: 5_600, esiPaise: 36_700 })
  assert.equal(r.record.ncpDays, 6)
})

test('H: outside the pension scheme', () => {
  const r = run([e(2_000_000)], { person: { epsExcluded: true, workState: null } })
  assert.equal(amounts(r).pf_employee, 180_000)
  assert.deepEqual(r.record.employer, { epsPaise: 0, epfPaise: 180_000, edliPaise: 7_500, pfAdminPaise: 7_500, esiPaise: 65_000 })
  assert.equal(r.record.epsWagesPaise, 0)
})

test('I: February PT', () => {
  const r = run([e(4_000_000)], { period: '2027-02-01' })
  assert.equal(amounts(r).professional_tax, 30_000)
})

test('J: not registered, nothing statutory', () => {
  const r = run([e(4_000_000)], { pfRegistered: false, esiRegistered: false, ptSlabs: [] })
  assert.deepEqual(r.deductions, [])
  assert.equal(r.employerCostPaise, 0)
  assert.equal(r.record.esiCovered, null)
  assert.equal(r.record.ptState, null)
})

test('K: outside pay counts toward nothing', () => {
  const r = run([e(1_000_000), e(5_000_000, 'outside')], { person: { workState: null } })
  assert.equal(r.record.codeWagesPaise, 1_000_000)
  assert.equal(r.record.esiWagesPaise, 1_000_000)
  assert.equal(r.record.esiCovered, true)
})

test('codeWages adds exclusions above half of all remuneration', () => {
  assert.equal(codeWages([e(1_000_000), e(1_200_000, 'excluded')]), 1_100_000)
})

test('esiPeriodStart: contribution periods start 1 April and 1 October', () => {
  assert.equal(esiPeriodStart('2026-03-01'), '2025-10-01')
  assert.equal(esiPeriodStart('2026-04-01'), '2026-04-01')
  assert.equal(esiPeriodStart('2026-09-01'), '2026-04-01')
  assert.equal(esiPeriodStart('2026-12-01'), '2026-10-01')
})

test('L: a base with paise between two whole-rupee slabs takes the lower slab (review finding 4)', () => {
  const slabs: PtSlab[] = [
    { fromPaise: 0, toPaise: 1_000_000, amountPaise: 0, februaryPaise: null },
    { fromPaise: 1_000_100, toPaise: 1_500_000, amountPaise: 15_000, februaryPaise: null },
    { fromPaise: 1_500_100, toPaise: null, amountPaise: 20_000, februaryPaise: 30_000 },
  ]
  const r = run([e(1_500_050)], { ptSlabs: slabs })
  assert.equal(amounts(r).professional_tax, 15_000)
})

test('M: the PF base is recorded for the ECR (P1-06c)', () => {
  assert.equal(run([e(4_000_000), e(1_600_000, 'excluded')]).record.epfWagesPaise, 1_500_000)
  assert.equal(run([e(4_000_000)], { person: { pfOnActual: true } }).record.epfWagesPaise, 4_000_000)
  assert.equal(run([e(4_000_000)], { person: { pfMember: false } }).record.epfWagesPaise, 0)
})
