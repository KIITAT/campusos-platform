import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, withTenant } from '@campusos/db'
import { createReport } from './api'
import { nextRunAt } from './api/schedule'
import { jobs } from './jobs'
import { fixture, seedInvoice, type Fixture } from './test-support.test'

const at = (s: string) => new Date(s)
const iso = (d: Date | null) => d?.toISOString() ?? null

test('nextRunAt golden cases', () => {
  const cases: [string, 'daily' | 'weekly' | 'monthly', string][] = [
    ['2026-11-03T00:00:00Z', 'daily', '2026-11-03T01:30:00.000Z'],
    ['2026-11-03T00:00:00Z', 'weekly', '2026-11-09T01:30:00.000Z'],
    ['2026-11-03T00:00:00Z', 'monthly', '2026-12-01T01:30:00.000Z'],
    ['2026-11-03T01:30:00Z', 'daily', '2026-11-04T01:30:00.000Z'],
    ['2026-11-30T20:00:00Z', 'daily', '2026-12-01T01:30:00.000Z'],
    ['2026-11-30T20:00:00Z', 'monthly', '2026-12-01T01:30:00.000Z'],
    ['2026-11-09T01:30:00Z', 'weekly', '2026-11-16T01:30:00.000Z'],
    ['2026-12-31T22:00:00Z', 'monthly', '2027-01-01T01:30:00.000Z'],
  ]
  for (const [after, schedule, want] of cases) assert.equal(iso(nextRunAt(schedule, at(after))), want, `${schedule} after ${after}`)
  assert.equal(nextRunAt('none', at('2026-11-03T00:00:00Z')), null)
})

let a: Fixture
const input = (name: string) => ({
  name, dataset: 'finance_sales_invoices', spec: { groupBy: 'posting_date', bucket: 'month', measures: [{ fn: 'sum', column: 'total_paise' }] },
  viewerRoles: ['accounts_staff'], onDashboard: false, schedule: 'daily',
})
const due = (id: string) => authDb.execute(sql`update reports_reports set next_run_at = now() - interval '1 minute' where id = ${id}`)
const runDue = (f: Fixture) => withTenant(f.id, (tx) => jobs[0]!.run(f.admin, tx, {})) as Promise<{ ran: number; failed: number }>

before(async () => {
  a = await fixture()
  await seedInvoice(a, '2026-10-05', 100000)
})

test('the job runs due reports and notifies viewers', async () => {
  const { id } = await createReport(a.admin, input('Daily sales'))
  await due(id)
  assert.deepEqual(await runDue(a), { ran: 1, failed: 0 })
  const run = (await authDb.execute<{ trigger: string; run_by: string | null; status: string }>(sql`select trigger, run_by, status from reports_runs where report_id = ${id}`)).rows
  assert.deepEqual(run, [{ trigger: 'schedule', run_by: null, status: 'ok' }])
  const next = (await authDb.execute<{ next_run_at: string; started_at: string }>(sql`
    select r.next_run_at, u.started_at from reports_reports r join reports_runs u on u.report_id = r.id where r.id = ${id}`)).rows[0]!
  assert.equal(iso(new Date(next.next_run_at)), iso(nextRunAt('daily', new Date(next.started_at))))
  const got = (await authDb.execute<{ user_id: string; title: string; link: string }>(sql`
    select user_id, title, link from notifications where institution_id = ${a.id} and module_id = 'reports' order by user_id`)).rows
  assert.deepEqual(got.map((n) => n.user_id).sort(), [a.admin.id, a.clerk.id].sort())
  for (const n of got) {
    assert.equal(n.title, 'Report ready: Daily sales')
    assert.equal(n.link, `/m/reports/report?id=${id}`)
  }
})

test('at most three per run', async () => {
  const f = await fixture()
  await seedInvoice(f)
  const ids: string[] = []
  for (let i = 0; i < 5; i++) { const { id } = await createReport(f.admin, input('R' + i)); await due(id); ids.push(id) }
  assert.deepEqual(await runDue(f), { ran: 3, failed: 0 })
  const left = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from reports_reports where institution_id = ${f.id} and next_run_at <= now()`)
  assert.equal(left.rows[0]!.n, 2)
})

test('a failed scheduled run advances and does not notify', async () => {
  const f = await fixture()
  const { id } = await createReport(f.admin, input('Breaks'))
  await authDb.execute(sql`update reports_reports set spec = '{"columns":["nope"]}'::jsonb where id = ${id}`)
  await due(id)
  assert.deepEqual(await runDue(f), { ran: 0, failed: 1 })
  const run = (await authDb.execute<{ status: string; error_code: string }>(sql`select status, error_code from reports_runs where report_id = ${id}`)).rows
  assert.deepEqual(run, [{ status: 'failed', error_code: 'report_stale' }])
  const future = await authDb.execute<{ ok: boolean }>(sql`select next_run_at > now() as ok from reports_reports where id = ${id}`)
  assert.equal(future.rows[0]!.ok, true)
  const sent = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from notifications where institution_id = ${f.id} and module_id = 'reports'`)
  assert.equal(sent.rows[0]!.n, 0)
})

test('two workers never run one report twice', async () => {
  const f = await fixture()
  await seedInvoice(f)
  const { id } = await createReport(f.admin, input('Locked'))
  await due(id)
  await authDb.transaction(async (tx) => {
    await tx.execute(sql`select id from reports_reports where id = ${id} for update`)
    const started = Date.now()
    assert.deepEqual(await runDue(f), { ran: 0, failed: 0 })
    assert.ok(Date.now() - started < 5000)
  })
  assert.deepEqual(await runDue(f), { ran: 1, failed: 0 })
})
