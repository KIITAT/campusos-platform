import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { HrError, createStaff, generatePayroll, setComponent, setPayrollSettings, setStatutoryIdentity, statutoryFile, withholdSalary, type Actor } from './api'
import { payslips } from './schema'

/** The ECR, ESI and bank advice downloads from stored payslips (P1-06c step 3). */

let n = 0
const SLUG = 'hr-files-'

interface College { id: string; admin: Actor; clerk: Actor; faculty: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Files College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: i!.id, role: 'accounts_staff', name: 'Clerk' },
      { email: `fac@${tag}.test`, institutionId: i!.id, role: 'faculty', name: 'Fac' },
    ])
    .returning({ id: users.id })
  const mk = (k: number, role: Actor['role'], t: string): Actor => ({ id: people[k]!.id, email: `${t}@${tag}.test`, role, institutionId: i!.id })
  return { id: i!.id, admin: mk(0, 'institution_admin', 'adm'), clerk: mk(1, 'accounts_staff', 'clerk'), faculty: mk(2, 'faculty', 'fac') }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const hire = (c: College, code: string, name: string) =>
  createStaff(c.admin, { employeeCode: code, name, designation: 'Lecturer', joinedOn: '2026-01-01' })

const identity = (c: College, staffId: string, over: Record<string, unknown> = {}) =>
  setStatutoryIdentity(c.admin, { staffId, pfMember: true, ...over })

const pay = (c: College, staffId: string, code: string, amount: string, wageClass: 'wage' | 'excluded' = 'wage') =>
  setComponent(c.admin, { staffId, code, label: code, kind: 'earning', amount, effectiveFrom: '2026-01-01', wageClass })

const turnOn = (c: College) =>
  setPayrollSettings(c.admin, { prorationBasis: 'calendar', statutoryFrom: '2026-03', pfRegistered: true, esiRegistered: true })

const slips = (c: College) => withTenant(c.id, (tx) => tx.select().from(payslips).where(eq(payslips.institutionId, c.id)))

/** Two PF members (one above the ceiling), one low-paid ESI person without PF. */
async function april() {
  const c = await college()
  const a = await hire(c, 'A-1', 'Ravi Kumar')
  const b = await hire(c, 'B-1', 'Sita Rao')
  const e = await hire(c, 'C-1', 'Esi Person')
  await turnOn(c)
  await identity(c, a.id, { uan: '100200300401', bankAccount: '123456789012', bankIfsc: 'HDFC0001234' })
  await identity(c, b.id, { uan: '100200300402', esiExempt: true, bankAccount: '223456789012', bankIfsc: 'HDFC0001234' })
  await identity(c, e.id, { pfMember: false, esiNumber: '1234567890', bankAccount: '323456789012', bankIfsc: 'HDFC0001234' })
  await pay(c, a.id, 'basic', '40000')
  await pay(c, a.id, 'hra', '16000', 'excluded')
  await pay(c, b.id, 'basic', '12000')
  await pay(c, e.id, 'basic', '15000')
  const run = await generatePayroll(c.admin, { period: '2026-04' })
  assert.deepEqual(run.failed, [])
  return { c, a, b, e }
}

test('the ECR has a line per PF member that adds up to the payslips', async () => {
  const { c, a, b } = await april()
  const f = await statutoryFile(c.admin, 'ecr', '2026-04')
  const lines = f.content.split('\n')
  assert.equal(lines.length, 2)
  const all = await slips(c)
  for (const [i, who] of [a, b].entries()) {
    const p = lines[i]!.split('#~#')
    assert.equal(p.length, 11)
    const slip = all.find((s) => s.staffId === who.id)!
    const l = (slip.lines as { code: string; appliedPaise: number }[]).find((x) => x.code === 'pf_employee')!
    assert.equal(Number(p[6]), l.appliedPaise / 100)
    const emp = (slip.statutory as { employer: { epsPaise: number; epfPaise: number } }).employer
    assert.equal(Number(p[7]) + Number(p[8]), (emp.epsPaise + emp.epfPaise) / 100)
  }
  assert.equal(f.name, 'ecr-2026-04.txt')
})

test('a member without a UAN refuses the whole ECR', async () => {
  const { c, b } = await april()
  await identity(c, b.id, { uan: null })
  await assert.rejects(
    () => statutoryFile(c.admin, 'ecr', '2026-04'),
    (e) => e instanceof HrError && e.status === 409 && e.code === 'incomplete_details' && e.message === 'UAN missing for: B-1',
  )
})

test('the ESI file lists the covered person with their wages in rupees', async () => {
  const { c } = await april()
  const f = await statutoryFile(c.admin, 'esi', '2026-04')
  const rows = f.content.split('\n')
  assert.equal(rows.length, 2)
  assert.match(rows[1]!, /^1234567890,Esi Person,30,15000,0,$/)
  assert.equal(f.name, 'esi-2026-04.csv')
})

test('the bank advice covers exactly the non-withheld payslips', async () => {
  const c = await college()
  const a = await hire(c, 'A-1', 'Ravi Kumar')
  const b = await hire(c, 'B-1', 'Sita Rao')
  await turnOn(c)
  for (const p of [a, b]) {
    await identity(c, p.id, { pfMember: false, bankAccount: '123456789012', bankIfsc: 'HDFC0001234' })
    await pay(c, p.id, 'basic', '30000')
  }
  await withholdSalary(c.admin, { staffId: b.id, fromPeriod: '2026-04', reason: 'unexplained absence under inquiry' })
  await generatePayroll(c.admin, { period: '2026-04' })
  const f = await statutoryFile(c.admin, 'bank-advice', '2026-04')
  const rows = f.content.split('\n').slice(1)
  assert.equal(rows.length, 1)
  assert.ok(rows[0]!.startsWith('A-1,'))
  const live = (await slips(c)).filter((s) => !s.withheld).reduce((t, s) => t + s.netPaise, 0)
  const advice = rows.reduce((t, r) => t + Math.round(Number(r.split(',')[4]) * 100), 0)
  assert.equal(advice, live)
})

test('only the administrators may fetch a statutory file', async () => {
  const { c } = await april()
  for (const who of [c.clerk, c.faculty]) {
    for (const kind of ['ecr', 'esi', 'bank-advice'] as const) {
      await assert.rejects(() => statutoryFile(who, kind, '2026-04'), (e) => e instanceof HrError && e.status === 403 && e.code === 'forbidden')
    }
  }
})

test('a period must be YYYY-MM', async () => {
  const { c } = await april()
  await assert.rejects(() => statutoryFile(c.admin, 'ecr', '2026-4'), (e) => e instanceof HrError && e.status === 400 && e.code === 'bad_period')
})
