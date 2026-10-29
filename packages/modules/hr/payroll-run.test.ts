import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, db, institutions, users, withTenant } from '@campusos/db'
import {
  HrError, assignStructure, createLeaveType, createStaff, createStructure, decideEncashment,
  generatePayroll, getPayrollSettings, listArrears, listRuns, requestEncashment, setComponent,
  setPayrollSettings, type Actor,
} from './api'
import { payrollArrears, payrollSettings } from './schema'

/**
 * A payroll run as a whole (P0-08): one person cannot stop it, part months
 * are paid by the day, and a payment cannot slip in beside it. A fresh
 * institution per test, as in books.test.ts: the journal is append-only.
 */

let n = 0
const SLUG = 'hr-run-'

interface College { id: string; admin: Actor; clerk: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Run College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: i!.id, role: 'accounts_staff', name: 'Clerk' },
    ])
    .returning({ id: users.id })
  return {
    id: i!.id,
    admin: { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: i!.id },
    clerk: { id: people[1]!.id, email: `clerk@${tag}.test`, role: 'accounts_staff', institutionId: i!.id },
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const hire = (c: College, over: Record<string, unknown> = {}) =>
  createStaff(c.admin, { employeeCode: 'E-1', name: 'A Lecturer', designation: 'Lecturer', joinedOn: '2026-01-01', ...over })

/** 56,000 gross with 4,800 provident fund, from a date. */
async function salaried(c: College, staffId: string, from = '2026-01-01') {
  for (const [code, kind, amount] of [['basic', 'earning', '40000'], ['hra', 'earning', '16000'], ['pf', 'deduction', '4800']] as const) {
    await setComponent(c.admin, { staffId, code, label: code, kind, amount, effectiveFrom: from })
  }
}

/** A person with a provident fund deduction and no pay at all. */
async function deductionOnly(c: College) {
  const z = await hire(c, { employeeCode: 'Z-1', name: 'No Pay' })
  await setComponent(c.admin, { staffId: z.id, code: 'pf', label: 'pf', kind: 'deduction', amount: '4800', effectiveFrom: '2026-01-01' })
  return z
}

const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}

test('hr 0011 refuses to upgrade over a payslip with a negative net (ACC-14)', async () => {
  const c = await college()
  const s = await hire(c)
  const file = readFileSync(new URL('./migrations/0011_payroll_runs_whole.sql', import.meta.url), 'utf8')
  const preflight = file.split('--> statement-breakpoint')[0]!
  await assert.rejects(
    () =>
      authDb.transaction(async (tx) => {
        await tx.execute(sql`alter table hr_payslips drop constraint hr_payslips_net_not_negative`)
        await tx.execute(sql`insert into hr_payslips (institution_id, staff_id, period, gross_paise, deductions_paise, net_paise, lines)
          values (${c.id}, ${s.id}, '2026-03-01', 0, 100, -100, '[]'::jsonb)`)
        await tx.execute(sql.raw(preflight))
      }),
    saysDb(/hr 0011: 1 payslip\(s\) have a negative net/),
  )
})

test('one person with deductions and no pay does not stop the run, and is reported with their arrears (ACC-14)', async () => {
  const c = await college()
  const a = await hire(c, { employeeCode: 'A-1' })
  await salaried(c, a.id)
  const z = await deductionOnly(c)
  const run = await generatePayroll(c.admin, { period: '2026-03' })
  assert.equal(run.generated, 2)
  assert.deepEqual(run.failed, [])
  assert.deepEqual(run.arrears, [{ staffId: z.id, employeeCode: 'Z-1', staffName: 'No Pay', arrearsPaise: 480_000 }])
  const zs = run.payslips.find((p) => p.staffId === z.id)!
  assert.equal(zs.grossPaise, 0)
  assert.equal(zs.deductionsPaise, 0)
  assert.equal(zs.netPaise, 0)
  const pf = (zs.lines as { code: string; appliedPaise: number; amountPaise: number }[]).find((l) => l.code === 'pf')!
  assert.equal(pf.appliedPaise, 0)
  assert.equal(pf.amountPaise, 480_000)
  assert.equal(run.payslips.find((p) => p.staffId === a.id)!.netPaise, 5_120_000)
  const owed = await listArrears(c.admin, '2026-03')
  assert.equal(owed.length, 1)
  assert.equal(owed[0]!.arrearsPaise, 480_000)
  assert.equal(owed[0]!.payslipId, zs.id)
  assert.deepEqual((await listRuns(c.admin))[0]!.failures, [])
})

