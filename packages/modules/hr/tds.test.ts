// Planner-computed golden cases (P1-06b). The CA confirms them in P1-06d.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateTds, resolveDeclarations, taxOn, type Declaration, type Figures, type TdsInput, type TdsRegime } from './api/tds'

const L = 100_000_00 // one lakh rupees, in paise
const rs = (rupees: number) => rupees * 100

const NEW: TdsRegime = {
  standardDeductionPaise: rs(75_000),
  cessBp: 400,
  rebateUpToPaise: 12 * L,
  rebateMaxPaise: rs(60_000),
  rebateMarginalRelief: true,
  allowsDeductions: false,
  slabs: [
    { fromPaise: 0, toPaise: 4 * L, rateBp: 0 },
    { fromPaise: 4 * L, toPaise: 8 * L, rateBp: 500 },
    { fromPaise: 8 * L, toPaise: 12 * L, rateBp: 1000 },
    { fromPaise: 12 * L, toPaise: 16 * L, rateBp: 1500 },
    { fromPaise: 16 * L, toPaise: 20 * L, rateBp: 2000 },
    { fromPaise: 20 * L, toPaise: 24 * L, rateBp: 2500 },
    { fromPaise: 24 * L, toPaise: null, rateBp: 3000 },
  ],
  surcharges: [
    { abovePaise: 50 * L, rateBp: 1000 },
    { abovePaise: 100 * L, rateBp: 1500 },
    { abovePaise: 200 * L, rateBp: 2500 },
  ],
}

const OLD: TdsRegime = {
  standardDeductionPaise: rs(50_000),
  cessBp: 400,
  rebateUpToPaise: 5 * L,
  rebateMaxPaise: rs(12_500),
  rebateMarginalRelief: false,
  allowsDeductions: true,
  slabs: [
    { fromPaise: 0, toPaise: rs(2_50_000), rateBp: 0 },
    { fromPaise: rs(2_50_000), toPaise: 5 * L, rateBp: 500 },
    { fromPaise: 5 * L, toPaise: 10 * L, rateBp: 2000 },
    { fromPaise: 10 * L, toPaise: null, rateBp: 3000 },
  ],
  surcharges: [
    { abovePaise: 50 * L, rateBp: 1000 },
    { abovePaise: 100 * L, rateBp: 1500 },
    { abovePaise: 200 * L, rateBp: 2500 },
    { abovePaise: 500 * L, rateBp: 3700 },
  ],
}

test('G1 to G8: tax on a year’s income, rebate, relief, surcharge, cess, rounding', () => {
  assert.equal(taxOn(rs(12_00_000), NEW), 0)
  assert.equal(taxOn(rs(12_10_000), NEW), rs(10_400))
  assert.equal(taxOn(rs(15_00_000), NEW), rs(1_09_200))
  assert.equal(taxOn(rs(55_00_000), NEW), rs(14_07_120))
  assert.equal(taxOn(rs(50_10_000), NEW), rs(11_33_600))
  assert.equal(taxOn(rs(5_00_000), OLD), 0)
  assert.equal(taxOn(rs(10_00_000), OLD), rs(1_17_000))
  assert.equal(taxOn(rs(12_30_010), NEW), rs(31_210))
})

const flat = (x: number): Figures => ({ taxablePaise: rs(x), hraPaise: 0, hraSalaryPaise: 0, pfPaise: 0, ptPaise: 0 })
const none = flat(0)

function input(over: Partial<TdsInput> = {}): TdsInput {
  return {
    regime: NEW,
    hasPan: true,
    projectedMonths: 11,
    earlier: none,
    earlierTdsPaise: 0,
    previous: { incomePaise: 0, tdsPaise: 0 },
    thisMonth: { ...flat(1_50_000), oneOffPaise: 0 },
    projected: flat(1_50_000),
    declarations: [],
    ...over,
  }
}

test('E1: a flat year under the new regime', () => {
  const r = estimateTds(input())
  assert.equal(r.record.annualTaxPaise, rs(1_50_800))
  assert.equal(r.monthPaise, rs(12_567))
})

test('E2: a one-off is taxed in the month it is paid', () => {
  const r = estimateTds(input({ thisMonth: { ...flat(1_50_000), oneOffPaise: rs(1_00_000) } }))
  assert.equal(r.record.oneOffTaxPaise, rs(20_800))
  assert.equal(r.monthPaise, rs(33_367))
})

test('E3: no PAN, twenty per cent of income', () => {
  const r = estimateTds(input({ hasPan: false }))
  assert.equal(r.record.annualTaxPaise, rs(3_45_000))
  assert.equal(r.monthPaise, rs(28_750))
  assert.equal(r.record.noPan, true)
})

test('E4: no PAN below the taxable limit is still nothing', () => {
  const r = estimateTds(input({ hasPan: false, thisMonth: { ...flat(50_000), oneOffPaise: 0 }, projected: flat(50_000) }))
  assert.equal(r.record.annualTaxPaise, 0)
  assert.equal(r.monthPaise, 0)
})

test('E5: a joiner with a previous employer, in October', () => {
  const r = estimateTds(input({
    projectedMonths: 5,
    earlier: flat(4_50_000),
    earlierTdsPaise: rs(24_000),
    previous: { incomePaise: rs(3_00_000), tdsPaise: rs(15_000) },
  }))
  assert.equal(r.record.grossPaise, rs(16_50_000))
  assert.equal(r.monthPaise, rs(13_650))
})

const oldMonth: Figures = { taxablePaise: rs(80_000), hraPaise: rs(20_000), hraSalaryPaise: rs(50_000), pfPaise: rs(1_800), ptPaise: rs(200) }
const oldDeclared: Declaration[] = [
  { head: '80c', declaredPaise: rs(1_00_000), provedPaise: null, metro: false },
  { head: '80d', declaredPaise: rs(25_000), provedPaise: null, metro: false },
  { head: 'rent', declaredPaise: rs(2_40_000), provedPaise: null, metro: false },
]

test('E6: the old regime with HRA, 80C with PF, 80D and PT', () => {
  const r = estimateTds(input({ regime: OLD, thisMonth: { ...oldMonth, oneOffPaise: 0 }, projected: oldMonth, declarations: oldDeclared }))
  assert.equal(r.record.hraExemptPaise, rs(1_80_000))
  assert.equal(r.record.deductionsPaise, rs(1_49_000))
  assert.equal(r.record.incomePaise, rs(5_81_000))
  assert.equal(r.record.annualTaxPaise, rs(29_850))
  assert.equal(r.monthPaise, rs(2_488))
})

test('E7: in the last three months only proved amounts count', () => {
  assert.equal(resolveDeclarations(oldDeclared, 3).get('80c')!.amountPaise, 0)
  assert.equal(resolveDeclarations(oldDeclared, 4).get('80c')!.amountPaise, 10_000_000)
})

test('E8: a leaver is never refunded through payroll', () => {
  const r = estimateTds(input({ projectedMonths: 0, earlier: flat(3_00_000), earlierTdsPaise: rs(25_134) }))
  assert.equal(r.monthPaise, 0)
})
