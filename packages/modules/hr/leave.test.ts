import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import {
  HrError,
  allocateManually,
  allocateYear,
  assignPolicy,
  createLeavePolicy,
  createLeaveType,
  createStaff,
  decideCompOff,
  decideEncashment,
  decideLeave,
  generatePayroll,
  leaveBalances,
  listAllocations,
  listEncashments,
  requestCompOff,
  requestEncashment,
  requestLeave,
  setComponent,
  type Actor,
} from './api'
import {
  leaveAllocations,
  leaveEncashments,
  leavePolicies,
  leavePolicyAssignments,
  leavePolicyLines,
  compOffRequests,
  leaveRequests,
  leaveTypes,
  payComponents,
  payslips,
  staff,
} from './schema'

/**
 * Leave as policy: entitlements by kind of employee, carry-forward, days
 * earned by working a holiday, days sold back -- and the refusal to approve
 * leave somebody does not have.
 */

const SLUG = 'hr-leave'
const OTHER = 'hr-leave-other'
let inst: string
let other: string
const ids = { adm: '', clerk: '', fac: '', otherAdm: '' }
let casual = ''
let earned = ''
let annual = ''

const A = (over: Partial<Actor>): Actor => ({
  id: ids.adm,
  email: 'adm@hrleave.test',
  role: 'institution_admin',
  institutionId: inst,
  ...over,
})
const admin = () => A({})
const clerk = () => A({ id: ids.clerk, email: 'clerk@hrleave.test', role: 'accounts_staff' })
const teacher = () => A({ id: ids.fac, email: 'fac@hrleave.test', role: 'faculty' })
const outsider = () => A({ id: ids.otherAdm, institutionId: other })
const code = (e: unknown) => (e as HrError).code

const hire = (over: Record<string, unknown> = {}) =>
  createStaff(admin(), {
    employeeCode: 'E-001',
    name: 'A Lecturer',
    designation: 'Assistant Professor',
    joinedOn: '2024-01-01',
    ...over,
  })

const balance = async (staffId: string, typeCode: string, year = '2026') =>
  (await leaveBalances(admin(), staffId, year)).find((b) => b.typeCode === typeCode)!

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Leave College', allowedEmailDomains: ['hrleave.test'] },
      { slug: OTHER, name: 'Other', allowedEmailDomains: ['hrleaveother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@hrleave.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'clerk@hrleave.test', institutionId: inst, role: 'accounts_staff', name: 'Clerk' },
      { email: 'fac@hrleave.test', institutionId: inst, role: 'faculty', name: 'Fac' },
      { email: 'adm@hrleaveother.test', institutionId: other, role: 'institution_admin', name: 'O' },
    ])
    .returning({ id: users.id })
  ids.adm = people[0]!.id
  ids.clerk = people[1]!.id
  ids.fac = people[2]!.id
  ids.otherAdm = people[3]!.id
})

beforeEach(async () => {
  for (const t of [inst, other]) {
    await withTenant(t, async (tx) => {
      await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
      await tx.delete(leaveEncashments)
      await tx.delete(compOffRequests)
      await tx.delete(leaveAllocations)
      await tx.delete(leavePolicyAssignments)
      await tx.delete(leavePolicyLines)
      await tx.delete(leavePolicies)
      await tx.delete(payslips)
      await tx.delete(payComponents)
      await tx.delete(leaveRequests)
      await tx.delete(staff)
      await tx.delete(leaveTypes)
    })
  }
  casual = (await createLeaveType(admin(), { code: 'cl', name: 'Casual', annualDays: 12 })).id
  annual = (
    await createLeaveType(admin(), {
      code: 'el',
      name: 'Earned leave',
      annualDays: 15,
      maxCarryForward: 10,
      encashable: true,
      encashmentComponents: ['basic'],
    })
  ).id
  earned = (
    await createLeaveType(admin(), {
      code: 'co',
      name: 'Compensatory off',
      compensatory: true,
      compOffValidityDays: 60,
    })
  ).id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

// --- the refusal -----------------------------------------------------------

test('leave nobody has is not granted by approving it', async () => {
  const s = await hire()
  const ok = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-03-02', toOn: '2026-03-11',
    reason: 'ten days away',
  })
  await decideLeave(admin(), { requestId: ok.id, approve: true })

  const tooMuch = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: casual, fromOn: '2026-05-04', toOn: '2026-05-06',
    reason: 'three more days',
  })
  await assert.rejects(
    () => decideLeave(admin(), { requestId: tooMuch.id, approve: true }),
    (e: unknown) => code(e) === 'insufficient_balance',
  )
  // Rejecting it is still fine: the check guards spending, not deciding.
  const r = await decideLeave(admin(), { requestId: tooMuch.id, approve: false })
  assert.equal(r.status, 'rejected')
})

