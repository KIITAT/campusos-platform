import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import {
  HrError,
  assignShift,
  createLeaveType,
  createShiftType,
  createStaff,
  decideLeave,
  decideShift,
  generatePayroll,
  listShiftTypes,
  requestLeave,
  requestShift,
  rotateShifts,
  roster,
  separate,
  setComponent,
  shiftMinutes,
  type Actor,
} from './api'
import {
  leaveRequests,
  leaveTypes,
  payComponents,
  payslips,
  separations,
  employmentChanges,
  shiftAssignments,
  shiftRequests,
  shiftTypes,
  staff,
} from './schema'

/**
 * Shifts: who works when, what a night is worth, and that the payslip reads
 * the same roster everybody else does.
 */

const SLUG = 'hr-shift'
const OTHER = 'hr-shift-other'
let inst: string
let other: string
const ids = { adm: '', fac: '', otherAdm: '' }
let days = ''
let nights = ''

const A = (over: Partial<Actor>): Actor => ({
  id: ids.adm,
  email: 'adm@hrshift.test',
  role: 'institution_admin',
  institutionId: inst,
  ...over,
})
const admin = () => A({})
const warden = () => A({ id: ids.fac, email: 'fac@hrshift.test', role: 'faculty' })
const outsider = () => A({ id: ids.otherAdm, institutionId: other })
const code = (e: unknown) => (e as HrError).code

const hire = (over: Record<string, unknown> = {}) =>
  createStaff(admin(), {
    employeeCode: 'W-001',
    name: 'A Warden',
    designation: 'Hostel warden',
    joinedOn: '2025-01-01',
    ...over,
  })

const onDay = async (staffId: string, from: string, to: string) => {
  const r = await roster(admin(), from, to)
  return r.rows.find((x) => x.staffId === staffId)?.days ?? []
}

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Shift College', allowedEmailDomains: ['hrshift.test'] },
      { slug: OTHER, name: 'Other', allowedEmailDomains: ['hrshiftother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@hrshift.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'fac@hrshift.test', institutionId: inst, role: 'faculty', name: 'Fac' },
      { email: 'adm@hrshiftother.test', institutionId: other, role: 'institution_admin', name: 'O' },
    ])
    .returning({ id: users.id })
  ids.adm = people[0]!.id
  ids.fac = people[1]!.id
  ids.otherAdm = people[2]!.id
})

