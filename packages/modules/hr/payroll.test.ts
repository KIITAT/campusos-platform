import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  basisDivisor,
  countedDays,
  daysInMonth,
  daysInPeriod,
  inForce,
  leaveRemaining,
  lossOfPay,
  payslipFor,
  unearnedPay,
  type Component,
} from './api/payroll'

const earn = (code: string, paise: number): Component => ({
  code,
  label: code,
  kind: 'earning',
  amountPaise: paise,
})
const deduct = (code: string, paise: number): Component => ({
  code,
  label: code,
  kind: 'deduction',
  amountPaise: paise,
})

const salary = [earn('basic', 4_000_000), earn('hra', 1_600_000), deduct('pf', 480_000)]

// --- calendar --------------------------------------------------------------

test('month lengths are the real ones, leap years included', () => {
  assert.equal(daysInMonth(new Date('2026-02-01T00:00:00Z')), 28)
  assert.equal(daysInMonth(new Date('2028-02-01T00:00:00Z')), 29)
  assert.equal(daysInMonth(new Date('2026-04-01T00:00:00Z')), 30)
  assert.equal(daysInMonth(new Date('2026-12-01T00:00:00Z')), 31)
})

test('a component in force covers the month it starts in', () => {
  const c = { effectiveFrom: '2026-08-15', effectiveTo: null }
  assert.equal(inForce(c, '2026-07-01'), false)
  assert.equal(inForce(c, '2026-08-01'), true)
  assert.equal(inForce(c, '2027-01-01'), true)
})

test('a component that ended stops applying the month after', () => {
  const c = { effectiveFrom: '2026-01-01', effectiveTo: '2026-08-31' }
  assert.equal(inForce(c, '2026-08-01'), true)
  assert.equal(inForce(c, '2026-09-01'), false)
})

test('leave days are counted only where they fall inside the month', () => {
  // Straddling the boundary: 29, 30, 31 August is three days of August.
  assert.equal(daysInPeriod({ fromOn: '2026-08-29', toOn: '2026-09-02' }, '2026-08-01'), 3)
  assert.equal(daysInPeriod({ fromOn: '2026-08-29', toOn: '2026-09-02' }, '2026-09-01'), 2)
  // Entirely elsewhere
  assert.equal(daysInPeriod({ fromOn: '2026-06-01', toOn: '2026-06-05' }, '2026-08-01'), 0)
  // One day is one day, not zero
  assert.equal(daysInPeriod({ fromOn: '2026-08-10', toOn: '2026-08-10' }, '2026-08-01'), 1)
})

// --- loss of pay -----------------------------------------------------------

test('no unpaid leave is no loss of pay', () => {
  assert.equal(lossOfPay(5_600_000, 0, 31), 0)
})

test('a day of unpaid leave costs a day of earnings', () => {
  // 56,000 over 28 days is 2,000 a day.
  assert.equal(lossOfPay(5_600_000, 1, 28), 200_000)
  assert.equal(lossOfPay(5_600_000, 3, 28), 600_000)
})

test('loss of pay never exceeds the pay itself', () => {
  assert.equal(lossOfPay(5_600_000, 90, 30), 5_600_000)
})

test('loss of pay stays whole paise for awkward month lengths', () => {
  for (const days of [28, 29, 30, 31]) {
    for (let absent = 1; absent <= days; absent++) {
      const v = lossOfPay(5_600_000, absent, days)
      assert.ok(Number.isInteger(v), `${days}/${absent} gave ${v}`)
      assert.ok(v <= 5_600_000)
    }
  }
})

// --- the payslip -----------------------------------------------------------

test('gross is earnings, net is gross less deductions', () => {
  const p = payslipFor(salary, { workingDays: 30 })
  assert.equal(p.grossPaise, 5_600_000)
  assert.equal(p.deductionsPaise, 480_000)
  assert.equal(p.netPaise, 5_120_000)
  assert.equal(p.lossOfPayPaise, 0)
})

test('the lines always add up to the gross, loss of pay included', () => {
  const p = payslipFor(salary, { workingDays: 28, unpaidLeaveDays: 3 })
  const earned = p.lines
    .filter((l) => l.kind === 'earning')
    .reduce((n, l) => n + l.appliedPaise, 0)
  assert.equal(earned, p.grossPaise, 'no mystery adjustment line')
  assert.equal(p.grossPaise, 5_600_000 - p.lossOfPayPaise)
})

test('loss of pay is spread across earnings and leaves no stray paise', () => {
  // Deliberately awkward: amounts that do not divide cleanly by anything.
  const odd = [earn('basic', 3_333_333), earn('hra', 1_111_111), earn('conv', 777)]
  for (let absent = 1; absent <= 31; absent++) {
    const p = payslipFor(odd, { workingDays: 31, unpaidLeaveDays: absent })
    const earned = p.lines.reduce((n, l) => n + l.appliedPaise, 0)
    assert.equal(earned, p.grossPaise, `absent ${absent}`)
    assert.equal(
      p.grossPaise,
      3_333_333 + 1_111_111 + 777 - p.lossOfPayPaise,
      `absent ${absent}`,
    )
    assert.ok(p.lines.every((l) => Number.isInteger(l.appliedPaise)))
  }
})

