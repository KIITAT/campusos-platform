import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PgDialect } from 'drizzle-orm/pg-core'
import { compile, checkRoles, specSchema } from './api/compile'
import { ReportsError } from './api/errors'
import type { Dataset } from './api/catalog'

const ds: Dataset = {
  id: 'finance_sales_invoices', label: 'Sales invoices', module: 'finance',
  roles: ['institution_admin', 'super_admin', 'accounts_staff'],
  columns: [
    { name: 'posting_date', label: 'Date', kind: 'date' },
    { name: 'party', label: 'Customer', kind: 'text' },
    { name: 'total_paise', label: 'Total', kind: 'money' },
    { name: 'status', label: 'Status', kind: 'text' },
    { name: 'is_return', label: 'Return', kind: 'bool' },
  ],
}
const today = '2026-11-03'
const S = (x: unknown) => specSchema.parse(x)
const render = (spec: unknown, dataset = ds, t = today) => {
  const c = compile(S(spec), dataset, t)
  const q = new PgDialect().sqlToQuery(c.query)
  return { sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params, columns: c.columns }
}
const bad = (message: string) => (e: unknown) => e instanceof ReportsError && e.status === 400 && e.code === 'bad_report' && e.message === message

test('a list selects the chosen columns', () => {
  const r = render({ columns: ['party', 'total_paise'], limit: 10 })
  assert.equal(r.sql, 'select "party", "total_paise"::bigint from "reporting"."finance_sales_invoices" order by 1 asc nulls last limit $1')
  assert.deepEqual(r.params, [11])
  assert.deepEqual(r.columns, [{ key: 'party', label: 'Customer', kind: 'text' }, { key: 'total_paise', label: 'Total', kind: 'money' }])
})

test('a grouped report by month sums an amount', () => {
  const r = render({ groupBy: 'posting_date', bucket: 'month', measures: [{ fn: 'sum', column: 'total_paise' }], chart: 'bar', limit: 500 })
  assert.equal(r.sql, `select to_char(date_trunc('month', "posting_date"), 'YYYY-MM-DD'), sum("total_paise")::bigint from "reporting"."finance_sales_invoices" group by 1 order by 1 asc nulls last limit $1`)
  assert.deepEqual(r.params, [501])
  assert.deepEqual(r.columns.map((c) => c.key), ['posting_date', 'm0'])
  assert.deepEqual(r.columns.map((c) => c.label), ['Date', 'Sum of Total'])
})

test('totals are one row', () => {
  const r = render({ measures: [{ fn: 'count', column: null }] })
  assert.equal(r.sql, 'select count(*)::bigint from "reporting"."finance_sales_invoices"')
  assert.deepEqual(r.params, [])
  assert.deepEqual(r.columns, [{ key: 'm0', label: 'Count', kind: 'number' }])
})

test('filters bind their values', () => {
  const r = render({
    columns: ['party'],
    filters: [
      { column: 'party', op: 'contains', value: "50%_off!'" },
      { column: 'total_paise', op: 'ge', value: '1000.5' },
      { column: 'posting_date', op: 'ge', value: 'fy_start' },
      { column: 'is_return', op: 'is_false', value: '' },
      { column: 'status', op: 'eq', value: 'submitted' },
    ],
  })
  assert.ok(r.sql.includes(`where "party" ilike $1 escape '!' and "total_paise" >= $2::bigint and "posting_date" >= $3::date and "is_return" is false and "status" = $4::text`), r.sql)
  assert.deepEqual(r.params.slice(0, 4), ["%50!%!_off!!'%", '100050', '2026-04-01', 'submitted'])
})

test('relative dates resolve against today', () => {
  const date = (value: string, t = today) => render({ columns: ['party'], filters: [{ column: 'posting_date', op: 'ge', value }] }, ds, t).params[0]
  assert.equal(date('today-30'), '2026-10-04')
  assert.equal(date('month_start'), '2026-11-01')
  assert.equal(date('fy_start', '2026-03-31'), '2025-04-01')
})

test('refusals carry the exact message', () => {
  const list = { columns: ['party'] }
  assert.throws(() => render({ columns: ['x'] }), bad('There is no column x in Sales invoices.'))
  assert.throws(() => render({ columns: ['party'], filters: [{ column: 'total_paise', op: 'contains', value: 'a' }] }), bad('contains cannot be used on Total.'))
  assert.throws(() => render({ columns: ['party'], filters: [{ column: 'total_paise', op: 'eq', value: '12.345' }] }), bad('Total: 12.345 is not a valid money.'))
  assert.throws(() => render({ columns: ['party'], filters: [{ column: 'posting_date', op: 'eq', value: '2026-02-30' }] }), bad('Date: 2026-02-30 is not a valid date.'))
  assert.throws(() => render({ measures: [{ fn: 'sum', column: 'party' }] }), bad('sum needs a number or amount column.'))
  assert.throws(() => render({ ...list, chart: 'bar' }), bad('A chart needs the rows grouped.'))
  assert.throws(() => render({}), bad('Choose at least one column, or group the rows and add a measure.'))
  assert.throws(() => render({ groupBy: 'party' }), bad('Group the rows by a column and add at least one measure.'))
  assert.throws(() => render({ groupBy: 'party', bucket: 'month', measures: [{ fn: 'count', column: null }] }), bad('Months and years group a date column only.'))
  assert.throws(() => render({ ...list, sort: { key: 'status', dir: 'asc' } }), bad('Sort by a column the report shows.'))
  assert.throws(() => checkRoles(['faculty'], ds), bad('faculty cannot see Sales invoices.'))
})

test('an identifier never reaches SQL unchecked', () => {
  const name = 'party"; drop table x; --'
  assert.throws(() => render({ columns: [name] }), bad(`There is no column ${name} in Sales invoices.`))
})
