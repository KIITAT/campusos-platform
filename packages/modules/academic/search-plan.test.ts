import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { findStudentChoicesWithin, lookupQuery } from './api'

/**
 * NEW-175: under the application role the row-level policy runs before any
 * predicate that is not leakproof, and `lower()` and LIKE are not, so a lookup
 * that wraps a column in them scans every tenant. Each statement a student lookup
 * sends must reach its rows through an index, even with sequential scans
 * disabled (which a planner with only non-leakproof predicates cannot honour).
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

async function plans(q: string, picker: boolean): Promise<string> {
  const tenant = randomUUID()
  return withTenant(tenant, async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`)
    const seen: string[] = []
    const spy = {
      execute: async (query: Parameters<Tx['execute']>[0]) => {
        const { rows } = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (costs off) ${query}`)
        seen.push(rows.map((r) => r['QUERY PLAN']).join('\n'))
        return tx.execute(query)
      },
    }
    await findStudentChoicesWithin(spy as never, tenant, lookupQuery(new Request(`http://x/s?q=${encodeURIComponent(q)}`)), picker)
    return seen.join('\n')
  })
}

for (const [label, q, picker] of [
  ['an exact roll', '7', false],
  ['a name fragment', 'verma', false],
  ['an e-mail in the picker', 'someone@example.test', true],
] as const)
  test(`student lookup by ${label} never scans a table sequentially`, async () => {
    const plan = await plans(q, picker)
    assert.ok(!/Seq Scan/.test(plan), plan)
    assert.match(plan, /Index Cond: .*_key = /, plan) // the exact arm is an index condition on the folded column
  })
