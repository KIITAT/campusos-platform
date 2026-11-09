import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb } from '@campusos/db'
import { publishReportPool } from '@campusos/db/replica'
import {
  archiveReport, createReport, dashboard, listDatasets, listReports, reportDetail, runReport, updateReport,
} from './api'
import { fixture, seedInvoice, type Actor, type Fixture } from './test-support.test'

let a: Fixture
let b: Fixture
let id: string

const refuses = (status: number, code: string, message?: string) => (e: unknown) => {
  const x = e as { status?: number; code?: string; message?: string }
  return x.status === status && x.code === code && (message === undefined || x.message === message)
}

const monthly = {
  name: 'Sales by month',
  dataset: 'finance_sales_invoices',
  spec: { groupBy: 'posting_date', bucket: 'month', measures: [{ fn: 'sum', column: 'total_paise' }], chart: 'bar' },
  viewerRoles: ['accounts_staff'],
  onDashboard: true,
  schedule: 'none',
}

const audits = (f: Fixture, action: string) =>
  authDb.execute<{ entity_id: string; detail: Record<string, unknown> }>(sql`
    select entity_id, detail from audit_log where institution_id = ${f.id} and module_id = 'reports' and action = ${action}`)

before(async () => {
  a = await fixture()
  b = await fixture()
  await seedInvoice(a, '2026-10-05', 100000)
  await seedInvoice(a, '2026-10-20', 50000)
  await seedInvoice(a, '2026-11-02', 25000)
  await seedInvoice(b, '2026-10-05', 777)
})

test('an administrator creates a grouped report', async () => {
  const r = await createReport(a.admin, monthly)
  id = r.id
  assert.match(id, /^[0-9a-f-]{36}$/)
  const rows = (await audits(a, 'report.created')).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.entity_id, id)
  assert.equal(rows[0]!.detail.dataset, 'finance_sales_invoices')
})

test('a clerk cannot create or list datasets; neither can a teacher', async () => {
  await assert.rejects(createReport(a.clerk, monthly), refuses(403, 'not_permitted', 'You cannot do this in reports.'))
  await assert.rejects(listDatasets(a.teacher), refuses(403, 'not_permitted'))
  assert.ok((await listDatasets(a.admin)).some((d) => d.id === 'finance_sales_invoices'))
})

test('a viewer role outside the dataset is refused', async () => {
  await assert.rejects(createReport(a.admin, { ...monthly, viewerRoles: ['faculty'] }), refuses(400, 'bad_report', 'faculty cannot see Sales invoices.'))
})

test('a dataset of a disabled module is unavailable', async () => {
  const hr = { name: 'Staff', dataset: 'hr_staff', spec: { columns: ['name'] }, viewerRoles: [], onDashboard: false, schedule: 'none' }
  await authDb.execute(sql`update institution_modules set enabled = false where institution_id = ${a.id} and module_id = 'hr'`)
  await assert.rejects(createReport(a.admin, hr), refuses(409, 'dataset_unavailable'))
  await authDb.execute(sql`update institution_modules set enabled = true where institution_id = ${a.id} and module_id = 'hr'`)
  await createReport(a.admin, hr)
})

test('run now stores the result', async () => {
  const r = await runReport(a.clerk, { id })
  assert.equal(r.status, 'ok')
  assert.equal(r.rowCount, 2)
  assert.equal(r.truncated, false)
  assert.equal(r.onReplica, false)
  assert.deepEqual(r.rows, [{ posting_date: '2026-10-01', m0: 150000 }, { posting_date: '2026-11-01', m0: 25000 }])
  const stored = await authDb.execute<{ trigger: string; run_by: string }>(sql`select trigger, run_by from reports_runs where report_id = ${id}`)
  assert.deepEqual(stored.rows, [{ trigger: 'manual', run_by: a.clerk.id }])
})

test('a role that is not a viewer cannot see or run', async () => {
  await assert.rejects(reportDetail(a.teacher, { id }), refuses(403, 'not_a_viewer'))
  await assert.rejects(runReport(a.teacher, { id }), refuses(403, 'not_a_viewer'))
  assert.deepEqual(await listReports(a.teacher), [])
})

test('another institution cannot see it', async () => {
  await assert.rejects(reportDetail(b.admin, { id }), refuses(404, 'report_not_found'))
})

test('a run reads through the report pool and truncates at the limit', async () => {
  publishReportPool(process.env.DATABASE_URL!)
  const { id: small } = await createReport(a.admin, { name: 'Two lines', dataset: 'finance_sales_invoices', spec: { columns: ['party'], limit: 1 }, viewerRoles: ['accounts_staff'], onDashboard: false, schedule: 'none' })
  const r = await runReport(a.admin, { id: small })
  assert.equal(r.truncated, true)
  assert.equal(r.rowCount, 1)
  assert.equal(r.onReplica, false)
  const sqlText = (await authDb.execute<{ spec: unknown }>(sql`select spec from reports_reports where id = ${small}`)).rows[0]!
  assert.doesNotMatch(JSON.stringify(sqlText), /insert|update|delete/i)
})

test('only 20 runs are kept', async () => {
  const { id: many } = await createReport(a.admin, { ...monthly, name: 'Many', onDashboard: false })
  for (let i = 0; i < 21; i++) await runReport(a.admin, { id: many })
  const n = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from reports_runs where report_id = ${many}`)
  assert.equal(n.rows[0]!.n, 20)
})

test('a stale report', async () => {
  const { id: stale } = await createReport(a.admin, { ...monthly, name: 'Stale', onDashboard: false })
  await authDb.execute(sql`update reports_reports set spec = '{"columns":["nope"]}'::jsonb where id = ${stale}`)
  await assert.rejects(runReport(a.admin, { id: stale }), refuses(409, 'report_stale', 'There is no column nope in Sales invoices.'))
})

test('update and archive', async () => {
  await updateReport(a.admin, { id, ...monthly, name: 'Sales by month (renamed)' })
  assert.equal((await audits(a, 'report.updated')).rows.length, 1)
  await archiveReport(a.admin, { id })
  assert.equal((await audits(a, 'report.archived')).rows.length, 1)
  await assert.rejects(runReport(a.admin, { id }), refuses(409, 'report_archived'))
  assert.ok(!(await listReports(a.admin)).some((r: { id: string }) => r.id === id))
})

test("the dashboard shows the latest run for the reader's role", async () => {
  const { id: shown } = await createReport(a.admin, { ...monthly, name: 'On the board' })
  await createReport(a.admin, { ...monthly, name: 'Off the board', onDashboard: false })
  await runReport(a.clerk, { id: shown })
  const items = await dashboard(a.clerk as Actor)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.id, shown)
  assert.deepEqual(items[0]!.rows, [{ posting_date: '2026-10-01', m0: 150000 }, { posting_date: '2026-11-01', m0: 25000 }])
  assert.deepEqual(await dashboard(a.teacher as Actor), [])
})
