import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { createStaff, type Actor } from './api'
import { ptSlabs, staff } from './schema'

/**
 * Statutory pay (P1-06a): the schema, then the run, the posting and the
 * operations, in the order the plan builds them. A fresh institution per
 * test: the journal is append-only.
 */

let n = 0
const SLUG = 'hr-stat-'

interface College { id: string; admin: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Statutory College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const people = await authDb
    .insert(users)
    .values([{ email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Adm' }])
    .returning({ id: users.id })
  return { id: i!.id, admin: { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: i!.id } }
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

test('hr_pt_slabs is isolated between institutions', async () => {
  const a = await college()
  const b = await college()
  await withTenant(a.id, (tx) =>
    tx.insert(ptSlabs).values({ institutionId: a.id, state: 'KA', effectiveFrom: '2026-04-01', fromPaise: 0, toPaise: null, amountPaise: 20000 }),
  )
  const seen = await withTenant(b.id, (tx) => tx.select().from(ptSlabs))
  assert.equal(seen.length, 0)
  await assert.rejects(
    () => withTenant(b.id, (tx) => tx.insert(ptSlabs).values({ institutionId: a.id, state: 'KA', effectiveFrom: '2026-05-01', fromPaise: 0, amountPaise: 1 })),
    saysDb(/row-level security|violates/i),
  )
})

test('the database refuses a malformed PAN', async () => {
  const c = await college()
  const s = await hire(c)
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.update(staff).set({ pan: 'ABCDE1234' }).where(eq(staff.id, s.id))),
    saysDb(/hr_staff_pan/),
  )
})
