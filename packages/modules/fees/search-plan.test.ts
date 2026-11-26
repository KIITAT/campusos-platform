import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { lookupQuery } from '@campusos/module-academic/api'
import { findReceiptsWithin, searchFeeReceipts } from './api/search'
import type { Actor } from './api'

/**
 * NEW-175: under the application role `lower()` and LIKE are not leakproof, so a
 * receipt lookup that wraps the column in them runs after the tenant policy and
 * scans every tenant's receipts. The statement must use an index (sequential
 * scans disabled), and a hub of many tenants must still answer quickly.
 */

const SLUG = 'fees-plan-'

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

for (const q of ['R-049999', 'ab']) // a contains-search and an exact-only one
  test(`receipt lookup for ${q} never scans fee_payments sequentially`, async () => {
    const tenant = randomUUID()
    const plan = await withTenant(tenant, async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`)
      const spy = {
        execute: async (query: Parameters<typeof tx.execute>[0]) => {
          const { rows } = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (costs off) ${query}`)
          return { rows: rows.map((r) => r['QUERY PLAN']) }
        },
      }
      return ((await findReceiptsWithin(spy as never, tenant, lookupQuery(new Request(`http://x/r?q=${q}`)))) as unknown as string[]).join('\n')
    })
    assert.ok(!/Seq Scan/.test(plan), plan)
    assert.match(plan, /Index Cond: .*_key = /, plan) // the exact arm is an index condition on the folded column
  })

test('fifty tenants with receipts each: a lookup stays fast and tenant-bound', async () => {
  const ids: string[] = []
  for (let i = 0; i < 50; i++) {
    const tag = `${SLUG}${i}`
    const [inst] = await authDb.insert(institutions).values({ slug: tag, name: 'Hub College', allowedEmailDomains: [`${tag}.test`] }).returning({ id: institutions.id })
    ids.push(inst!.id)
  }
  const students = await authDb
    .insert(users)
    .values(ids.map((id, i) => ({ email: `s@${SLUG}${i}.test`, institutionId: id, role: 'student' as const, name: 'Pupil' })))
    .returning({ id: users.id, institutionId: users.institutionId })
  for (const s of students)
    await withTenant(s.institutionId!, async (tx) => {
      await tx.execute(sql`insert into academic_terms (id, institution_id, code, name, starts_on, ends_on) values (${s.institutionId}, ${s.institutionId}, 'T1', 'Term', '2026-01-01', '2026-06-01')`)
      await tx.execute(sql`
        insert into fee_payments (institution_id, student_id, term_id, amount_paise, method, receipt_no)
        select ${s.institutionId}, ${s.id}, ${s.institutionId}, 1000 + g, 'cash', 'R-' || lpad(g::text, 6, '0') from generate_series(1, 3000) g`)
    })
  const first = students[0]!
  const actor = { id: first.id, role: 'institution_admin', institutionId: first.institutionId } as Actor
  const ask = (q: string) => searchFeeReceipts(actor, new Request(`http://x/r?q=${encodeURIComponent(q)}`))
  await ask('R-000001') // warm up
  for (const [q, n] of [['R-002999', 1], ['R-0029', 12]] as const) {
    const t0 = performance.now()
    const { hits } = await ask(q)
    const ms = performance.now() - t0
    assert.equal(hits.length, n, q)
    assert.ok(ms < 500, `${q} took ${Math.round(ms)} ms`)
  }
})
