import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, corePool, withTenant } from '@campusos/db'
import { createReport, runReport } from './api'
import { jobs } from './jobs'
import { fixture, seedInvoice, type Fixture } from './test-support.test'

// No report pool is published in this file: reads go to the primary pool (five connections), as on a
// hub kit without REPORTS_DATABASE_URL. Review P2-05 HIGH-1.

let a: Fixture
let id: string

before(async () => {
  a = await fixture()
  await seedInvoice(a, '2026-10-05', 100000)
  id = (await createReport(a.admin, {
    name: 'Totals', dataset: 'finance_sales_invoices', spec: { measures: [{ fn: 'sum', column: 'total_paise' }] }, viewerRoles: ['accounts_staff'], schedule: 'none',
  })).id
})

test('six people running reports at once do not starve the primary pool', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => runReport(a.clerk, { id })))
  for (const r of results) assert.equal(r.status, 'ok')
})

test('a scheduled run uses only the transaction the worker gives it (decision 469)', async () => {
  // The worker runs four lanes in a pool of five. Hold four connections; the job gets the fifth and must
  // not need a sixth. Review P2-05 HIGH-2.
  const held = await Promise.all(Array.from({ length: 4 }, () => corePool.connect()))
  try {
    await authDb.execute(sql`update reports_reports set schedule = 'daily', next_run_at = now() - interval '1 minute' where id = ${id}`)
    const out = await withTenant(a.id, (tx) => jobs[0]!.run(a.admin, tx, {}))
    assert.deepEqual(out, { ran: 1, failed: 0 })
  } finally {
    for (const c of held) c.release()
  }
})

test('a run of something that is not a report id is a 404, not a database error', async () => {
  await assert.rejects(runReport(a.clerk, { id: 'nope' }), (e: unknown) => (e as { status?: number; code?: string }).status === 404 && (e as { code?: string }).code === 'report_not_found')
})