test('deductions are not scaled down by absence', () => {
  // A provident fund contribution is calculated on what was paid, and what was
  // paid is already reduced -- scaling it again would deduct twice.
  const p = payslipFor(salary, { workingDays: 30, unpaidLeaveDays: 5 })
  assert.equal(p.deductionsPaise, 480_000)
})

test('deductions stop at the gross, in order, and the rest is arrears (ACC-14)', () => {
  const p = payslipFor([earn('basic', 100_000), deduct('pf', 60_000), deduct('recovery', 500_000)], {
    workingDays: 30,
  })
  assert.equal(p.grossPaise, 100_000)
  assert.equal(p.deductionsPaise, 100_000)
  assert.equal(p.netPaise, 0)
  assert.equal(p.arrearsPaise, 460_000)
  assert.equal(p.lines.find((l) => l.code === 'pf')!.appliedPaise, 60_000)
  const recovery = p.lines.find((l) => l.code === 'recovery')!
  assert.equal(recovery.appliedPaise, 40_000)
  assert.equal(recovery.amountPaise, 500_000)
})

test('a staff member with no components gets a zero payslip, not a crash', () => {
  const p = payslipFor([], { workingDays: 30, unpaidLeaveDays: 4 })
  assert.deepEqual([p.grossPaise, p.deductionsPaise, p.netPaise, p.lossOfPayPaise], [0, 0, 0, 0])
})

test('a whole month of unpaid leave pays nothing but still deducts nothing extra', () => {
  const p = payslipFor(salary, { workingDays: 30, unpaidLeaveDays: 30 })
  assert.equal(p.grossPaise, 0)
  assert.equal(p.netPaise, 0)
})

test('the snapshot keeps both the contracted and the applied figure', () => {
  const p = payslipFor(salary, { workingDays: 30, unpaidLeaveDays: 3 })
  const basic = p.lines.find((l) => l.code === 'basic')!
  assert.equal(basic.amountPaise, 4_000_000, 'what they are on')
  assert.ok(basic.appliedPaise < basic.amountPaise, 'what they were paid')
})

// --- part months (ACC-15) ------------------------------------------------

test('what a day is under each basis (ACC-15)', () => {
  assert.equal(basisDivisor('calendar', '2026-03-01'), 31)
  assert.equal(basisDivisor('calendar', '2026-02-01'), 28)
  assert.equal(basisDivisor('days_30', '2026-03-01'), 30)
  assert.equal(basisDivisor('days_26', '2026-03-01'), 26)
  assert.equal(countedDays('2026-03-01', '2026-03-31', 'calendar'), 31)
  assert.equal(countedDays('2026-03-01', '2026-03-31', 'days_26'), 26)
  assert.equal(countedDays('2026-03-20', '2026-03-31', 'calendar'), 12)
  assert.equal(countedDays('2026-03-20', '2026-03-31', 'days_26'), 10)
  assert.equal(countedDays('2026-03-05', '2026-03-04', 'calendar'), 0)
})

test('a joiner is paid for the days employed (ACC-15)', () => {
  const p = payslipFor(salary, { workingDays: 31, employedDays: 12, divisor: 31 })
  assert.equal(p.grossPaise, 2_167_742)
  assert.equal(p.lossOfPayPaise, 3_432_258)
  assert.equal(p.deductionsPaise, 480_000)
  assert.equal(p.netPaise, 1_687_742)
  assert.equal(p.arrearsPaise, 0)
  const earned = p.lines.filter((l) => l.kind === 'earning').reduce((n, l) => n + l.appliedPaise, 0)
  assert.equal(earned, p.grossPaise)
})

test('the 30- and 26-day bases pay a part month by its days (ACC-15)', () => {
  assert.equal(payslipFor(salary, { workingDays: 31, employedDays: 12, divisor: 30 }).grossPaise, 2_240_000)
  assert.equal(payslipFor(salary, { workingDays: 26, employedDays: 10, divisor: 26 }).grossPaise, 2_153_846)
})

test('unpaid leave inside a part month is not paid twice over (ACC-15)', () => {
  const o = { workingDays: 31, employedDays: 12, divisor: 31, unpaidLeaveDays: 2 }
  assert.equal(payslipFor(salary, o).grossPaise, 1_806_452)
  assert.equal(
    unearnedPay(5_600_000, { monthDays: 31, employedDays: 12, unpaidDays: 2, divisor: 31 }),
    3_793_548,
  )
})

test('a whole month is unchanged by the basis apart from the day it divides by (ACC-15)', () => {
  assert.equal(
    payslipFor(salary, { workingDays: 31, divisor: 30, unpaidLeaveDays: 1 }).grossPaise,
    5_600_000 - Math.round(5_600_000 / 30),
  )
  assert.equal(payslipFor(salary, { workingDays: 30 }).grossPaise, 5_600_000)
})

// --- leave entitlement -----------------------------------------------------

test('entitlement counts down and stops at zero', () => {
  assert.equal(leaveRemaining(12, 0), 12)
  assert.equal(leaveRemaining(12, 5), 7)
  assert.equal(leaveRemaining(12, 20), 0)
})

test('a zero entitlement means unlimited, reported as such rather than as none', () => {
  assert.equal(leaveRemaining(0, 40), null)
})
