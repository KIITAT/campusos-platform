import { sql, type SQL } from 'drizzle-orm'

/**
 * Server-side paging for a list (DATA-01).
 *
 * A loader reads what the reader asked for with `readPage`, filters with
 * `searchAny`, orders by `orderKeys`, cuts with `keyset`, selects
 * `cursorColumn` as `_cursor`, fetches `limit + 1` rows and hands them to
 * `finishPage` with the count. Keyset, not offset: page 5,000 costs what
 * page 1 does.
 *
 * Rules for a sort's keys: each is NOT NULL (coalesce a nullable column to
 * a sentinel), the last is the row's primary key, and all run in the one
 * direction -- otherwise the single row comparison is not exact.
 */

export type KeyType = 'text' | 'date' | 'timestamptz' | 'uuid' | 'bigint'
export interface KeyColumn { sql: SQL; type: KeyType }
export type SortSpec = Record<string, { dir: 'asc' | 'desc'; keys: KeyColumn[] }>

export interface PageRequest {
  q: string | null
  sort: string
  dir: 'asc' | 'desc'
  limit: number
  after: string[] | null
}

export interface Page<T> { rows: T[]; total: number; next: string | null }

/** What a paged table's `paging.data` key holds. */
export interface PageInfo { total: number; next: string | null }

export const MAX_PAGE = 500

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

function decode(cursor: string | null | undefined, sort: string, dir: string): string[] | null {
  if (!cursor || cursor.length > 2000) return null
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown; d?: unknown; k?: unknown }
    if (v.s !== sort || v.d !== dir || !Array.isArray(v.k) || !v.k.every((x) => typeof x === 'string')) return null
    return v.k as string[]
  } catch {
    return null
  }
}

/**
 * The page a request asks for. `prefix` is the table's rows key on a page
 * (`notices` reads `notices.q`, `notices.after`), or '' on an API route.
 * An unknown sort falls back to `defaultSort`; a bad cursor to the first page.
 */
export function readPage(req: Request, prefix: string, sorts: SortSpec, defaultSort: string, pageSize = 20): PageRequest {
  const params = new URL(req.url).searchParams
  const get = (k: string) => params.get(prefix ? `${prefix}.${k}` : k)
  const asked = get('sort')
  const sort = asked && Object.hasOwn(sorts, asked) ? asked : defaultSort
  const d = get('dir')
  const dir = d === 'asc' || d === 'desc' ? d : sorts[sort]!.dir
  const n = Number(get('n'))
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_PAGE) : Math.min(pageSize, MAX_PAGE)
  const raw = get('q')?.trim() ?? ''
  const q = raw && raw.length <= 100 ? raw : null
  const after = decode(get('after'), sort, dir)
  return { q, sort, dir, limit, after: after && after.length === sorts[sort]!.keys.length ? after : null }
}

/** `(k1, k2, ...) < (...)` for desc, `>` for asc; undefined on the first page. */
export function keyset(keys: KeyColumn[], page: PageRequest): SQL | undefined {
  if (!page.after || page.after.length !== keys.length) return undefined
  const left = sql.join(keys.map((k) => k.sql), sql`, `)
  const right = sql.join(page.after.map((v, i) => sql`${v}::${sql.raw(keys[i]!.type)}`), sql`, `)
  return page.dir === 'desc' ? sql`(${left}) < (${right})` : sql`(${left}) > (${right})`
}

export const orderKeys = (keys: KeyColumn[], dir: 'asc' | 'desc'): SQL[] =>
  keys.map((k) => (dir === 'desc' ? sql`${k.sql} desc` : sql`${k.sql} asc`))

/** Select this as `_cursor`: the row's keys as text, at full precision. */
export const cursorColumn = (keys: KeyColumn[]): SQL<string[]> =>
  sql<string[]>`array[${sql.join(keys.map((k) => sql`(${k.sql})::text`), sql`, `)}]`

/** Cut the `limit + 1` rows fetched to the page, and say where the next one starts. */
export function finishPage<T extends { _cursor: string[] }>(rows: T[], page: PageRequest, total: number): Page<Omit<T, '_cursor'>> {
  const more = rows.length > page.limit
  const shown = rows.slice(0, page.limit)
  const last = shown[shown.length - 1]
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    rows: shown.map(({ _cursor, ...rest }) => rest),
    total,
    next: more && last ? encode({ s: page.sort, d: page.dir, k: last._cursor }) : null,
  }
}

/** `(c1 ilike '%q%' or c2 ilike '%q%')`, with `\`, `%` and `_` in q taken literally. */
export function searchAny(q: string | null, columns: SQL[]): SQL | undefined {
  if (!q || columns.length === 0) return undefined
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  return sql`(${sql.join(columns.map((c) => sql`${c} ilike ${pattern}`), sql` or `)})`
}