test('one person whose pay cannot be worked out is rolled back alone and reported (ACC-14)', async () => {
  const c = await college()
  const a = await hire(c, { employeeCode: 'A-1' })
  await salaried(c, a.id)
  const y = await hire(c, { employeeCode: 'Y-1', name: 'Broken Structure' })
  const st = await createStructure(c.admin, {
    code: 'STD', name: 'Standard', lines: [{ code: 'basic', label: 'Basic', kind: 'earning', calc: 'base' }],
  })
  await assignStructure(c.admin, { staffId: y.id, structureId: st.id, base: '30000', effectiveFrom: '2026-01-01' })
  await authDb.execute(sql`insert into hr_salary_structure_lines (institution_id, structure_id, seq, code, label, kind, calc, percent_bp, "of")
    values (${c.id}, ${st.id}, 2, 'da', 'Dearness allowance', 'earning', 'percent_of', 1000, 'nowhere')`)
  const run = await generatePayroll(c.admin, { period: '2026-03' })
  assert.equal(run.generated, 1)
  assert.equal(run.payslips[0]!.staffId, a.id)
  assert.equal(run.failed.length, 1)
  const f = run.failed[0]!
  assert.equal(f.staffId, y.id)
  assert.equal(f.employeeCode, 'Y-1')
  assert.equal(f.staffName, 'Broken Structure')
  assert.match(f.message, /circle, or to nothing: da/)
  assert.deepEqual((await listRuns(c.admin))[0]!.failures, [{ staffId: y.id, employeeCode: 'Y-1', message: f.message }])
  const r = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from hr_payslips where staff_id = ${y.id}`)
  assert.equal(r.rows[0]!.n, 0)
})

test('the basis is calendar until set, and the 30- and 26-day bases pay a 20 March joiner by the day (ACC-15)', async () => {
  const c = await college()
  assert.deepEqual(await getPayrollSettings(c.admin), { prorationBasis: 'calendar' })
  assert.deepEqual(await setPayrollSettings(c.admin, { prorationBasis: 'days_30' }), { prorationBasis: 'days_30' })
  const j = await hire(c, { employeeCode: 'J-1', joinedOn: '2026-03-20' })
  await salaried(c, j.id, '2026-03-20')
  const rj = await generatePayroll(c.admin, { period: '2026-03', staffId: j.id })
  assert.equal(rj.payslips[0]!.grossPaise, 2_240_000)
  await setPayrollSettings(c.admin, { prorationBasis: 'days_26' })
  const k = await hire(c, { employeeCode: 'K-1', joinedOn: '2026-03-20' })
  await salaried(c, k.id, '2026-03-20')
  const rk = await generatePayroll(c.admin, { period: '2026-03', staffId: k.id })
  assert.equal(rk.payslips[0]!.grossPaise, 2_153_846)
  assert.equal(rk.payslips[0]!.unpaidLeaveDays, 0)
})

test('only an administrator sets the basis, and the change is audited (ACC-15)', async () => {
  const c = await college()
  await assert.rejects(
    () => setPayrollSettings(c.clerk, { prorationBasis: 'days_26' }),
    (e) => e instanceof HrError && e.status === 403,
  )
  await setPayrollSettings(c.admin, { prorationBasis: 'days_26' })
  const rows = await authDb
    .select({ detail: auditLog.detail, reason: auditLog.reason })
    .from(auditLog)
    .where(and(eq(auditLog.institutionId, c.id), eq(auditLog.action, 'hr.payroll_basis_set')))
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]!.detail, { from: 'calendar', to: 'days_26' })
  assert.equal(rows[0]!.reason, 'part months paid on the days_26 basis')
  await assert.rejects(
    () => setPayrollSettings(c.admin, { prorationBasis: 'days_31' }),
    (e) => (e as Error).name === 'ZodError',
  )
})

test('leave sold back is valued from the salary structure too (ACC-26)', async () => {
  const c = await college()
  const s = await hire(c, { joinedOn: '2024-01-01' })
  const st = await createStructure(c.admin, {
    code: 'STD', name: 'Standard',
    lines: [
      { code: 'basic', label: 'Basic', kind: 'earning', calc: 'base' },
      { code: 'hra', label: 'HRA', kind: 'earning', calc: 'fixed', amountPaise: 1_200_000 },
    ],
  })
  await assignStructure(c.admin, { staffId: s.id, structureId: st.id, base: '31000', effectiveFrom: '2024-01-01' })
  const el = await createLeaveType(c.admin, {
    code: 'el', name: 'Earned leave', annualDays: 15, encashable: true, encashmentComponents: ['basic'],
  })
  const req = await requestEncashment(c.admin, {
    staffId: s.id, leaveTypeId: el.id, year: 2026, days: 5, period: '2026-10', reason: 'five unused days sold back',
  })
  const done = await decideEncashment(c.admin, { requestId: req.id, approve: true })
  assert.equal(done.amountPaise, 500_000)
})

test('arrears and the basis belong to one institution (RLS)', async () => {
  const x = await college()
  const w = await college()
  await setPayrollSettings(x.admin, { prorationBasis: 'days_26' })
  await deductionOnly(x)
  await generatePayroll(x.admin, { period: '2026-03' })
  const seen = (id: string) =>
    withTenant(id, async (tx) => [
      (await tx.select().from(payrollSettings)).length,
      (await tx.select().from(payrollArrears)).length,
    ])
  assert.deepEqual(await seen(x.id), [1, 1])
  assert.deepEqual(await seen(w.id), [0, 0])
  assert.equal((await db.select().from(payrollArrears)).length, 0)
  assert.equal((await db.select().from(payrollSettings)).length, 0)
})