test('a type that allows overdrawing lets it happen and shows it', async () => {
  const flexible = (
    await createLeaveType(admin(), { code: 'ml', name: 'Medical', annualDays: 2, allowNegative: true })
  ).id
  const s = await hire()
  const r = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: flexible, fromOn: '2026-03-02', toOn: '2026-03-05',
    reason: 'four days in hospital',
  })
  await decideLeave(admin(), { requestId: r.id, approve: true })
  assert.equal((await balance(s.id, 'ml')).remainingDays, -2)
})

// --- policies --------------------------------------------------------------

test('a policy replaces the type default, rather than adding to it', async () => {
  const policy = await createLeavePolicy(admin(), {
    code: 'contract', name: 'Contract staff',
    lines: [{ leaveTypeId: casual, annualDays: 8 }],
  })
  const s = await hire()
  const untouched = await hire({ employeeCode: 'E-002', name: 'Nobody’s policy' })
  await assignPolicy(admin(), { staffId: s.id, policyId: policy.id, effectiveFrom: '2024-01-01' })

  const run = await allocateYear(admin(), { year: 2026 })
  assert.equal(run.allocated, 1)
  assert.equal(run.unassigned, 1)

  const cl = await balance(s.id, 'cl')
  assert.equal(cl.annualDays, 8, 'eight from the policy, not eight plus twelve')
  assert.equal(cl.managed, true)
  // Somebody on no policy keeps the type's default.
  assert.equal((await balance(untouched.id, 'cl')).annualDays, 12)
})

test('allocating the year twice allocates once', async () => {
  const policy = await createLeavePolicy(admin(), {
    code: 'teaching', name: 'Teaching', lines: [{ leaveTypeId: casual, annualDays: 10 }],
  })
  const s = await hire()
  await assignPolicy(admin(), { staffId: s.id, policyId: policy.id, effectiveFrom: '2024-01-01' })
  await allocateYear(admin(), { year: 2026 })
  const again = await allocateYear(admin(), { year: 2026 })
  assert.equal(again.allocated, 0)
  assert.equal((await balance(s.id, 'cl')).annualDays, 10)
})

test('a mid-year joiner gets the months left, only when the policy says so', async () => {
  const pro = await createLeavePolicy(admin(), {
    code: 'pro', name: 'Prorated', prorateJoiners: true,
    lines: [{ leaveTypeId: casual, annualDays: 12 }],
  })
  const whole = await createLeavePolicy(admin(), {
    code: 'whole', name: 'Whole year', lines: [{ leaveTypeId: casual, annualDays: 12 }],
  })
  const july = await hire({ employeeCode: 'J-1', joinedOn: '2026-07-15' })
  const july2 = await hire({ employeeCode: 'J-2', joinedOn: '2026-07-15' })
  await assignPolicy(admin(), { staffId: july.id, policyId: pro.id, effectiveFrom: '2026-07-15' })
  await assignPolicy(admin(), { staffId: july2.id, policyId: whole.id, effectiveFrom: '2026-07-15' })
  await allocateYear(admin(), { year: 2026 })

  assert.equal((await balance(july.id, 'cl')).annualDays, 6, 'July to December is six months')
  assert.equal((await balance(july2.id, 'cl')).annualDays, 12)
})

test('a new policy supersedes the old one from its date, never overlapping', async () => {
  const a = await createLeavePolicy(admin(), {
    code: 'a', name: 'A', lines: [{ leaveTypeId: casual, annualDays: 8 }],
  })
  const b = await createLeavePolicy(admin(), {
    code: 'b', name: 'B', lines: [{ leaveTypeId: casual, annualDays: 14 }],
  })
  const s = await hire()
  await assignPolicy(admin(), { staffId: s.id, policyId: a.id, effectiveFrom: '2024-01-01' })
  await assignPolicy(admin(), { staffId: s.id, policyId: b.id, effectiveFrom: '2026-01-01' })

  await allocateYear(admin(), { year: 2025 })
  await allocateYear(admin(), { year: 2026 })
  assert.equal((await balance(s.id, 'cl', '2025')).annualDays, 8)
  assert.equal((await balance(s.id, 'cl', '2026')).annualDays, 14)
})

test('unused days carry, up to the type’s limit, and only where it allows', async () => {
  const s = await hire({ joinedOn: '2024-01-01' })
  // 15 earned leave in 2025, 2 taken: 13 left, 10 may carry. Casual carries none.
  const r = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: annual, fromOn: '2025-06-02', toOn: '2025-06-03',
    reason: 'two days in June',
  })
  await decideLeave(admin(), { requestId: r.id, approve: true })

  const run = await allocateYear(admin(), { year: 2026 })
  assert.equal(run.carried, 1)

  const el = await balance(s.id, 'el')
  assert.equal(el.annualDays, 25, 'the type default of 15, and 10 carried on top')
  assert.equal(el.managed, false, 'carrying does not replace the default')
  assert.equal((await balance(s.id, 'cl')).annualDays, 12)

  const rows = await listAllocations(admin(), s.id, '2026')
  assert.equal(rows[0]!.source, 'carry_forward')
  assert.equal(rows[0]!.days, 10)
})

