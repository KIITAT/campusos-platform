import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { parquetReadObjects } from 'hyparquet'
import { authDb } from '@campusos/db'
import { withTenantRead } from '@campusos/db/replica'
import { createReport, datasetById, datasets, exportParquet, istToday, parquetRows, runCsv, runReport, specSchema } from './api'
import { fixture, seedInvoice, type Fixture } from './test-support.test'

let a: Fixture
let listRun: string
let monthly: string

const refuses = (status: number, code: string) => (e: unknown) => (e as { status?: number }).status === status && (e as { code?: string }).code === code

before(async () => {
  a = await fixture()
  await seedInvoice(a, '2026-10-05', 100050, '=HYPERLINK("x")')
  await seedInvoice(a, '2026-11-02', 50000, 'Beta')
  const list = await createReport(a.admin, { name: 'List', dataset: 'finance_sales_invoices', spec: { columns: ['party', 'total_paise'], filters: [{ column: 'party', op: 'contains', value: 'HYPER' }] }, viewerRoles: ['accounts_staff'] })
  listRun = (await runReport(a.clerk, { id: list.id })).runId
  monthly = (await createReport(a.admin, { name: 'Monthly', dataset: 'finance_sales_invoices', spec: { groupBy: 'posting_date', bucket: 'month', measures: [{ fn: 'sum', column: 'total_paise' }] }, viewerRoles: [] })).id
})

test('CSV of a run', async () => {
  const res = await runCsv(a.clerk, { id: listRun })
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8')
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="report-${istToday()}.csv"`)
  const lines = (await res.text()).trimEnd().split(/\r?\n/)
  assert.equal(lines[0], 'Customer,Total')
  assert.equal(lines[1], `"'=HYPERLINK(""x"")",1000.50`)
})

test('CSV is for viewers only', async () => {
  await assert.rejects(runCsv(a.teacher, { id: listRun }), refuses(403, 'not_a_viewer'))
  await assert.rejects(runCsv(a.clerk, { id: '00000000-0000-4000-8000-000000000000' }), refuses(404, 'run_not_found'))
})

test('Parquet of a report', async () => {
  const res = await exportParquet(a.admin, { id: monthly })
  assert.equal(res.headers.get('content-type'), 'application/vnd.apache.parquet')
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="finance_sales_invoices-${istToday()}.parquet"`)
  const rows = await parquetReadObjects({ file: await res.arrayBuffer() })
  assert.deepEqual(rows, [{ posting_date: '2026-10-01', m0: 100050n }, { posting_date: '2026-11-01', m0: 50000n }])
  const audit = await authDb.execute<{ detail: { rows: number; format: string } }>(sql`select detail from audit_log where institution_id = ${a.id} and action = 'report.exported'`)
  assert.equal(audit.rows.length, 1)
  assert.equal(audit.rows[0]!.detail.rows, 2)
  assert.equal(audit.rows[0]!.detail.format, 'parquet')
})

test('Parquet is administrators only', async () => {
  await assert.rejects(exportParquet(a.clerk, { id: monthly }), refuses(403, 'not_permitted'))
})

test('too many rows', async () => {
  await assert.rejects(
    withTenantRead(a.id, async (tx) => {
      const ds = datasetById(await datasets(tx, a.id), 'finance_sales_invoices')!
      return parquetRows(tx, ds, specSchema.parse({ columns: ['party'] }), istToday(), 1)
    }),
    refuses(409, 'export_too_large'),
  )
})
