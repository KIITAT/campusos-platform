import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, withTenant } from './client'
import { institutions, users } from './schema'

/**
 * The institution's record of personal data breaches (AUD-08, P1-08d). It is
 * evidence: what was known when is never rewritten, each step is stamped
 * once, a closed record is frozen, and the application cannot delete one.
 */

let I: string
let other: string
let admin: string

const says = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}

async function institution(slug: string) {
  const [i] = await authDb.insert(institutions).values({ slug, name: slug, allowedEmailDomains: [] }).returning({ id: institutions.id })
  const [u] = await authDb
    .insert(users)
    .values({ email: `admin@${slug}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Admin' })
    .returning({ id: users.id })
  return { id: i!.id, admin: u!.id }
}

before(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, 'br-test-%'))
  const a = await institution('br-test-1')
  const b = await institution('br-test-2')
  I = a.id
  admin = a.admin
  other = b.id
})

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, 'br-test-%'))
})

const insert = (inst: string, awareSql = sql`now() - interval '1 hour'`) =>
  withTenant(inst, async (tx) => {
    const r = await tx.execute<{ id: string }>(sql`
      insert into breach_incidents (institution_id, recorded_by, aware_at, description, likely_impact)
      values (${inst}, ${admin}, ${awareSql}, 'laptop stolen with marks', 'marks exposed') returning id`)
    return r.rows[0]!.id
  })

test('a breach record keeps what was recorded', async () => {
  const id = await insert(I)
  const update = (set: ReturnType<typeof sql>) => withTenant(I, (tx) => tx.execute(sql`update breach_incidents set ${set} where id = ${id}`))
  await assert.rejects(() => update(sql`description = 'something else entirely'`), says(/breach_incident_fixed|keeps what was recorded/))
  await update(sql`board_told_at = now()`)
  await assert.rejects(() => update(sql`board_told_at = now()`), says(/breach_incident_fixed|keeps what was recorded/))
  await update(sql`closed_at = now()`)
  await assert.rejects(() => update(sql`measures = 'later'`), says(/breach_incident_fixed|keeps what was recorded/))
})

test('the application cannot delete a breach record', async () => {
  await insert(I)
  await assert.rejects(() => withTenant(I, (tx) => tx.execute(sql`delete from breach_incidents`)), says(/permission denied/))
})

test('another institution sees none of it', async () => {
  await insert(I)
  const seen = await withTenant(other, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from breach_incidents`))
  assert.equal(seen.rows[0]!.n, 0)
  await assert.rejects(
    () =>
      withTenant(other, (tx) =>
        tx.execute(sql`insert into breach_incidents (institution_id, aware_at, description, likely_impact) values (${I}, now(), 'laptop stolen with marks', 'marks exposed')`),
      ),
    says(/row-level security|violates/),
  )
})

test('awareness cannot follow the record', async () => {
  await assert.rejects(() => insert(I, sql`now() + interval '1 hour'`), says(/breach_aware_before_recorded/))
})
