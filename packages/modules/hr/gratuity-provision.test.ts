import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { createStaff, type Actor } from './api'
import { gratuityValuationLines, gratuityValuations } from './schema'

/**
 * The gratuity provision (P1-06d, ACC-29): the valuation tables, valuing, the
 * payout drawn from the provision and the page, in the order the plan builds
 * them. A fresh institution per test: the journal is append-only.
 */

let n = 0
const SLUG = 'hr-grat-'

interface College { id: string; admin: Actor; clerk: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Gratuity College', allowedEmailDomains: [`${tag}.test`] })
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
  createStaff(c.admin, { employeeCode: 'E-1', name: 'A Lecturer', designation: 'Lecturer', joinedOn: '2020-01-01', ...over })

const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}

const valuation = (c: College, over: Record<string, unknown> = {}) => ({
  institutionId: c.id,
  asOf: '2026-09-30',
  method: 'actuarial' as const,
  obligationPaise: 100,
  provisionBeforePaise: 0,
  adjustmentPaise: 100,
  reference: 'AV-1',
  ...over,
})

test('the valuation tables are isolated between institutions', async () => {
  const a = await college()
  const b = await college()
  const s = await hire(a)
  const [v] = await withTenant(a.id, (tx) => tx.insert(gratuityValuations).values(valuation(a)).returning({ id: gratuityValuations.id }))
  const line = (valuationId: string) => ({ institutionId: a.id, valuationId, staffId: s.id, serviceYears: 1, monthlyWagePaise: 100, amountPaise: 6 })
  await withTenant(a.id, (tx) => tx.insert(gratuityValuationLines).values(line(v!.id)))
  assert.equal((await withTenant(b.id, (tx) => tx.select().from(gratuityValuations))).length, 0)
  assert.equal((await withTenant(b.id, (tx) => tx.select().from(gratuityValuationLines))).length, 0)
  await assert.rejects(() => withTenant(b.id, (tx) => tx.insert(gratuityValuations).values(valuation(a))), saysDb(/row-level security|violates/i))
  await assert.rejects(() => withTenant(b.id, (tx) => tx.insert(gratuityValuationLines).values(line(v!.id))), saysDb(/row-level security|violates/i))
})

test('a valuation and its lines cannot be changed or deleted', async () => {
  const c = await college()
  const s = await hire(c)
  const [v] = await withTenant(c.id, (tx) => tx.insert(gratuityValuations).values(valuation(c)).returning({ id: gratuityValuations.id }))
  await withTenant(c.id, (tx) =>
    tx.insert(gratuityValuationLines).values({ institutionId: c.id, valuationId: v!.id, staffId: s.id, serviceYears: 1, monthlyWagePaise: 100, amountPaise: 6 }),
  )
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.update(gratuityValuations).set({ reference: 'X' }).where(eq(gratuityValuations.id, v!.id))),
    saysDb(/a gratuity valuation cannot be changed/),
  )
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.delete(gratuityValuationLines).where(eq(gratuityValuationLines.valuationId, v!.id))),
    saysDb(/a gratuity valuation cannot be changed/),
  )
  await authDb.delete(institutions).where(eq(institutions.id, c.id))
  assert.equal((await authDb.select().from(institutions).where(eq(institutions.id, c.id))).length, 0)
})

test('the database refuses a valuation that is not at a month end, or whose sums disagree', async () => {
  const c = await college()
  const put = (over: Record<string, unknown>) => withTenant(c.id, (tx) => tx.insert(gratuityValuations).values(valuation(c, over)))
  await assert.rejects(() => put({ asOf: '2026-09-29' }), saysDb(/hr_gratuity_valuations_month_end/))
  await assert.rejects(() => put({ adjustmentPaise: 99 }), saysDb(/hr_gratuity_valuations_sum/))
  await assert.rejects(() => put({ method: 'accrued', ruleId: null, reference: null }), saysDb(/hr_gratuity_valuations_basis/))
})

test('hr_about carries a person’s valuation lines', async () => {
  const c = await college()
  const s = await hire(c, { userId: c.admin.id })
  const [v] = await withTenant(c.id, (tx) => tx.insert(gratuityValuations).values(valuation(c)).returning({ id: gratuityValuations.id }))
  await withTenant(c.id, (tx) =>
    tx.insert(gratuityValuationLines).values({ institutionId: c.id, valuationId: v!.id, staffId: s.id, serviceYears: 1, monthlyWagePaise: 100, amountPaise: 6 }),
  )
  const sources = await withTenant(c.id, async (tx) =>
    (await tx.execute<{ source: string }>(sql`select source from dpdp_subject.hr_about where subject_id = ${c.admin.id}`)).rows.map((r) => r.source),
  )
  assert.ok(sources.includes('hr_gratuity_valuation_lines'), sources.join(','))
})
