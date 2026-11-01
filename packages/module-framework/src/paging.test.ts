import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@campusos/db'
import {
  cursorColumn,
  finishPage,
  keyset,
  orderKeys,
  readPage,
  searchAny,
  type KeyColumn,
  type PageRequest,
  type SortSpec,
} from './paging'

const k = (s: SQL, type: KeyColumn['type'] = 'text'): KeyColumn => ({ sql: s, type })
const SORTS: SortSpec = {
  when: { dir: 'desc', keys: [k(sql`1`), k(sql`2`)] },
  name: { dir: 'asc', keys: [k(sql`3`), k(sql`4`)] },
}

test('readPage reads prefixed parameters, clamps n and falls back on unknown sort', () => {
  const page = readPage(new Request('https://x/m/a?t.sort=bogus&t.n=9999&t.q=%20ab%20'), 't', SORTS, 'when')
  assert.deepEqual(page, { sort: 'when', dir: 'desc', limit: 500, q: 'ab', after: null })
})

test('a cursor round-trips and a mismatched one is ignored', () => {
  const page: PageRequest = { q: null, sort: 'when', dir: 'desc', limit: 1, after: null }
  const out = finishPage(
    [
      { _cursor: ['2026-01-01', 'b'], v: 1 },
      { _cursor: ['2026-01-01', 'a'], v: 2 },
    ],
    page,
    2,
  )
  assert.deepEqual(out.rows, [{ v: 1 }])
  assert.ok(out.next)
  const same = readPage(new Request(`https://x/?t.after=${out.next}`), 't', SORTS, 'when')
  assert.deepEqual(same.after, ['2026-01-01', 'b'])
  const other = readPage(new Request(`https://x/?t.sort=name&t.after=${out.next}`), 't', SORTS, 'when')
  assert.equal(other.after, null)
  const junk = readPage(new Request('https://x/?t.after=%%%'), 't', SORTS, 'when')
  assert.equal(junk.after, null)
})

/** Follow `next` over a values list until it runs out; returns the ids in order. */
async function walk(values: SQL, keys: KeyColumn[], limit: number): Promise<string[]> {
  const sorts: SortSpec = { s: { dir: 'desc', keys } }
  const ids: string[] = []
  let after: string | null = null
  for (let i = 0; i < 50; i++) {
    const url: string = `https://x/?${after ? `after=${after}&` : ''}n=${limit}`
    const page = readPage(new Request(url), '', sorts, 's')
    const cut = keyset(keys, page)
    const res = await db.execute(sql`
      select v.id as id, ${cursorColumn(keys)} as _cursor
      from (${values}) v
      ${cut ? sql`where ${cut}` : sql``}
      order by ${sql.join(orderKeys(keys, page.dir), sql`, `)}
      limit ${page.limit + 1}`)
    const rows = (res as unknown as { rows?: { id: string; _cursor: string[] }[] }).rows ?? (res as unknown as { id: string; _cursor: string[] }[])
    const out = finishPage(rows.map((r) => ({ id: r.id, _cursor: toArray(r._cursor) })), page, 0)
    ids.push(...out.rows.map((r) => r.id))
    if (!out.next) return ids
    after = out.next
  }
  throw new Error('did not end')
}

/** node-postgres hands a text[] back as an array; a driver that does not hands '{a,b}'. */
const toArray = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : String(v).slice(1, -1).split(',').map((s) => s.replace(/^"|"$/g, '')))

test('keyset pages through rows with equal first keys exactly once', async () => {
  const values = sql`select * from (values ('2026-01-02'::date,'c'),('2026-01-01'::date,'b'),('2026-01-01'::date,'a'),('2026-01-01'::date,'d'),('2025-12-31'::date,'e')) t(d, id)`
  const ids = await walk(values, [k(sql`v.d`, 'date'), k(sql`v.id`, 'text')], 2)
  assert.deepEqual(ids, ['c', 'd', 'b', 'a', 'e'])
  assert.equal(new Set(ids).size, ids.length)
})

test('timestamps keep their microseconds in the cursor', async () => {
  const values = sql`select * from (values ('2026-01-01 10:00:00.123456+00'::timestamptz,'x'),('2026-01-01 10:00:00.123457+00'::timestamptz,'y')) t(d, id)`
  const ids = await walk(values, [k(sql`v.d`, 'timestamptz'), k(sql`v.id`, 'text')], 1)
  assert.deepEqual(ids, ['y', 'x'])
})

test('search escapes like wildcards', async () => {
  const find = async (q: string) => {
    const res = await db.execute(sql`select v from (values ('50%'),('500'),('a_b'),('axb')) t(v) where ${searchAny(q, [sql`v`])}`)
    const rows = (res as unknown as { rows?: { v: string }[] }).rows ?? (res as unknown as { v: string }[])
    return rows.map((r) => r.v)
  }
  assert.deepEqual(await find('50%'), ['50%'])
  assert.deepEqual(await find('a_b'), ['a_b'])
})
