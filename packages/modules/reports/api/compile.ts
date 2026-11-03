import * as z from 'zod'
import { sql, type Name, type SQL } from 'drizzle-orm'
import type { Role } from '@campusos/module-framework'
import { badReport } from './errors'
import { DEFAULT_LIMIT, MAX_ROWS } from './limits'
import type { Dataset, Kind } from './catalog'

/** The report definition and its SQL compiler (decisions 439 to 441). Identifiers come from the catalog; values are binds. */

const OPS = ['eq', 'ne', 'contains', 'empty', 'not_empty', 'lt', 'le', 'gt', 'ge', 'is_true', 'is_false'] as const
const FNS = ['count', 'sum', 'avg', 'min', 'max'] as const
type Op = (typeof OPS)[number]

export const specSchema = z.object({
  columns: z.array(z.string().min(1).max(63)).max(20).default([]),
  filters: z.array(z.object({ column: z.string().min(1).max(63), op: z.enum(OPS), value: z.string().max(200).default('') })).max(10).default([]),
  groupBy: z.string().min(1).max(63).nullable().default(null),
  bucket: z.enum(['day', 'month', 'year']).nullable().default(null),
  measures: z.array(z.object({ fn: z.enum(FNS), column: z.string().min(1).max(63).nullable().default(null) })).max(3).default([]),
  sort: z.object({ key: z.string().min(1).max(63), dir: z.enum(['asc', 'desc']) }).nullable().default(null),
  limit: z.coerce.number().int().min(1).max(MAX_ROWS).default(DEFAULT_LIMIT),
  chart: z.enum(['none', 'bar', 'line']).default('none'),
})
export type Spec = z.infer<typeof specSchema>
export interface OutColumn { key: string; label: string; kind: Kind }

const ALLOWED: Record<Kind, readonly Op[]> = {
  text: ['eq', 'ne', 'contains', 'empty', 'not_empty'],
  number: ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'empty', 'not_empty'],
  money: ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'empty', 'not_empty'],
  date: ['eq', 'lt', 'le', 'gt', 'ge', 'empty', 'not_empty'],
  bool: ['is_true', 'is_false'],
}
const COMPARE: Partial<Record<Op, string>> = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }
const LABEL = { sum: 'Sum of', avg: 'Average of', min: 'Lowest', max: 'Highest' } as const

export function checkRoles(roles: readonly Role[], ds: Dataset): void {
  for (const r of roles) if (!ds.roles.includes(r)) throw badReport(`${r} cannot see ${ds.label}.`)
}

const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const real = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

/** A calendar date, or one of today, today-N, month_start, fy_start resolved against `today` (YYYY-MM-DD, India). Null when invalid. */
export function resolveDate(value: string, today: string): string | null {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number]
  if (value === 'today') return today
  if (value === 'month_start') return iso(y, m, 1)
  if (value === 'fy_start') return iso(m >= 4 ? y : y - 1, 4, 1)
  const back = /^today-(\d{1,4})$/.exec(value)
  if (back) {
    const n = Number(back[1])
    if (n < 1 || n > 3660) return null
    const t = new Date(Date.UTC(y, m - 1, d - n))
    return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
  }
  return real(value) ? value : null
}

/** Rupees as text to paise as text, by string arithmetic; null when not an amount. */
export function rupeesToPaise(v: string): string | null {
  const m = /^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/.exec(v)
  if (!m) return null
  const n = BigInt(m[2]! + (m[3] ?? '').padEnd(2, '0'))
  return (m[1] && n !== 0n ? '-' : '') + n.toString()
}

const NUMBER = /^-?\d{1,15}(\.\d{1,6})?$/

const select = (id: SQL | Name, kind: Kind): SQL =>
  kind === 'money' ? sql`${id}::bigint` : kind === 'number' ? sql`${id}::float8` : kind === 'date' ? sql`to_char(${id}, 'YYYY-MM-DD')` : id

function condition(f: Spec['filters'][number], kind: Kind, label: string, today: string): SQL {
  const id = sql.identifier(f.column)
  if (!ALLOWED[kind].includes(f.op)) throw badReport(`${f.op} cannot be used on ${label}.`)
  if (f.op === 'is_true') return sql`${id} is true`
  if (f.op === 'is_false') return sql`${id} is false`
  if (f.op === 'not_empty') return kind === 'text' ? sql`(${id} is not null and ${id} <> '')` : sql`${id} is not null`
  if (f.op === 'empty') return kind === 'text' ? sql`(${id} is null or ${id} = '')` : sql`${id} is null`
  const invalid = () => badReport(`${label}: ${f.value} is not a valid ${kind}.`)
  if (f.op === 'contains') {
    if (f.value.length < 1) throw invalid()
    return sql`${id} ilike ${'%' + f.value.replace(/[!%_]/g, (c) => '!' + c) + '%'} escape '!'`
  }
  const op = sql.raw(COMPARE[f.op]!)
  if (kind === 'text') {
    if (f.value.length < 1) throw invalid()
    return sql`${id} ${op} ${f.value}::text`
  }
  if (kind === 'number') {
    if (!NUMBER.test(f.value)) throw invalid()
    return sql`${id} ${op} ${f.value}::numeric`
  }
  if (kind === 'money') {
    const paise = rupeesToPaise(f.value)
    if (paise === null) throw invalid()
    return sql`${id} ${op} ${paise}::bigint`
  }
  const day = resolveDate(f.value, today)
  if (day === null) throw invalid()
  return sql`${id} ${op} ${day}::date`
}