test('a manual allocation says why', async () => {
  const s = await hire()
  await assert.rejects(() =>
    allocateManually(admin(), {
      staffId: s.id, leaveTypeId: casual, year: 2026, days: 3, reason: 'x',
    }),
  )
  await allocateManually(admin(), {
    staffId: s.id, leaveTypeId: casual, year: 2026, days: 3,
    reason: 'settlement agreed with the union',
  })
  assert.equal((await balance(s.id, 'cl')).annualDays, 3, 'a manual block is a base, like a policy')
})

// --- compensatory ----------------------------------------------------------

test('a worked holiday becomes a day off only once approved, and lapses', async () => {
  const s = await hire()
  assert.equal((await balance(s.id, 'co')).remainingDays, 0, 'earned leave starts at nothing')

  const claim = await requestCompOff(admin(), {
    staffId: s.id, leaveTypeId: earned, workedOn: '2026-01-26',
    reason: 'invigilated on Republic Day',
  })
  assert.equal((await balance(s.id, 'co')).remainingDays, 0, 'a claim is not leave')

  await decideCompOff(admin(), { requestId: claim.id, approve: true })
  const now = (await leaveBalances(admin(), s.id, '2026')).find((b) => b.typeCode === 'co')!
  // Sixty days' validity from 26 January: gone by today (September).
  assert.equal(now.remainingDays, 0)

  await withTenant(inst, async (tx) => {
    const [row] = await tx.select().from(leaveAllocations)
    assert.equal(row!.expiresOn, '2026-03-27')
    assert.equal(row!.source, 'compensatory')
  })
})

test('an unexpired earned day can be taken, and cannot be taken twice', async () => {
  const s = await hire()
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const claim = await requestCompOff(admin(), {
    staffId: s.id, leaveTypeId: earned, workedOn: yesterday, reason: 'open day on a Sunday',
  })
  await decideCompOff(admin(), { requestId: claim.id, approve: true })
  const y = yesterday.slice(0, 4)
  assert.equal((await balance(s.id, 'co', y)).remainingDays, 1)

  await assert.rejects(
    () =>
      requestCompOff(admin(), {
        staffId: s.id, leaveTypeId: earned, workedOn: yesterday, reason: 'the same Sunday again',
      }),
    (e: unknown) => code(e) === 'already_claimed',
  )
})

test('only compensatory types are earned, and not in advance', async () => {
  const s = await hire()
  await assert.rejects(
    () =>
      requestCompOff(admin(), {
        staffId: s.id, leaveTypeId: casual, workedOn: '2026-01-26', reason: 'wrong type',
      }),
    (e: unknown) => code(e) === 'not_compensatory',
  )
  await assert.rejects(
    () =>
      requestCompOff(admin(), {
        staffId: s.id, leaveTypeId: earned, workedOn: '2099-01-01', reason: 'future work',
      }),
    (e: unknown) => code(e) === 'bad_dates',
  )
})

test('a lecturer claims their own day, and nobody else’s', async () => {
  const mine = await hire({ userId: ids.fac })
  const theirs = await hire({ employeeCode: 'E-002', name: 'Somebody else' })
  const claim = await requestCompOff(teacher(), {
    staffId: mine.id, leaveTypeId: earned, workedOn: '2026-01-26', reason: 'my own Sunday',
  })
  assert.ok(claim.id)
  await assert.rejects(
    () =>
      requestCompOff(teacher(), {
        staffId: theirs.id, leaveTypeId: earned, workedOn: '2026-01-26', reason: 'not mine',
      }),
    (e: unknown) => code(e) === 'forbidden',
  )
  // And nobody approves their own claim.
  await assert.rejects(
    () => decideCompOff(teacher(), { requestId: claim.id, approve: true }),
    (e: unknown) => code(e) === 'forbidden',
  )
})

// --- encashment ------------------------------------------------------------

async function paid(staffId: string) {
  await setComponent(admin(), {
    staffId, code: 'basic', label: 'Basic', kind: 'earning', amount: '31000', effectiveFrom: '2024-01-01',
  })
  await setComponent(admin(), {
    staffId, code: 'hra', label: 'HRA', kind: 'earning', amount: '12000', effectiveFrom: '2024-01-01',
  })
}

