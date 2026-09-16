import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { auditLog, authDb, db, institutions, users, withTenant } from '@campusos/db'
import {
  HrError,
  cancelLeave,
  componentsFor,
  createLeaveType,
  createStaff,
  decideLeave,
  endEmployment,
  generatePayroll,
  leaveBalances,
  listLeave,
  listPayslips,
  listStaff,
  myEmployment,
  requestLeave,
  setComponent,
  type Actor,
} from './api'
import { leaveRequests, leaveTypes, payComponents, payslips, staff } from './schema'

const SLUG = 'hr-test'
const OTHER = 'hr-other'
let inst: string
let other: string
const ids = { adm: '', clerk: '', fac: '' }
let casual = ''
let unpaid = ''

const A = (over: Partial<Actor>): Actor => ({
  id: ids.adm,
  email: 'adm@hr.test',
  role: 'institution_admin',
  institutionId: inst,
  ...over,
})
const admin = () => A({})
const clerk = () => A({ id: ids.clerk, email: 'clerk@hr.test', role: 'accounts_staff' })
const teacher = () => A({ id: ids.fac, email: 'fac@hr.test', role: 'faculty' })
const code = (e: unknown) => (e as HrError).code
const status = (e: unknown) => (e as HrError).status

const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    text += x.message + String.fromCharCode(10)
  }
  return re.test(text)
}

const hire = (over: Record<string, unknown> = {}) =>
  createStaff(admin(), {
    employeeCode: 'E-001',
    name: 'A Lecturer',
    designation: 'Assistant Professor',
    joinedOn: '2026-01-01',
    ...over,
  })

async function paid(staffId: string, from = '2026-01-01') {
  await setComponent(admin(), {
    staffId, code: 'basic', label: 'Basic', kind: 'earning', amount: '40000', effectiveFrom: from,
  })
  await setComponent(admin(), {
    staffId, code: 'hra', label: 'HRA', kind: 'earning', amount: '16000', effectiveFrom: from,
  })
  await setComponent(admin(), {
    staffId, code: 'pf', label: 'Provident fund', kind: 'deduction', amount: '4800', effectiveFrom: from,
  })
}

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'HR College', allowedEmailDomains: ['hr.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['hrother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@hr.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'clerk@hr.test', institutionId: inst, role: 'accounts_staff', name: 'Clerk' },
      { email: 'fac@hr.test', institutionId: inst, role: 'faculty', name: 'Fac' },
    ])
    .returning({ id: users.id })
  ids.adm = people[0]!.id
  ids.clerk = people[1]!.id
  ids.fac = people[2]!.id
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(payslips)
    await tx.delete(payComponents)
    await tx.delete(leaveRequests)
    await tx.delete(leaveTypes)
    await tx.delete(staff)
    await tx.delete(auditLog)
  })
  casual = (await createLeaveType(admin(), { code: 'cl', name: 'Casual leave', annualDays: 12 })).id
  unpaid = (
    await createLeaveType(admin(), { code: 'lwp', name: 'Leave without pay', paid: false })
  ).id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

// --- who may do what -------------------------------------------------------

test('a lecturer cannot hire, set pay, or read the staff list', async () => {
  await assert.rejects(
    () => createStaff(teacher(), { employeeCode: 'X', name: 'X', designation: 'X', joinedOn: '2026-01-01' }),
    (e: unknown) => status(e) === 403,
  )
  await assert.rejects(() => listStaff(teacher()), (e: unknown) => status(e) === 403)
})

test('the finance office runs payroll but does not set salaries', async () => {
  const s = await hire()
  await assert.rejects(
    () =>
      setComponent(clerk(), {
        staffId: s.id, code: 'basic', label: 'Basic', kind: 'earning',
        amount: '40000', effectiveFrom: '2026-01-01',
      }),
    (e: unknown) => status(e) === 403,
  )
  await paid(s.id)
  const run = await generatePayroll(clerk(), { period: '2026-03' })
  assert.equal(run.generated, 1)
})

// --- staff records ---------------------------------------------------------

test('a staff member needs no login', async () => {
  const s = await hire({ employeeCode: 'C-001', name: 'A Cook', designation: 'Cook' })
  assert.equal(s.userId, null)
  assert.equal((await listStaff(admin())).length, 1)
})

test('employee codes are unique within the institution', async () => {
  await hire()
  await assert.rejects(() => hire(), (e: unknown) => code(e) === 'exists')
})

test('one staff record per login', async () => {
  await hire({ userId: ids.fac })
  await assert.rejects(
    () => hire({ employeeCode: 'E-002', userId: ids.fac }),
    (e: unknown) => code(e) === 'exists',
  )
})

