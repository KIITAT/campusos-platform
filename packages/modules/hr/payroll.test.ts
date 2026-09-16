import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  daysInMonth,
  daysInPeriod,
  inForce,
  leaveRemaining,
  lossOfPay,
  payslipFor,
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

test('net is never negative, however large the deductions', () => {
  const p = payslipFor([earn('basic', 100_000), deduct('recovery', 500_000)], {
    workingDays: 30,
  })
  assert.equal(p.netPaise, 0)
  assert.equal(p.deductionsPaise, 500_000)
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

// --- leave entitlement -----------------------------------------------------

test('entitlement counts down and stops at zero', () => {
  assert.equal(leaveRemaining(12, 0), 12)
  assert.equal(leaveRemaining(12, 5), 7)
  assert.equal(leaveRemaining(12, 20), 0)
})

test('a zero entitlement means unlimited, reported as such rather than as none', () => {
  assert.equal(leaveRemaining(0, 40), null)
})
