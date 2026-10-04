import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginForm } from '@campusos/module-framework'
import { pages } from './pages'
import { specs } from './routes'
import { manifest } from './manifest'

const screen = (path: string) => {
  const page = pages.find(candidate => candidate.path === path)
  assert.ok(page, `Missing working screen: ${path}`)
  return page
}
const context = { query: {}, document: {}, lines: [], editLines: [], rows: [], approvals: [], openInvoices: [], admin: true, office: true }
const paths = ['/my', '/approvals', '/cost-centers', '/funds', '/currencies', '/series', '/approval-rules', '/staff', '/taxes', '/uoms', '/item-groups', '/parties', '/party', '/items', '/item', '/warehouses', '/batches', '/recurring', '/material-requests', '/material-request/new', '/material-request', '/rfqs', '/rfq/new', '/rfq', '/supplier-quotations', '/supplier-quotation/new', '/commitments', '/assets', '/asset/new', '/asset', '/asset-categories', '/depreciation', '/assets/maintenance', '/bank', '/bank-account', '/bank-line', '/bank-rules', '/bank/reconciliation', '/stock/balance', '/stock/ledger', '/stock/reorder', '/stock/expiry', '/stock/serials', '/stock/against-books', '/reports/aging', '/reports/funds', '/reports/fund', '/reports/cost-centers', '/reports/gst', '/reports/gstr1', '/reports/gstr3b', '/reports/hsn', '/reports/register', '/reports/tds']

test('every planned finance workflow is navigable without duplicate destinations', () => {
  for (const path of paths) screen(path)
  for (const [list, record] of [['invoices', 'invoice'], ['orders', 'order'], ['receipts', 'receipt'], ['payments', 'payment'], ['vouchers', 'voucher'], ['stock-entries', 'stock-entry']]) {
    for (const path of [`/${list}`, `/${record}/new`, `/${record}`]) screen(path)
  }
  assert.equal(new Set(pages.map(page => page.path)).size, pages.length)
})

test('document drafts preserve linked lines and expose only supported lifecycle routes', () => {
  for (const [path, idField, base, amend] of [
    ['/invoice', 'invoiceId', '/invoices', true], ['/order', 'orderId', '/orders', true],
    ['/receipt', 'receiptId', '/receipts', false], ['/payment', 'paymentId', '/payments', true],
    ['/voucher', 'journalId', '/vouchers', true], ['/stock-entry', 'stockEntryId', '/stock-entries', false],
    ['/material-request', 'requestId', '/material-requests', false], ['/asset', 'assetId', '/assets', false],
  ] as const) {
    const page = screen(path)
    const data = { ...context, document: { id: '10000000-0000-4000-8000-000000000001', docstatus: 'draft', kind: path === '/invoice' ? 'purchase' : 'purchase_order' } }
    const record = page.record?.(data)
    assert.equal(record?.docStatus?.idField, idField, path)
    assert.equal(record?.docStatus?.submit, `${base}/submit`, path)
    assert.equal(record?.docStatus?.amend, amend ? `${base}/amend` : undefined, path)
    const forms = page.sections(data).filter((section): section is PluginForm => section.kind === 'form')
    assert.ok(forms.some(form => form.path === base && form.fields.some(field => field.name === idField && field.value === data.document.id)), `${path} edits its own draft`)
    const submitted = page.sections({ ...data, document: { ...data.document, docstatus: 'submitted' } })
    assert.ok(!submitted.some(section => section.kind === 'form' && section.path === base), `${path} cannot edit submitted records`)
  }
  const invoice = screen('/invoice').sections({ ...context, document: { id: 'invoice-id', docstatus: 'draft', kind: 'sales' } }).find(section => section.kind === 'form' && section.path === '/invoices') as PluginForm
  const lines = invoice.fields.find(field => field.name === 'lines')!
  assert.equal(lines.value, 'editLines')
  for (const field of ['orderLineId', 'receiptLineId']) assert.equal(lines.columns?.find(column => column.name === field)?.kind, 'hidden')
})

test('staff entry points preserve office and administrator boundaries', () => {
  assert.ok(manifest.rolesWithAccess.includes('faculty'))
  for (const path of ['/my', '/approvals', '/material-requests', '/material-request/new', '/material-request']) assert.ok(screen(path).roles.includes('faculty'))
  for (const path of ['/invoices', '/payments', '/bank', '/assets', '/reports/aging']) assert.ok(!screen(path).roles.includes('faculty'))
  for (const path of ['/series', '/approval-rules', '/staff']) assert.deepEqual(screen(path).roles.slice().sort(), ['institution_admin', 'super_admin'])
})

test('every declared action uses a supported route and every filter targets a real page', () => {
  for (const path of paths) {
    const page = screen(path)
    for (const section of page.sections(context)) {
      if (section.kind === 'form') {
        if (section.method === 'GET') screen(section.path)
        else assert.ok(specs.some(route => route.method === (section.method ?? 'POST') && route.path === section.path), `${path}: ${section.path}`)
      }
    }
  }
})