export function compile(spec: Spec, ds: Dataset, today: string, opts: { cap?: number } = {}): { query: SQL; columns: OutColumn[] } {
  const col = (name: string) => {
    const c = ds.columns.find((x) => x.name === name)
    if (!c) throw badReport(`There is no column ${name} in ${ds.label}.`)
    return c
  }
  const grouped = spec.groupBy !== null
  const totals = !grouped && spec.measures.length > 0
  if (!grouped && !totals && spec.columns.length === 0) throw badReport('Choose at least one column, or group the rows and add a measure.')
  if (grouped && spec.measures.length === 0) throw badReport('Group the rows by a column and add at least one measure.')
  if (spec.chart !== 'none' && !grouped) throw badReport('A chart needs the rows grouped.')

  const where: SQL[] = spec.filters.map((f) => {
    const c = col(f.column)
    return condition(f, c.kind, c.label, today)
  })

  const items: SQL[] = []
  const columns: OutColumn[] = []
  if (grouped) {
    const g = col(spec.groupBy!)
    if (spec.bucket && g.kind !== 'date') throw badReport('Months and years group a date column only.')
    const id = sql.identifier(g.name)
    items.push(spec.bucket ? sql`to_char(date_trunc(${sql.raw("'" + spec.bucket + "'")}, ${id}), 'YYYY-MM-DD')` : select(id, g.kind))
    columns.push({ key: g.name, label: g.label, kind: g.kind })
  } else if (!totals) {
    for (const name of spec.columns) {
      const c = col(name)
      items.push(select(sql.identifier(c.name), c.kind))
      columns.push({ key: c.name, label: c.label, kind: c.kind })
    }
  }
  if (grouped || totals) {
    spec.measures.forEach((m, i) => {
      const c = m.column === null ? null : col(m.column)
      let out: SQL
      let kind: Kind
      let label: string
      if (m.fn === 'count') {
        out = c ? sql`count(${sql.identifier(c.name)})::bigint` : sql`count(*)::bigint`
        kind = 'number'
        label = c ? `Count of ${c.label}` : 'Count'
      } else if (m.fn === 'sum' || m.fn === 'avg') {
        if (!c || (c.kind !== 'number' && c.kind !== 'money')) throw badReport(`${m.fn} needs a number or amount column.`)
        const id = sql.identifier(c.name)
        out = m.fn === 'sum' ? select(sql`sum(${id})`, c.kind) : c.kind === 'money' ? sql`round(avg(${id}))::bigint` : sql`avg(${id})::float8`
        kind = c.kind
        label = `${LABEL[m.fn]} ${c.label}`
      } else {
        if (!c || (c.kind !== 'number' && c.kind !== 'money' && c.kind !== 'date')) throw badReport(`${m.fn} needs a number, amount or date column.`)
        const id = sql.identifier(c.name)
        out = select(m.fn === 'min' ? sql`min(${id})` : sql`max(${id})`, c.kind)
        kind = c.kind
        label = `${LABEL[m.fn]} ${c.label}`
      }
      items.push(out)
      columns.push({ key: `m${i}`, label, kind })
    })
  }

  let order: SQL | null = null
  if (!totals) {
    const key = spec.sort?.key ?? columns[0]!.key
    const at = columns.findIndex((c) => c.key === key)
    if (at < 0) throw badReport('Sort by a column the report shows.')
    order = sql`order by ${sql.raw(String(at + 1))} ${sql.raw(spec.sort?.dir === 'desc' ? 'desc' : 'asc')} nulls last`
  }

  const view = sql`${sql.identifier('reporting')}.${sql.identifier(ds.id)}`
  const parts: SQL[] = [sql`select ${sql.join(items, sql`, `)} from ${view}`]
  if (where.length) parts.push(sql`where ${sql.join(where, sql` and `)}`)
  if (grouped) parts.push(sql`group by 1`)
  if (order) parts.push(order, sql`limit ${(opts.cap ?? spec.limit) + 1}`)
  return { query: sql.join(parts, sql` `), columns }
}