test('ending employment is audited and cannot happen twice', async () => {
  const s = await hire()
  await endEmployment(admin(), { staffId: s.id, leftOn: '2026-06-30', reason: 'resigned in May' })
  await assert.rejects(
    () => endEmployment(admin(), { staffId: s.id, leftOn: '2026-07-30', reason: 'resigned again' }),
    (e: unknown) => code(e) === 'already_ended',
  )
  const trail = await withTenant(inst, (tx) =>
    tx.select({ action: auditLog.action }).from(auditLog),
  )
  assert.equal(trail[0]!.action, 'hr.employment_ended')
})

test('somebody cannot leave before they joined', async () => {
  const s = await hire()
  await assert.rejects(
    () => endEmployment(admin(), { staffId: s.id, leftOn: '2025-12-01', reason: 'impossible date' }),
    (e: unknown) => code(e) === 'bad_dates',
  )
})

// --- pay components --------------------------------------------------------

test('setting a component supersedes the previous one rather than overwriting it', async () => {
  const s = await hire()
  await setComponent(admin(), {
    staffId: s.id, code: 'basic', label: 'Basic', kind: 'earning',
    amount: '40000', effectiveFrom: '2026-01-01',
  })
  await setComponent(admin(), {
    staffId: s.id, code: 'basic', label: 'Basic', kind: 'earning',
    amount: '45000', effectiveFrom: '2026-08-01',
  })

  const rows = await componentsFor(admin(), s.id)
  assert.equal(rows.length, 2, 'history is kept')
  const old = rows.find((r) => r.amountPaise === 4_000_000)!
  assert.equal(old.effectiveTo, '2026-07-31', 'closed the day before the raise')
})

test('two components of the same code cannot both be in force', async () => {
  const s = await hire()
  await setComponent(admin(), {
    staffId: s.id, code: 'basic', label: 'Basic', kind: 'earning',
    amount: '40000', effectiveFrom: '2026-01-01',
  })
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.insert(payComponents).values({
          institutionId: inst, staffId: s.id, code: 'basic', label: 'Sneaky',
          kind: 'earning', amountPaise: 9_900_000, effectiveFrom: '2026-03-01',
        }),
      ),
    saysDb(/hr_pay_components_no_overlap|conflicting key/),
  )
})

// --- leave -----------------------------------------------------------------

test('a request starts pending and is decided by somebody else', async () => {
  const s = await hire({ userId: ids.fac })
  const r = await requestLeave(teacher(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-04-06', toOn: '2026-04-08',
    reason: 'family function at home',
  })
  assert.equal(r.status, 'pending')

  const decided = await decideLeave(admin(), { requestId: r.id, approve: true, note: 'fine' })
  assert.equal(decided.status, 'approved')
  assert.ok(decided.decidedAt)
})

test('nobody approves their own leave', async () => {
  const s = await hire({ userId: ids.adm })
  const r = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-04-06', toOn: '2026-04-08',
    reason: 'own leave request',
  })
  await assert.rejects(
    () => decideLeave(admin(), { requestId: r.id, approve: true }),
    (e: unknown) => code(e) === 'self_approval',
  )
})

test('a lecturer cannot file leave on somebody else s behalf', async () => {
  const mine = await hire({ userId: ids.fac })
  const theirs = await hire({ employeeCode: 'E-002', name: 'Another' })
  await requestLeave(teacher(), {
    staffId: mine.id, leaveTypeId: casual, fromOn: '2026-04-06', toOn: '2026-04-06',
    reason: 'one day at home',
  })
  await assert.rejects(
    () =>
      requestLeave(teacher(), {
        staffId: theirs.id, leaveTypeId: casual, fromOn: '2026-04-06', toOn: '2026-04-06',
        reason: 'not mine to file',
      }),
    (e: unknown) => status(e) === 403,
  )
})

test('deciding twice is refused', async () => {
  const s = await hire()
  const r = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-04-06', toOn: '2026-04-06',
    reason: 'one day at home',
  })
  await decideLeave(admin(), { requestId: r.id, approve: false, note: 'too short notice' })
  await assert.rejects(
    () => decideLeave(admin(), { requestId: r.id, approve: true }),
    (e: unknown) => code(e) === 'already_decided',
  )
})

test('overlapping approved leave is refused, but overlapping pending is not', async () => {
  const s = await hire()
  const a = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-05-04', toOn: '2026-05-08',
    reason: 'first request for the week',
  })
  const b = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-05-06', toOn: '2026-05-10',
    reason: 'second request overlapping it',
  })
  await decideLeave(admin(), { requestId: a.id, approve: true })
  await assert.rejects(
    () => decideLeave(admin(), { requestId: b.id, approve: true }),
    saysDb(/hr_leave_requests_no_overlap|conflicting key/),
  )
  // Rejecting the overlapping one is fine, which is the point of the workflow.
  const rejected = await decideLeave(admin(), { requestId: b.id, approve: false })
  assert.equal(rejected.status, 'rejected')
})

