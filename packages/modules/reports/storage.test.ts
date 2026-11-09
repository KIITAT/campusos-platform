import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, withTenant } from '@campusos/db'
import { fixture, type Fixture } from './test-support.test'

/** Owner inserts a report (and optionally runs) for an institution. */
async function report(f: Fixture, name = 'R') {
  const r = await authDb.execute<{ id: string }>(sql`
    insert into reports_reports (institution_id, name, dataset, spec, created_by)
    values (${f.id}, ${name}, 'finance_sales_invoices', '{"columns":["party"]}'::jsonb, ${f.admin.id}) returning id`)
  return r.rows[0]!.id
}
const run = (f: Fixture, reportId: string, startedAgo = '0 days') => authDb.execute(sql`
  insert into reports_runs (institution_id, report_id, trigger, status, started_at)
  values (${f.id}, ${reportId}, 'manual', 'ok', now() - ${startedAgo}::interval)`)

test('reports tables exist with row security', async () => {
  const r = await authDb.execute<{ relname: string; relrowsecurity: boolean }>(sql`
    select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname in ('reports_reports','reports_runs') order by 1`)
  assert.deepEqual(r.rows.map((x) => [x.relname, x.relrowsecurity]), [['reports_reports', true], ['reports_runs', true]])
})

test('an institution sees only its own reports', async () => {
  const [a, b] = [await fixture(), await fixture()]
  await report(a)
  assert.equal((await withTenant(b.id, (tx) => tx.execute(sql`select count(*)::int as n from reports_reports`))).rows[0]!.n, 0)
  assert.equal((await withTenant(a.id, (tx) => tx.execute(sql`select count(*)::int as n from reports_reports`))).rows[0]!.n, 1)
})

test("a run belongs to its report's institution", async () => {
  const [a, b] = [await fixture(), await fixture()]
  const id = await report(a)
  await assert.rejects(() => authDb.execute(sql`insert into reports_runs (institution_id, report_id, trigger, status) values (${b.id}, ${id}, 'manual', 'ok')`))
})

test("erase_reports deletes the subject's institution's runs only", async () => {
  const [a, b] = [await fixture(), await fixture()]
  const [ra, rb] = [await report(a), await report(b)]
  await run(a, ra); await run(a, ra); await run(b, rb)
  const out = await withTenant(a.id, (tx) => tx.execute<{ r: Record<string, number> }>(sql`select dpdp_subject.erase_reports(${a.student.id}) as r`))
  assert.deepEqual(out.rows[0]!.r, { reports_runs: 2 })
  const left = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from reports_runs where institution_id = ${b.id}`)
  assert.equal(left.rows[0]!.n, 1)
})

test('purge_reports deletes runs older than 90 days', async () => {
  const a = await fixture()
  const id = await report(a)
  await run(a, id, '91 days'); await run(a, id)
  const out = await authDb.execute<{ r: Record<string, number> }>(sql`select dpdp_retention.purge_reports(${a.id}) as r`)
  assert.deepEqual(out.rows[0]!.r, { reports_runs: 1 })
})
