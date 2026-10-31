import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { createStaff, type Actor } from './api'
import { taxDeclarations, taxPreviousEmployment, taxRegimes, taxSurcharges } from './schema'

/**
 * The TDS estimator (P1-06b): the tables, the operations, the run and the
 * page, in the order the plan builds them. A fresh institution per test: the
 * journal is append-only.
 */

let n = 0
const SLUG = 'hr-tds-'

interface College { id: string; admin: Actor; clerk: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Tax College', allowedEmailDomains: [`${tag}.test`] })
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

const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}

test('the tax tables are isolated between institutions', async () => {
  const a = await college()
  const b = await college()
  const s = await hire(a)
  const [regime] = await withTenant(a.id, (tx) =>
    tx.insert(taxRegimes).values({ institutionId: a.id, code: 'NEW', name: 'New regime' }).returning(),
  )
  await withTenant(a.id, async (tx) => {
    await tx.insert(taxDeclarations).values({ institutionId: a.id, staffId: s.id, taxYear: 2026, head: '80c', declaredPaise: 100 })
    await tx.insert(taxPreviousEmployment).values({ institutionId: a.id, staffId: s.id, taxYear: 2026, incomePaise: 100, tdsPaise: 0 })
    await tx.insert(taxSurcharges).values({ institutionId: a.id, regimeId: regime!.id, abovePaise: 100, rateBp: 1000 })
  })
  const seen = await withTenant(b.id, async (tx) => [
    (await tx.select().from(taxDeclarations)).length,
    (await tx.select().from(taxPreviousEmployment)).length,
    (await tx.select().from(taxSurcharges)).length,
  ])
  assert.deepEqual(seen, [0, 0, 0])
  await assert.rejects(
    () => withTenant(b.id, (tx) => tx.insert(taxDeclarations).values({ institutionId: a.id, staffId: s.id, taxYear: 2027, head: '80c', declaredPaise: 1 })),
    saysDb(/row-level security|violates/i),
  )
  await assert.rejects(
    () => withTenant(b.id, (tx) => tx.insert(taxPreviousEmployment).values({ institutionId: a.id, staffId: s.id, taxYear: 2027, incomePaise: 1, tdsPaise: 0 })),
    saysDb(/row-level security|violates/i),
  )
  await assert.rejects(
    () => withTenant(b.id, (tx) => tx.insert(taxSurcharges).values({ institutionId: a.id, regimeId: regime!.id, abovePaise: 200, rateBp: 1000 })),
    saysDb(/row-level security|violates/i),
  )
})

test('the database refuses a proved amount below zero', async () => {
  const c = await college()
  const s = await hire(c)
  const [row] = await withTenant(c.id, (tx) =>
    tx.insert(taxDeclarations).values({ institutionId: c.id, staffId: s.id, taxYear: 2026, head: '80c', declaredPaise: 100 }).returning(),
  )
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.update(taxDeclarations).set({ provedPaise: -1 }).where(eq(taxDeclarations.id, row!.id))),
    saysDb(/hr_tax_declarations_amounts/),
  )
})
