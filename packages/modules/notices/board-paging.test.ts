import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { board, noticePage, type Actor } from './api'

let inst = ''
let admin: Actor
let reader: Actor

before(async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: 'notice-paging', name: 'Paging College', allowedEmailDomains: ['paging.test'] })
    .returning({ id: institutions.id })
  inst = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@paging.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 's@paging.test', institutionId: inst, role: 'student', name: 'Stu' },
    ])
    .returning({ id: users.id })
  admin = { id: people[0]!.id, email: 'adm@paging.test', role: 'institution_admin', institutionId: inst }
  reader = { id: people[1]!.id, email: 's@paging.test', role: 'student', institutionId: inst }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, 'notice-paging'))
})

const seed = async (n: number) => {
  await seedRows(n)
  // A real table is analysed by autovacuum; one filled a moment ago is not, and the planner then sorts every row with its subqueries. The owner pool (authDb in the test environment) may analyse.
  await authDb.execute(sql`analyze notices`)
}
const seedRows = (n: number) =>
  withTenant(inst, (tx) =>
    tx.execute(sql`insert into notices (institution_id, title, body, author_id, published_at)
      select ${inst}, 'N' || g, 'b', ${admin.id}, now() - (g || ' seconds')::interval
      from generate_series(1, ${n}::int) g`),
  )

test('the board pages without repeats and counts everything (DATA-01)', async () => {
  await seed(205)
  const seen = new Set<string>()
  const sizes: number[] = []
  let after: string | null = null
  do {
    const url: string = `https://x/?n=50${after ? `&after=${after}` : ''}`
    const page = await board(reader, false, noticePage(new Request(url), ''))
    assert.equal(page.total, 205)
    sizes.push(page.rows.length)
    for (const r of page.rows) seen.add(r.id)
    after = page.next
  } while (after)
  assert.equal(seen.size, 205)
  assert.deepEqual(sizes, [50, 50, 50, 50, 5])
})

test('a hundred thousand notices page in under 500 ms (DATA-01)', async () => {
  await seed(100_000)
  const first = noticePage(new Request('https://x/?n=20'), '')
  const warm = await board(reader, false, first)
  assert.ok(warm.next)
  const t0 = performance.now()
  const p1 = await board(reader, false, first)
  const t1 = performance.now()
  const p2 = await board(reader, false, noticePage(new Request(`https://x/?n=20&after=${p1.next}`), ''))
  const t2 = performance.now()
  console.log(`notices 100k: first page ${(t1 - t0).toFixed(0)} ms, next page ${(t2 - t1).toFixed(0)} ms`)
  assert.equal(p2.rows.length, 20)
  assert.ok(t1 - t0 < 500, 'first page')
  assert.ok(t2 - t1 < 500, 'next page')
})
