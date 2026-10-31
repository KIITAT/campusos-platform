import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import { setSingleOfficer } from '@campusos/module-finance/api'
import { HrError, createStaff, generatePayroll, paySalaries, setComponent, type Actor } from './api'

/**
 * ACC-01 (P0-07): the administrator who ran a month's payroll does not pay it,
 * unless single-officer mode is on.
 */

let n = 0
const SLUG = 'hr-sod-'
const PAY = 'you ran this month’s payroll, so someone else must pay it'

interface College { id: string; admin: Actor; admin2: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Sod College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Adm' },
      { email: `adm2@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Adm Two' },
    ])
    .returning({ id: users.id })
  const who = (at: number): Actor => ({ id: people[at]!.id, email: `adm${at}@${tag}.test`, role: 'institution_admin', institutionId: i!.id })
  const c = { id: i!.id, admin: who(0), admin2: who(1) }
  const s = await createStaff(c.admin, { employeeCode: 'E-1', name: 'A Lecturer', designation: 'Lecturer', joinedOn: '2026-01-01' })
  for (const [code, kind, amount] of [['basic', 'earning', '40000'], ['pf', 'deduction', '4800']] as const) {
    await setComponent(c.admin, { staffId: s.id, code, label: code, kind, amount, effectiveFrom: '2026-01-01' })
  }
  return c
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('the administrator who ran the month cannot pay it; a second administrator can', async () => {
  const c = await college()
  await generatePayroll(c.admin, { period: '2026-03' })
  await assert.rejects(paySalaries(c.admin, { period: '2026-03', paidOn: '2026-04-02' }), (e: unknown) => {
    assert.ok(e instanceof HrError)
    assert.equal(e.code, 'separation_of_duties')
    assert.equal(e.status, 403)
    assert.equal(e.message, PAY)
    return true
  })
  await paySalaries(c.admin2, { period: '2026-03', paidOn: '2026-04-02' })
})

test('single-officer mode lets the same administrator pay, and writes the use to the trail', async () => {
  const c = await college()
  await setSingleOfficer(c.admin, { enabled: true, reason: 'one accountant only' })
  await generatePayroll(c.admin, { period: '2026-03' })
  await paySalaries(c.admin, { period: '2026-03', paidOn: '2026-04-02' })
  const rows = await withTenant(c.id, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.institutionId, c.id), eq(auditLog.action, 'sod.single_officer_used'))),
  )
  assert.deepEqual(rows.map((r) => (r.detail as { act: string }).act), ['pay_payroll'])
})
