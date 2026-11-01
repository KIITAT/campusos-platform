import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { trialBalance } from '@campusos/module-finance/api'
import {
  HrError, createLeaveType, createStaff, decideAdvance, decideEncashment, generatePayroll, paySalaries, payAdvance,
  releasePayslip, remit, reissuePayslip, requestAdvance, requestEncashment, setComponent, setPayrollSettings,
  setStatutoryIdentity, withholdSalary, type Actor,
} from './api'
import { payslipReissues, payslips } from './schema'

/** Reissuing a payslip as reverse-and-replace (P1-06c step 6). A fresh institution per test. */

let n = 0
const SLUG = 'hr-reissue-'
const code = (e: unknown) => (e as HrError).code

interface College { id: string; admin: Actor; principal: Actor; clerk: Actor; staffId: string }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Reissue College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Bursar' },
      { email: `pri@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Principal' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
    ])
    .returning({ id: users.id })
  const mk = (k: number, role: Actor['role']): Actor => ({ id: people[k]!.id, email: null, role, institutionId: id })
  const c: College = { id, admin: mk(0, 'institution_admin'), principal: mk(1, 'institution_admin'), clerk: mk(2, 'accounts_staff'), staffId: '' }
  const s = await createStaff(c.admin, { employeeCode: 'F-1', name: 'Dr Traveller', designation: 'Associate Professor', department: 'Physics', joinedOn: '2024-01-01' })
  c.staffId = s.id
  return c
}

after(async () => {
  await authDb.delete(institutions).where(sql`${institutions.slug} like ${SLUG + '%'}`)
})

const basic = (c: College, amount: string, from = '2024-01-01') =>
  setComponent(c.admin, { staffId: c.staffId, code: 'basic', label: 'Basic', kind: 'earning', amount, effectiveFrom: from })

const slipsOf = (c: College) => withTenant(c.id, (tx) => tx.select().from(payslips).where(eq(payslips.staffId, c.staffId)))
const slipFor = async (c: College, period: string) => (await slipsOf(c)).find((s) => s.period === period)!
const reissuesOf = (c: College) => withTenant(c.id, (tx) => tx.select().from(payslipReissues))
const books = async (c: College) => {
  const tb = await trialBalance(c.admin)
  return { bal: (acct: string) => tb.rows.find((r) => r.code === acct)?.balancePaise ?? 0, diff: tb.differencePaise }
}
const reason = 'basic revised for April'

async function refused(c: College, period: string, why: string) {
  const before = await slipFor(c, period)
  await assert.rejects(() => reissuePayslip(c.admin, { payslipId: before.id, reason }), (e) => code(e) === why)
  const after = await slipFor(c, period)
  assert.equal(after.id, before.id)
  assert.equal(after.netPaise, before.netPaise)
  assert.equal((await reissuesOf(c)).length, 0)
}

test('a reissue replaces the payslip, reverses its entry and keeps the old one', async () => {
  const c = await college()
  await basic(c, '50000')
  await generatePayroll(c.admin, { period: '2026-04' })
  const old = await slipFor(c, '2026-04-01')
  await basic(c, '60000', '2026-04-01')
  const done = await reissuePayslip(c.admin, { payslipId: old.id, reason })
  const now = await slipsOf(c)
  assert.equal(now.length, 1)
  assert.equal(now[0]!.netPaise, 6_000_000)
  assert.notEqual(now[0]!.id, old.id)
  const archive = await reissuesOf(c)
  assert.equal(archive.length, 1)
  assert.equal((archive[0]!.snapshot as { netPaise: number }).netPaise, 5_000_000)
  assert.equal(archive[0]!.replacementId, now[0]!.id)
  assert.equal(done.reissueId, archive[0]!.id)
  const reversed = await authDb.execute<{ n: number }>(sql`
    select count(*)::int as n from finance_journal_entries r
      join finance_journal_entries o on o.id = r.reversal_of
     where o.institution_id = ${c.id} and o.source_ref = ${'payslip:' + old.id}`)
  assert.equal(reversed.rows[0]!.n, 1)
  const { bal, diff } = await books(c)
  assert.equal(diff, 0)
  assert.equal(bal('2100'), 6_000_000)
  const paid = await paySalaries(c.principal, { period: '2026-04', paidOn: '2026-05-02' })
  assert.equal(paid.amountPaise, 6_000_000)
})

test('the replacement is booked to the month end', async () => {
  const c = await college()
  await basic(c, '50000')
  await generatePayroll(c.admin, { period: '2026-04' })
  await reissuePayslip(c.admin, { payslipId: (await slipFor(c, '2026-04-01')).id, reason })
  const fresh = await slipFor(c, '2026-04-01')
  const r = await authDb.execute<{ d: string }>(sql`
    select posting_date::text as d from finance_journal_entries where institution_id = ${c.id} and source_ref = ${'payslip:' + fresh.id}`)
  assert.equal(r.rows[0]!.d, '2026-04-30')
})

test('a reissue is refused once the month is paid', async () => {
  const c = await college()
  await basic(c, '50000')
  await generatePayroll(c.admin, { period: '2026-04' })
  await paySalaries(c.principal, { period: '2026-04', paidOn: '2026-05-02' })
  await refused(c, '2026-04-01', 'period_paid')
})

test('a reissue is refused with advance recoveries on the payslip', async () => {
  const c = await college()
  await basic(c, '50000')
  const adv = await requestAdvance(c.admin, { staffId: c.staffId, purpose: 'Medical emergency at home', amount: '25000' })
  await decideAdvance(c.principal, { advanceId: adv.id, approve: true, monthlyRecovery: '10000' })
  await payAdvance(c.admin, { advanceId: adv.id, paidOn: '2026-03-15', paidFrom: 'bank' })
  await generatePayroll(c.admin, { period: '2026-04' })
  await refused(c, '2026-04-01', 'reissue_has_recoveries')
})

test('a reissue is refused when a later payslip exists', async () => {
  const c = await college()
  await basic(c, '50000')
  await generatePayroll(c.admin, { period: '2026-04' })
  await generatePayroll(c.admin, { period: '2026-05' })
  await refused(c, '2026-04-01', 'reissue_not_latest')
})

test('a reissue is refused once the month has been remitted', async () => {
  const c = await college()
  await setPayrollSettings(c.admin, { prorationBasis: 'calendar', statutoryFrom: '2026-03', pfRegistered: true, esiRegistered: false })
  await setStatutoryIdentity(c.admin, { staffId: c.staffId, pfMember: true, uan: '100200300401' })
  await basic(c, '40000')
  await generatePayroll(c.admin, { period: '2026-04' })
  await remit(c.admin, { head: 'pf', period: '2026-04', amount: '100', paidOn: '2026-05-10', paidFrom: 'bank', challanRef: 'PF-1' })
  await refused(c, '2026-04-01', 'reissue_remitted')
})

test('a reissue is refused for a payslip held back and released', async () => {
  const c = await college()
  await basic(c, '50000')
  await withholdSalary(c.admin, { staffId: c.staffId, fromPeriod: '2026-04', reason: 'unexplained absence under inquiry' })
  await generatePayroll(c.admin, { period: '2026-04' })
  const held = await slipFor(c, '2026-04-01')
  await releasePayslip(c.admin, { payslipId: held.id, paidOn: '2026-05-02', paidFrom: 'bank', reason: 'inquiry closed, absence was approved leave' })
  await refused(c, '2026-04-01', 'reissue_released')
})

test('a failed replacement rolls the whole reissue back', async () => {
  const c = await college()
  await basic(c, '50000')
  await generatePayroll(c.admin, { period: '2026-04' })
  const old = await slipFor(c, '2026-04-01')
  const before = await books(c)
  // Left before the month began: the regeneration will not pick them up.
  await authDb.execute(sql`update hr_staff set left_on = '2026-03-31' where id = ${c.staffId}`)
  await assert.rejects(
    () => reissuePayslip(c.admin, { payslipId: old.id, reason }),
    (e) => e instanceof HrError && e.status === 409 && e.code === 'reissue_failed' && e.message === 'the replacement was not made',
  )
  const kept = await slipFor(c, '2026-04-01')
  assert.equal(kept.id, old.id)
  assert.equal(kept.netPaise, old.netPaise)
  const reversed = await authDb.execute<{ n: number }>(sql`
    select count(*)::int as n from finance_journal_entries where institution_id = ${c.id} and reversal_of is not null`)
  assert.equal(reversed.rows[0]!.n, 0)
  assert.equal((await reissuesOf(c)).length, 0)
  const after = await books(c)
  assert.equal(after.bal('2100'), before.bal('2100'))
  assert.equal(after.diff, 0)
})

test('a payslip still cannot be altered without an audited reason', async () => {
  const c = await college()
  await basic(c, '50000')
  await generatePayroll(c.admin, { period: '2026-04' })
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.update(payslips).set({ grossPaise: 1, netPaise: 1 }).where(eq(payslips.staffId, c.staffId))),
    (e) => /audited reason/.test(String((e as { cause?: Error }).cause?.message ?? e)),
  )
})

test('only the administrators may reissue', async () => {
  const c = await college()
  await basic(c, '50000')
  await generatePayroll(c.admin, { period: '2026-04' })
  const id = (await slipFor(c, '2026-04-01')).id
  await assert.rejects(
    () => reissuePayslip(c.clerk, { payslipId: id, reason }),
    (e) => e instanceof HrError && e.status === 403 && e.code === 'forbidden',
  )
})

async function waiting(pattern: string): Promise<number> {
  const r = await authDb.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike ${pattern}`,
  )
  return r.rows[0]!.n
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const settle = <T>(p: Promise<T>) =>
  p.then((value) => ({ ok: true as const, value, error: null as unknown }), (error: unknown) => ({ ok: false as const, value: null as T | null, error }))

