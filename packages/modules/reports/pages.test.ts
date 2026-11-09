import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pagesFor, matchPage } from '@campusos/module-framework'
import { createReport, runReport } from './api'
import { pages } from './pages'
import plugin from './plugin'
import { fixture, seedInvoice, type Fixture } from './test-support.test'

let a: Fixture
let id: string

before(async () => {
  a = await fixture()
  await seedInvoice(a, '2026-10-05', 100000)
  id = (await createReport(a.admin, {
    name: 'Sales by month', dataset: 'finance_sales_invoices',
    spec: { groupBy: 'posting_date', bucket: 'month', measures: [{ fn: 'sum', column: 'total_paise' }], chart: 'bar' },
    viewerRoles: ['accounts_staff'], onDashboard: true,
  })).id
  await runReport(a.clerk, { id })
})

const req = (path: string) => new Request('https://x.test' + path)
const kinds = async (path: string, who: Fixture['admin'], url = path) => {
  const page = matchPage(pages, path)!
  const data = await page.load(who, req(url))
  return page.sections(data).map((s) => s.kind)
}

test('the plugin loads with ten routes and a job', () => {
  assert.equal(plugin.routes.length, 10)
  assert.equal(plugin.jobs?.length, 1)
})

test('the dashboard draws the chart for a clerk and is empty for a teacher', async () => {
  assert.deepEqual(await kinds('/', a.clerk), ['chart', 'links'])
  assert.deepEqual(await kinds('/', a.teacher), ['note'])
})

test('the report list and the report page', async () => {
  assert.deepEqual(await kinds('/reports', a.admin), ['table', 'links'])
  assert.deepEqual(await kinds('/reports', a.clerk), ['table'])
  assert.deepEqual(await kinds('/report', a.clerk, '/report?id=' + id), ['chart', 'table', 'form', 'links'])
  assert.deepEqual(await kinds('/report', a.admin, '/report?id=' + id), ['chart', 'table', 'form', 'links', 'form'])
})

test('the builder asks for a dataset, then shows the form', async () => {
  assert.deepEqual(await kinds('/new', a.admin), ['note', 'form'])
  assert.deepEqual(await kinds('/new', a.admin, '/new?dataset=finance_sales_invoices'), ['form'])
  assert.deepEqual(await kinds('/edit', a.admin, '/edit?id=' + id), ['form'])
})

test('a clerk is not offered the builder', () => {
  const menu = pagesFor(pages, 'accounts_staff').map((p) => p.path)
  assert.deepEqual(menu, ['/', '/reports'])
  assert.ok(pagesFor(pages, 'institution_admin').some((p) => p.path === '/new'))
})