test('leave cannot run past the day somebody leaves', async () => {
  const s = await hire()
  await endEmployment(admin(), { staffId: s.id, leftOn: '2026-06-30', reason: 'resigned in May' })
  await assert.rejects(
    () =>
      requestLeave(admin(), {
        staffId: s.id, leaveTypeId: casual, fromOn: '2026-07-01', toOn: '2026-07-02',
        reason: 'after the leaving date',
      }),
    saysDb(/past the leaving date/),
  )
})

test('a decided request cannot be flipped back without an audited reason', async () => {
  const s = await hire()
  const r = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-04-06', toOn: '2026-04-06',
    reason: 'one day at home',
  })
  await decideLeave(admin(), { requestId: r.id, approve: false })
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx
          .update(leaveRequests)
          .set({ status: 'approved' })
          .where(eq(leaveRequests.id, r.id)),
      ),
    saysDb(/cannot be reopened/),
  )
})

test('cancelling approved leave is audited and allowed', async () => {
  const s = await hire()
  const r = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-04-06', toOn: '2026-04-08',
    reason: 'family function at home',
  })
  await decideLeave(admin(), { requestId: r.id, approve: true })
  const cancelled = await cancelLeave(admin(), {
    requestId: r.id,
    reason: 'travel plans fell through',
  })
  assert.equal(cancelled.status, 'cancelled')

  const trail = await withTenant(inst, (tx) =>
    tx.select({ action: auditLog.action }).from(auditLog),
  )
  assert.ok(trail.some((t) => t.action === 'hr.leave_cancelled'))
})

test('balances count approved days only, and stop at the entitlement', async () => {
  const s = await hire()
  const r = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-04-06', toOn: '2026-04-10',
    reason: 'five days at home',
  })
  const pending = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-06-01', toOn: '2026-06-03',
    reason: 'not decided yet',
  })
  assert.ok(pending.id)
  await decideLeave(admin(), { requestId: r.id, approve: true })

  const b = (await leaveBalances(admin(), s.id, '2026')).find((x) => x.typeCode === 'cl')!
  assert.equal(b.takenDays, 5, 'pending requests do not count')
  assert.equal(b.remainingDays, 7)
})

test('an unlimited leave type reports remaining as null, not as zero', async () => {
  const s = await hire()
  const b = (await leaveBalances(admin(), s.id, '2026')).find((x) => x.typeCode === 'lwp')!
  assert.equal(b.annualDays, 0)
  assert.equal(b.remainingDays, null)
})

test('the pending queue shows what is waiting', async () => {
  const s = await hire()
  await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-04-06', toOn: '2026-04-06',
    reason: 'one day at home',
  })
  assert.equal((await listLeave(admin(), true)).length, 1)
  assert.equal((await listLeave(admin()))[0]!.days, 1)
})

// --- payroll ---------------------------------------------------------------

test('a payslip is generated from the components in force', async () => {
  const s = await hire()
  await paid(s.id)

  const run = await generatePayroll(admin(), { period: '2026-03' })
  assert.equal(run.generated, 1)
  const slip = run.payslips[0]!
  assert.equal(slip.grossPaise, 5_600_000)
  assert.equal(slip.deductionsPaise, 480_000)
  assert.equal(slip.netPaise, 5_120_000)
  assert.equal(slip.lines.length, 3)
})

test('a raise applies from its month and not before', async () => {
  const s = await hire()
  await paid(s.id)
  await setComponent(admin(), {
    staffId: s.id, code: 'basic', label: 'Basic', kind: 'earning',
    amount: '50000', effectiveFrom: '2026-08-01',
  })

  const july = await generatePayroll(admin(), { period: '2026-07', staffId: s.id })
  const august = await generatePayroll(admin(), { period: '2026-08', staffId: s.id })
  assert.equal(july.payslips[0]!.grossPaise, 5_600_000)
  assert.equal(august.payslips[0]!.grossPaise, 6_600_000)
})

test('unpaid leave reduces the pay, paid leave does not', async () => {
  const s = await hire()
  await paid(s.id)

  const lwp = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: unpaid, fromOn: '2026-04-06', toOn: '2026-04-08',
    reason: 'three days without pay',
  })
  await decideLeave(admin(), { requestId: lwp.id, approve: true })
  const cl = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-04-20', toOn: '2026-04-22',
    reason: 'three days of casual leave',
  })
  await decideLeave(admin(), { requestId: cl.id, approve: true })

  const run = await generatePayroll(admin(), { period: '2026-04' })
  const slip = run.payslips[0]!
  assert.equal(slip.unpaidLeaveDays, 3, 'only the unpaid type counts')
  assert.equal(slip.lossOfPayPaise, Math.round(5_600_000 / 30) * 3)
  assert.equal(slip.grossPaise, 5_600_000 - slip.lossOfPayPaise)
})