test('a reissue and a payment racing for the month: payables end at zero either way', async () => {
  const c = await college()
  await basic(c, '50000')
  await generatePayroll(c.admin, { period: '2026-04' })
  const old = await slipFor(c, '2026-04-01')
  await basic(c, '60000', '2026-04-01')
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let holding!: () => void
  const locked = new Promise<void>((resolve) => (holding = resolve))
  const holder = authDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(1213354066, hashtext(${`${c.id}:2026-04-01`}::text))`)
    holding()
    await held
  })
  await locked
  const reissue = settle(reissuePayslip(c.admin, { payslipId: old.id, reason }))
  const payment = settle(paySalaries(c.principal, { period: '2026-04', paidOn: '2026-05-02' }))
  try {
    await until(async () => (await waiting('%pg_advisory_xact_lock(1213354066%')) >= 2)
  } finally {
    release()
    await holder
  }
  const [r, p] = await Promise.all([reissue, payment])
  assert.equal(p.ok, true, String(p.error))
  if (!r.ok) assert.equal(code(r.error), 'period_paid')
  const total = (await slipsOf(c)).reduce((t, s) => t + s.netPaise, 0)
  assert.equal(p.value!.amountPaise, total)
  const { bal, diff } = await books(c)
  assert.equal(bal('2100'), 0)
  assert.equal(diff, 0)
})

test('a leave encashment of the month stays linked to the new payslip', async () => {
  const c = await college()
  await basic(c, '31000')
  const el = await createLeaveType(c.admin, { code: 'el', name: 'Earned leave', annualDays: 15, encashable: true, encashmentComponents: ['basic'] })
  const req = await requestEncashment(c.admin, { staffId: c.staffId, leaveTypeId: el.id, year: 2026, days: 2, period: '2026-04', reason: 'two unused days sold back' })
  await decideEncashment(c.admin, { requestId: req.id, approve: true })
  await generatePayroll(c.admin, { period: '2026-04' })
  const old = await slipFor(c, '2026-04-01')
  const linked = async () =>
    (await authDb.execute<{ p: string | null }>(sql`select payslip_id as p from hr_leave_encashments where id = ${req.id}`)).rows[0]!.p
  assert.equal(await linked(), old.id)
  await reissuePayslip(c.admin, { payslipId: old.id, reason })
  const fresh = await slipFor(c, '2026-04-01')
  assert.equal(await linked(), fresh.id)
})