beforeEach(async () => {
  for (const t of [inst, other]) {
    await withTenant(t, async (tx) => {
      await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
      await tx.delete(shiftRequests)
      await tx.delete(shiftAssignments)
      await tx.delete(shiftTypes)
      await tx.delete(payslips)
      await tx.delete(payComponents)
      await tx.delete(leaveRequests)
      await tx.delete(separations)
      await tx.delete(employmentChanges)
      await tx.delete(staff)
      await tx.delete(leaveTypes)
    })
  }
  days = (await createShiftType(admin(), { code: 'D', name: 'Day', startsAt: '08:00', endsAt: '16:00' })).id
  nights = (
    await createShiftType(admin(), {
      code: 'N', name: 'Night', startsAt: '22:00', endsAt: '06:00', breakMinutes: 30, allowance: '400',
    })
  ).id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

test('a night shift crosses midnight, and its hours say so', async () => {
  assert.equal(shiftMinutes('22:00', '06:00', 30), 450)
  const types = await listShiftTypes(admin())
  const n = types.find((t) => t.code === 'N')!
  assert.equal(n.overnight, true)
  assert.equal(n.hours, 7.5)
  assert.equal(n.allowancePaise, 40_000)
  await assert.rejects(() =>
    createShiftType(admin(), { code: 'Z', name: 'Nothing', startsAt: '09:00', endsAt: '09:00' }),
  )
})

test('covering nights for a fortnight carves the day shift around it', async () => {
  const w = await hire()
  await assignShift(admin(), { staffId: w.id, shiftTypeId: days, fromOn: '2026-11-01' })
  await assignShift(admin(), {
    staffId: w.id, shiftTypeId: nights, fromOn: '2026-11-10', toOn: '2026-11-23',
  })

  const r = await onDay(w.id, '2026-11-08', '2026-11-25')
  assert.deepEqual(r.slice(0, 2), ['D', 'D'], 'the part before stays')
  assert.ok(r.slice(2, 16).every((x) => x === 'N'), 'the fortnight is nights')
  assert.deepEqual(r.slice(16), ['D', 'D'], 'and days resume after')

  const rows = await withTenant(inst, (tx) =>
    tx.select().from(shiftAssignments).where(eq(shiftAssignments.staffId, w.id)),
  )
  assert.equal(rows.length, 3)
})

test('two shifts at once is refused by the database, not just the code', async () => {
  const w = await hire()
  await assignShift(admin(), { staffId: w.id, shiftTypeId: days, fromOn: '2026-11-01' })
  await assert.rejects(() =>
    withTenant(inst, (tx) =>
      tx.insert(shiftAssignments).values({
        institutionId: inst, staffId: w.id, shiftTypeId: nights, fromOn: '2026-11-05',
      }),
    ),
  )
})

test('a shift request changes nothing until approved', async () => {
  const w = await hire({ userId: ids.fac })
  await assignShift(admin(), { staffId: w.id, shiftTypeId: days, fromOn: '2026-11-01' })
  const req = await requestShift(warden(), {
    staffId: w.id, shiftTypeId: nights, fromOn: '2026-11-16', toOn: '2026-11-17',
    reason: 'swapping with a colleague',
  })
  assert.deepEqual(await onDay(w.id, '2026-11-16', '2026-11-17'), ['D', 'D'])

  // The warden does not approve their own swap.
  await assert.rejects(
    () => decideShift(warden(), { requestId: req.id, approve: true }),
    (e: unknown) => code(e) === 'forbidden',
  )
  await decideShift(admin(), { requestId: req.id, approve: true })
  assert.deepEqual(await onDay(w.id, '2026-11-15', '2026-11-18'), ['D', 'N', 'N', 'D'])
})

test('a weekly rotation alternates who is on nights', async () => {
  const a = await hire({ employeeCode: 'W-A' })
  const b = await hire({ employeeCode: 'W-B' })
  const run = await rotateShifts(admin(), {
    staffIds: [a.id, b.id], shiftTypeIds: [days, nights], fromOn: '2026-11-02', weeks: 2,
  })
  assert.equal(run.assignments, 4)
  assert.equal(run.to, '2026-11-15')

  assert.equal((await onDay(a.id, '2026-11-02', '2026-11-02'))[0], 'D')
  assert.equal((await onDay(b.id, '2026-11-02', '2026-11-02'))[0], 'N')
  assert.equal((await onDay(a.id, '2026-11-09', '2026-11-09'))[0], 'N')
  assert.equal((await onDay(b.id, '2026-11-09', '2026-11-09'))[0], 'D')
})

test('leave shows through the roster', async () => {
  const cl = (await createLeaveType(admin(), { code: 'cl', name: 'Casual', annualDays: 12 })).id
  const w = await hire()
  await assignShift(admin(), { staffId: w.id, shiftTypeId: nights, fromOn: '2026-11-01' })
  const l = await requestLeave(admin(), {
    staffId: w.id, leaveTypeId: cl, fromOn: '2026-11-03', toOn: '2026-11-04', reason: 'two nights off',
  })
  await decideLeave(admin(), { requestId: l.id, approve: true })
  assert.deepEqual(await onDay(w.id, '2026-11-02', '2026-11-05'), ['N', 'leave', 'leave', 'N'])
})

test('the payslip pays the nights actually worked, and not the ones on leave', async () => {
  const cl = (await createLeaveType(admin(), { code: 'cl', name: 'Casual', annualDays: 12 })).id
  const w = await hire()
  await setComponent(admin(), {
    staffId: w.id, code: 'basic', label: 'Basic', kind: 'earning', amount: '30000', effectiveFrom: '2025-01-01',
  })
  await assignShift(admin(), { staffId: w.id, shiftTypeId: days, fromOn: '2026-11-01' })
  await assignShift(admin(), { staffId: w.id, shiftTypeId: nights, fromOn: '2026-11-10', toOn: '2026-11-19' })
  const l = await requestLeave(admin(), {
    staffId: w.id, leaveTypeId: cl, fromOn: '2026-11-12', toOn: '2026-11-13', reason: 'two nights off',
  })
  await decideLeave(admin(), { requestId: l.id, approve: true })

  const slip = (await generatePayroll(admin(), { period: '2026-11' })).payslips[0]!
  const line = slip.lines.find((x) => x.code === 'shift:N')!
  assert.equal(line.label, 'Night allowance, 8 days')
  assert.equal(line.appliedPaise, 8 * 40_000)
  assert.equal(slip.grossPaise, 3_000_000 + 320_000)
  // The day shift has no allowance, so it adds no line.
  assert.ok(!slip.lines.some((x) => x.code === 'shift:D'))
})

test('once payroll has run, the roster for that month stands', async () => {
  const w = await hire()
  await setComponent(admin(), {
    staffId: w.id, code: 'basic', label: 'Basic', kind: 'earning', amount: '30000', effectiveFrom: '2025-01-01',
  })
  await assignShift(admin(), { staffId: w.id, shiftTypeId: nights, fromOn: '2026-11-01' })
  await generatePayroll(admin(), { period: '2026-11' })
  await assert.rejects(
    () => assignShift(admin(), { staffId: w.id, shiftTypeId: days, fromOn: '2026-11-15' }),
    (e: unknown) => code(e) === 'payroll_run',
  )
})

test('leaving ends the shift; nobody is rostered past their last day', async () => {
  const w = await hire()
  await assignShift(admin(), { staffId: w.id, shiftTypeId: nights, fromOn: '2026-11-01' })
  await assignShift(admin(), { staffId: w.id, shiftTypeId: days, fromOn: '2026-12-15' })
  await separate(admin(), {
    staffId: w.id, kind: 'resignation', lastDayOn: '2026-11-30', reason: 'moved to another city',
  })
  const rows = await withTenant(inst, (tx) =>
    tx.select().from(shiftAssignments).where(eq(shiftAssignments.staffId, w.id)),
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.toOn, '2026-11-30')

  await assert.rejects(
    () => assignShift(admin(), { staffId: w.id, shiftTypeId: days, fromOn: '2026-12-01' }),
    (e: unknown) => code(e) === 'outside_employment',
  )
})

test('one college’s roster is not another’s', async () => {
  const w = await hire()
  await assignShift(admin(), { staffId: w.id, shiftTypeId: days, fromOn: '2026-11-01' })
  assert.equal((await roster(outsider(), '2026-11-01', '2026-11-07')).rows.length, 0)
  assert.equal((await listShiftTypes(outsider())).length, 0)
})