test('running payroll twice does not pay twice', async () => {
  const s = await hire()
  await paid(s.id)
  const first = await generatePayroll(admin(), { period: '2026-03' })
  const second = await generatePayroll(admin(), { period: '2026-03' })
  assert.equal(first.generated, 1)
  assert.equal(second.generated, 0)
  assert.equal(second.skipped, 1)
  assert.equal((await listPayslips(admin(), '2026-03')).length, 1)
})

test('somebody who left before the month is not paid for it', async () => {
  const s = await hire()
  await paid(s.id)
  await endEmployment(admin(), { staffId: s.id, leftOn: '2026-02-28', reason: 'resigned in Jan' })

  assert.equal((await generatePayroll(admin(), { period: '2026-02' })).generated, 1)
  assert.equal((await generatePayroll(admin(), { period: '2026-03' })).generated, 0)
})

test('somebody who joins mid-month is paid for that month', async () => {
  const s = await hire({ joinedOn: '2026-03-20' })
  await paid(s.id, '2026-03-20')
  assert.equal((await generatePayroll(admin(), { period: '2026-02' })).generated, 0)
  assert.equal((await generatePayroll(admin(), { period: '2026-03' })).generated, 1)
})

test('the payslip keeps its own snapshot when the pay later changes', async () => {
  const s = await hire()
  await paid(s.id)
  await generatePayroll(admin(), { period: '2026-03' })

  await setComponent(admin(), {
    staffId: s.id, code: 'basic', label: 'Basic', kind: 'earning',
    amount: '99000', effectiveFrom: '2026-04-01',
  })

  const [slip] = await listPayslips(admin(), '2026-03')
  assert.equal(slip!.grossPaise, 5_600_000, 'March did not move')
  assert.equal(slip!.lines.find((l) => l.code === 'basic')!.amountPaise, 4_000_000)
})

test('a payslip cannot be altered or deleted without an audited reason', async () => {
  const s = await hire()
  await paid(s.id)
  const run = await generatePayroll(admin(), { period: '2026-03' })
  const id = run.payslips[0]!.id

  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.update(payslips).set({ netPaise: 1 }).where(eq(payslips.id, id)),
      ),
    saysDb(/without an audited reason/),
  )
  await assert.rejects(
    () => withTenant(inst, (tx) => tx.delete(payslips).where(eq(payslips.id, id))),
    saysDb(/without an audited reason/),
  )
})

test('a staff member with no pay set gets a zero payslip rather than none', async () => {
  const s = await hire()
  const run = await generatePayroll(admin(), { period: '2026-03' })
  assert.equal(run.generated, 1)
  assert.equal(run.payslips[0]!.netPaise, 0)
  assert.equal(run.payslips[0]!.staffId, s.id)
})

// --- the staff member's own view -------------------------------------------

test('a lecturer sees their own record, balances and payslips', async () => {
  const s = await hire({ userId: ids.fac })
  await paid(s.id)
  await generatePayroll(admin(), { period: '2026-03' })

  const mine = await myEmployment(teacher())
  assert.equal(mine.onRecord, true)
  assert.equal(mine.staff!.employeeCode, 'E-001')
  assert.equal(mine.payslips.length, 1)
  assert.ok(mine.balances.some((b) => b.typeCode === 'cl'))
})

test('somebody with no staff record gets an honest empty answer', async () => {
  const mine = await myEmployment(teacher())
  assert.equal(mine.onRecord, false)
  assert.equal(mine.staff, null)
})

// --- tenancy ---------------------------------------------------------------

test('another institution sees none of this, and RLS not the query says so', async () => {
  const s = await hire()
  await paid(s.id)
  await generatePayroll(admin(), { period: '2026-03' })

  const seen = await withTenant(other, async (tx) => ({
    staff: await tx.select().from(staff),
    payslips: await tx.select().from(payslips),
    components: await tx.select().from(payComponents),
  }))
  assert.deepEqual([seen.staff.length, seen.payslips.length, seen.components.length], [0, 0, 0])
})

test('a session with no tenant set reads nothing rather than erroring', async () => {
  await hire()
  assert.equal((await db.select().from(staff)).length, 0)
})

test('an administrator of another institution cannot reach into this one', async () => {
  const s = await hire()
  await assert.rejects(
    () =>
      endEmployment(A({ institutionId: other }), {
        staffId: s.id,
        leftOn: '2026-06-30',
        reason: 'not mine to end',
      }),
    (e: unknown) => code(e) === 'no_such_staff',
  )
})