test('selling days back pays a day of the named components, on the payslip', async () => {
  const s = await hire()
  await paid(s.id)
  const req = await requestEncashment(admin(), {
    staffId: s.id, leaveTypeId: annual, year: 2026, days: 5, period: '2026-10',
    reason: 'five unused days sold back',
  })
  const ok = await decideEncashment(admin(), { requestId: req.id, approve: true })
  // Basic only: 31000 over October's 31 days is 1000 a day. HRA is not the basis.
  assert.equal(ok.amountPaise, 5 * 100_000)
  assert.equal((await balance(s.id, 'el')).remainingDays, 10)

  const run = await generatePayroll(admin(), { period: '2026-10' })
  const slip = run.payslips[0]!
  assert.equal(slip.grossPaise, 4_300_000 + 500_000)
  assert.ok(slip.lines.some((l) => l.label === 'Leave encashment, 5 days'))

  const [row] = await listEncashments(admin())
  assert.equal(row!.paid, true)
})

test('unpaid leave shrinks the salary, not the days sold back', async () => {
  const lwp = (await createLeaveType(admin(), { code: 'lwp', name: 'Without pay', paid: false })).id
  const s = await hire()
  await paid(s.id)
  const off = await requestLeave(admin(), {
    staffId: s.id, leaveTypeId: lwp, fromOn: '2026-10-05', toOn: '2026-10-07', reason: 'three unpaid days',
  })
  await decideLeave(admin(), { requestId: off.id, approve: true })
  const req = await requestEncashment(admin(), {
    staffId: s.id, leaveTypeId: annual, year: 2026, days: 2, period: '2026-10', reason: 'two days sold back',
  })
  await decideEncashment(admin(), { requestId: req.id, approve: true })

  const slip = (await generatePayroll(admin(), { period: '2026-10' })).payslips[0]!
  const enc = slip.lines.find((l) => l.label.startsWith('Leave encashment'))!
  assert.equal(enc.appliedPaise, 200_000, 'untouched by loss of pay')
  assert.ok(slip.lossOfPayPaise > 0)
})

test('nobody sells more than they have, or a type that cannot be sold', async () => {
  const s = await hire()
  await paid(s.id)
  await assert.rejects(
    () =>
      requestEncashment(admin(), {
        staffId: s.id, leaveTypeId: annual, year: 2026, days: 16, period: '2026-10', reason: 'more than 15',
      }),
    (e: unknown) => code(e) === 'insufficient_balance',
  )
  await assert.rejects(
    () =>
      requestEncashment(admin(), {
        staffId: s.id, leaveTypeId: casual, year: 2026, days: 1, period: '2026-10', reason: 'casual leave',
      }),
    (e: unknown) => code(e) === 'not_encashable',
  )
})

test('an encashment for a month payroll has already run for is refused', async () => {
  const s = await hire()
  await paid(s.id)
  await generatePayroll(admin(), { period: '2026-10' })
  const req = await requestEncashment(admin(), {
    staffId: s.id, leaveTypeId: annual, year: 2026, days: 1, period: '2026-10', reason: 'too late for October',
  })
  await assert.rejects(
    () => decideEncashment(admin(), { requestId: req.id, approve: true }),
    (e: unknown) => code(e) === 'payroll_run',
  )
})

test('a paid encashment does not quietly change afterwards', async () => {
  const s = await hire()
  await paid(s.id)
  const req = await requestEncashment(admin(), {
    staffId: s.id, leaveTypeId: annual, year: 2026, days: 1, period: '2026-10', reason: 'one day sold back',
  })
  await decideEncashment(admin(), { requestId: req.id, approve: true })
  await generatePayroll(admin(), { period: '2026-10' })
  await assert.rejects(() =>
    withTenant(inst, (tx) =>
      tx.update(leaveEncashments).set({ days: 9 }).where(eq(leaveEncashments.id, req.id)),
    ),
  )
})

test('an encashable type has to say what a day is worth', async () => {
  await assert.rejects(() =>
    createLeaveType(admin(), { code: 'x', name: 'Nothing named', encashable: true }),
  )
})

test('the clerk does not approve payouts', async () => {
  const s = await hire()
  await paid(s.id)
  const req = await requestEncashment(admin(), {
    staffId: s.id, leaveTypeId: annual, year: 2026, days: 1, period: '2026-10', reason: 'one day sold back',
  })
  await assert.rejects(
    () => decideEncashment(clerk(), { requestId: req.id, approve: true }),
    (e: unknown) => code(e) === 'forbidden',
  )
})

test('one college’s policies are nobody else’s', async () => {
  await createLeavePolicy(admin(), {
    code: 'teaching', name: 'Teaching', lines: [{ leaveTypeId: casual, annualDays: 10 }],
  })
  const { listLeavePolicies } = await import('./api')
  assert.equal((await listLeavePolicies(outsider())).length, 0)
})
