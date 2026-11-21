import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { lookupQuery } from '@campusos/module-academic/api'
import { findBooksWithin } from './api/search'

/**
 * NEW-175: under the application role `lower()` and LIKE are not leakproof, so a
 * catalogue lookup that wraps a column in them scans every tenant's titles. The
 * statement must use an index, even with sequential scans disabled.
 */

for (const q of ['9780262033848', 'quixotic', 'ab'])
  test(`catalogue lookup for ${q} never scans library_titles sequentially`, async () => {
    const tenant = randomUUID()
    const plan = await withTenant(tenant, async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`)
      const spy = {
        execute: async (query: Parameters<typeof tx.execute>[0]) => {
          const { rows } = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (costs off) ${query}`)
          return { rows: rows.map((r) => r['QUERY PLAN']) }
        },
      }
      return ((await findBooksWithin(spy as never, tenant, lookupQuery(new Request(`http://x/b?q=${q}`)))) as unknown as string[]).join('\n')
    })
    assert.ok(!/Seq Scan/.test(plan), plan)
    assert.match(plan, /Index Cond: .*_key = /, plan) // the exact arm is an index condition on the folded column
  })
