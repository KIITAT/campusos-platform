import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { payslipReissues, remittances, staff, taxDeclarations } from './schema'

/**
 * Remittances and the reissue archive (P1-06c step 1): isolation, the checks,
 * the guards, the partial unique index and hr_about. A fresh institution per
 * test.
 */

let n = 0
const SLUG = 'hr-remit-schema-'

interface College { id: string; adminId: string }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Remittance College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const [u] = await authDb
    .insert(users)
    .values({ email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Adm' })
    .returning({ id: users.id })
  return { id: i!.id, adminId: u!.id }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}

const remit = (c: College, over: Record<string, unknown> = {}) => ({
  institutionId: c.id,
  head: 'esi' as const,
  period: '2026-04-01',
  amountPaise: 100_000,
  paidOn: '2026-05-10',
  paidFrom: 'bank' as const,
  challanRef: 'CH-1',
  remittedBy: c.adminId,
  ...over,
})

const person = (c: College, userId: string | null = null) =>
  withTenant(c.id, async (tx) => {
    const [s] = await tx
      .insert(staff)
      .values({ institutionId: c.id, userId, employeeCode: 'E-1', name: 'A Person', designation: 'Lecturer', joinedOn: '2026-01-01' })
      .returning({ id: staff.id })
    return s!.id
  })

test('remittances and reissue records are isolated between institutions', async () => {
  const a = await college()
  const b = await college()
  await withTenant(a.id, (tx) => tx.insert(remittances).values(remit(a)))
  const staffId = await person(a)
  await withTenant(a.id, (tx) =>
    tx.insert(payslipReissues).values({ institutionId: a.id, staffId, period: '2026-04-01', originalId: staffId, snapshot: {}, reason: 'wrong basic' }),
  )
  assert.equal((await withTenant(b.id, (tx) => tx.select().from(remittances))).length, 0)
  assert.equal((await withTenant(b.id, (tx) => tx.select().from(payslipReissues))).length, 0)
  await assert.rejects(() => withTenant(b.id, (tx) => tx.insert(remittances).values(remit(a, { challanRef: 'CH-2' }))), saysDb(/row-level security|violates/i))
})

test('the checks on hr_remittances', async () => {
  const c = await college()
  const bad = (over: Record<string, unknown>, re: RegExp) =>
    assert.rejects(() => withTenant(c.id, (tx) => tx.insert(remittances).values(remit(c, over) as never)), saysDb(re))
  await bad({ head: 'cash' }, /hr_remittances_head/)
  await bad({ head: 'pt', state: null }, /hr_remittances_state_rule/)
  await bad({ head: 'tds', bsrCode: null, challanSerial: null }, /hr_remittances_tds_challan/)
  await bad({ amountPaise: 0 }, /hr_remittances_amount/)
})

test('a remittance can only be voided, never changed or deleted', async () => {
  const c = await college()
  const [r] = await withTenant(c.id, (tx) => tx.insert(remittances).values(remit(c)).returning({ id: remittances.id }))
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.update(remittances).set({ amountPaise: 5 }).where(eq(remittances.id, r!.id))),
    saysDb(/a remittance cannot be changed/),
  )
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.delete(remittances).where(eq(remittances.id, r!.id))),
    saysDb(/a remittance cannot be deleted/),
  )
  await withTenant(c.id, (tx) =>
    tx.update(remittances).set({ voidedAt: new Date(), voidedBy: c.adminId, voidReason: 'entered twice' }).where(eq(remittances.id, r!.id)),
  )
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.update(remittances).set({ voidReason: 'again' }).where(eq(remittances.id, r!.id))),
    saysDb(/a remittance cannot be changed/),
  )
})

test('a challan reference is used once among live remittances', async () => {
  const c = await college()
  const tds = { head: 'tds', bsrCode: '0510308', challanSerial: '00123', challanRef: 'T-1' }
  const [first] = await withTenant(c.id, (tx) => tx.insert(remittances).values(remit(c, tds) as never).returning({ id: remittances.id }))
  await assert.rejects(() => withTenant(c.id, (tx) => tx.insert(remittances).values(remit(c, tds) as never)), saysDb(/hr_remittances_challan_once/))
  await withTenant(c.id, (tx) =>
    tx.update(remittances).set({ voidedAt: new Date(), voidedBy: c.adminId, voidReason: 'wrong date' }).where(eq(remittances.id, first!.id)),
  )
  await withTenant(c.id, (tx) => tx.insert(remittances).values(remit(c, tds) as never))
})

test('a reissue record is append-only', async () => {
  const c = await college()
  const staffId = await person(c)
  const [r] = await withTenant(c.id, (tx) =>
    tx.insert(payslipReissues).values({ institutionId: c.id, staffId, period: '2026-04-01', originalId: staffId, snapshot: {}, reason: 'wrong basic' }).returning({ id: payslipReissues.id }),
  )
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.update(payslipReissues).set({ reason: 'changed my mind' }).where(eq(payslipReissues.id, r!.id))),
    saysDb(/a reissue record cannot be changed/),
  )
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.delete(payslipReissues).where(eq(payslipReissues.id, r!.id))),
    saysDb(/a reissue record cannot be changed/),
  )
})

test('hr_about carries the reissue archive and the tax declarations', async () => {
  const c = await college()
  const staffId = await person(c, c.adminId)
  await withTenant(c.id, async (tx) => {
    await tx.insert(payslipReissues).values({ institutionId: c.id, staffId, period: '2026-04-01', originalId: staffId, snapshot: {}, reason: 'wrong basic' })
    await tx.insert(taxDeclarations).values({ institutionId: c.id, staffId, taxYear: 2026, head: '80c', declaredPaise: 100_000 })
  })
  const sources = await withTenant(c.id, async (tx) =>
    (await tx.execute<{ source: string }>(sql`select source from dpdp_subject.hr_about where subject_id = ${c.adminId}`)).rows.map((r) => r.source),
  )
  assert.ok(sources.includes('hr_payslip_reissues'), sources.join(','))
  assert.ok(sources.includes('hr_tax_declarations'), sources.join(','))
})
