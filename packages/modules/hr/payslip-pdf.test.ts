import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { printedText } from '@campusos/module-framework/pdf'
import { plainPaise } from '@campusos/money'
import { HrError, createStaff, generatePayroll, payslipDocument, setComponent, setPayrollSettings, setStatutoryIdentity, type Actor } from './api'
import { payslipReissues, payslips } from './schema'

/** The payslip PDF (P1-06c step 4). */

let n = 0
const SLUG = 'hr-slip-pdf-'

interface College { id: string; admin: Actor; clerk: Actor; faculty: Actor; other: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Payslip College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: i!.id, role: 'accounts_staff', name: 'Clerk' },
      { email: `fac@${tag}.test`, institutionId: i!.id, role: 'faculty', name: 'Fac' },
      { email: `oth@${tag}.test`, institutionId: i!.id, role: 'faculty', name: 'Oth' },
    ])
    .returning({ id: users.id })
  const mk = (k: number, role: Actor['role'], t: string): Actor => ({ id: people[k]!.id, email: `${t}@${tag}.test`, role, institutionId: i!.id })
  return {
    id: i!.id,
    admin: mk(0, 'institution_admin', 'adm'),
    clerk: mk(1, 'accounts_staff', 'clerk'),
    faculty: mk(2, 'faculty', 'fac'),
    other: mk(3, 'faculty', 'oth'),
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const comp = (c: College, staffId: string, code: string, label: string, kind: 'earning' | 'deduction', amount: string, wageClass: 'wage' | 'excluded' | 'outside' = 'wage') =>
  setComponent(c.admin, { staffId, code, label, kind, amount, effectiveFrom: '2026-01-01', wageClass })

async function setup(name = 'Ravi Kumar', statutory = true) {
  const c = await college()
  const mine = await createStaff(c.admin, { employeeCode: 'A-1', name, designation: 'Lecturer', department: 'Physics', joinedOn: '2026-01-01', userId: c.faculty.id })
  const theirs = await createStaff(c.admin, { employeeCode: 'B-1', name: 'Sita Rao', designation: 'Lecturer', joinedOn: '2026-01-01', userId: c.other.id })
  await setPayrollSettings(c.admin, { prorationBasis: 'calendar', statutoryFrom: statutory ? '2026-03' : '2099-01', pfRegistered: true, esiRegistered: false })
  for (const p of [mine, theirs]) {
    await setStatutoryIdentity(c.admin, { staffId: p.id, pfMember: true, uan: '100200300401', bankAccount: '123456789012', bankIfsc: 'HDFC0001234' })
    await comp(c, p.id, 'basic', 'Basic', 'earning', '40000')
    await comp(c, p.id, 'hra', 'House rent', 'earning', '16000', 'excluded')
    await comp(c, p.id, 'welfare', 'Staff welfare', 'deduction', '500')
  }
  const run = await generatePayroll(c.admin, { period: '2026-04' })
  assert.deepEqual(run.failed, [])
  const slipOf = async (staffId: string) =>
    withTenant(c.id, async (tx) => (await tx.select().from(payslips).where(and(eq(payslips.staffId, staffId), eq(payslips.period, '2026-04-01'))))[0]!)
  return { c, mine, theirs, slipOf }
}

const text = async (bytes: Uint8Array) => (await printedText(bytes)).join('|')

test('a payslip PDF carries the pay, the deductions and the employer block', async () => {
  const { c, mine, slipOf } = await setup()
  const slip = await slipOf(mine.id)
  const d = await payslipDocument(c.admin, slip.id)
  assert.equal(new TextDecoder().decode(d.bytes.slice(0, 5)), '%PDF-')
  assert.equal(d.name, 'payslip-A-1-2026-04.pdf')
  const t = await text(d.bytes)
  for (const s of ['Ravi Kumar', 'Payslip', '2026-04', 'Provident fund', 'Staff welfare', plainPaise(slip.netPaise), 'XXXX9012', 'Employer contributions (not deducted from pay)']) {
    assert.ok(t.includes(s), `${s} in ${t}`)
  }
  assert.ok(!t.includes('123456789012'), 'the full account number is never printed')
})

test('a Devanagari name prints', async () => {
  const { c, mine, slipOf } = await setup('रवि कुमार')
  const d = await payslipDocument(c.admin, (await slipOf(mine.id)).id)
  assert.ok((await text(d.bytes)).includes('रवि कुमार'))
})

test('staff fetch their own payslip, the office fetches anyone', async () => {
  const { c, mine, theirs, slipOf } = await setup()
  const own = await slipOf(mine.id)
  const colleague = await slipOf(theirs.id)
  assert.ok((await payslipDocument(c.faculty, own.id)).bytes.length > 0)
  await assert.rejects(() => payslipDocument(c.faculty, colleague.id), (e) => e instanceof HrError && e.status === 404 && e.code === 'no_such_payslip')
  assert.ok((await payslipDocument(c.clerk, colleague.id)).bytes.length > 0)
})

test('a payslip without a statutory record has no employer block', async () => {
  const { c, mine, slipOf } = await setup('Ravi Kumar', false)
  const slip = await slipOf(mine.id)
  assert.equal(slip.statutory, null)
  assert.ok(!(await text((await payslipDocument(c.admin, slip.id)).bytes)).includes('Employer contributions'))
})

test('a reissued payslip says so', async () => {
  const { c, mine, slipOf } = await setup()
  const slip = await slipOf(mine.id)
  await withTenant(c.id, (tx) =>
    tx.insert(payslipReissues).values({
      institutionId: c.id, staffId: mine.id, period: '2026-04-01', originalId: slip.id,
      snapshot: { generatedAt: '2026-04-30T10:00:00.000Z' }, reason: 'basic corrected', replacementId: slip.id,
    }),
  )
  const t = await text((await payslipDocument(c.admin, slip.id)).bytes)
  assert.ok(t.includes('Reissued on'), t)
  assert.ok(t.includes('basic corrected'), t)
})
