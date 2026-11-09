import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, withTenant } from '@campusos/db'
import { fixture, seedInvoice } from './test-support.test'

const VIEWS = ['fees_payments', 'finance_sales_invoices', 'hr_staff']

test('every reporting view is security_invoker and granted', async () => {
  const r = await authDb.execute<{ relname: string; reloptions: string[]; granted: boolean }>(sql`
    select c.relname, c.reloptions, has_table_privilege('campusos_app', 'reporting.' || c.relname, 'select') as granted
      from pg_class c where c.relnamespace = to_regnamespace('reporting') and c.relkind = 'v' order by 1`)
  assert.deepEqual(r.rows.map((x) => x.relname), VIEWS)
  for (const x of r.rows) {
    assert.ok(x.reloptions.includes('security_invoker=true'), x.relname)
    assert.equal(x.granted, true, x.relname)
  }
})

test('every reporting view and column carries valid metadata', async () => {
  const { viewMetaSchema, columnMetaSchema } = await import('./api/catalog')
  const r = await authDb.execute<{ relname: string; meta: string; col: string; col_meta: string }>(sql`
    select c.relname, obj_description(c.oid, 'pg_class') as meta, a.attname as col, col_description(c.oid, a.attnum) as col_meta
      from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where c.relnamespace = to_regnamespace('reporting') and c.relkind = 'v'`)
  assert.ok(r.rows.length > 0)
  for (const x of r.rows) {
    assert.ok(viewMetaSchema.safeParse(JSON.parse(x.meta)).success, x.relname)
    assert.ok(columnMetaSchema.safeParse(JSON.parse(x.col_meta)).success, `${x.relname}.${x.col}`)
  }
})

test("a dataset shows only the reading institution's rows", async () => {
  const [a, b] = [await fixture(), await fixture()]
  await seedInvoice(a); await seedInvoice(b)
  const n = await withTenant(a.id, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from reporting.finance_sales_invoices`))
  assert.equal(n.rows[0]!.n, 1)
})

test('the staff dataset carries no personal identifiers', async () => {
  const r = await authDb.execute<{ column_name: string }>(sql`
    select column_name from information_schema.columns where table_schema = 'reporting' and table_name = 'hr_staff' order by ordinal_position`)
  assert.deepEqual(r.rows.map((x) => x.column_name), ['employee_code', 'name', 'designation', 'department', 'employment', 'joined_on', 'left_on', 'active'])
})
