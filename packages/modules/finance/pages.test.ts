import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginForm } from '@campusos/module-framework'
import { pages } from './pages'
import { archiveAccountSchema } from './api/schemas'

const data = { office: true, admin: true, query: {}, from: '2026-10-01', to: '2026-10-05', on: '2026-10-05',
  accounts: [], years: [], settings: {}, rows: [], income: [], expense: [], assets: [], liabilities: [], funds: [],
  operating: { heads: [], netPaise: 0 }, investing: { heads: [], netPaise: 0 }, financing: { heads: [], netPaise: 0 },
  totals: {}, report: null, counts: {}, months: [], compare: false,
}
const screen = (path: string) => {
  const page = pages.find(candidate => candidate.path === path)
  assert.ok(page, path)
  return page
}

test('finance exposes accounting setup and six report screens while retaining existing operations', () => {
  for (const path of ['/', '/accounts', '/journal', '/periods', '/budgets', '/settings', '/reports', '/reports/trial-balance', '/reports/income-expenditure', '/reports/balance-sheet', '/reports/cash', '/reports/general-ledger', '/reports/day-book']) screen(path)
  assert.equal(new Set(pages.map(page => page.path)).size, pages.length)
  assert.ok(screen('/').title !== 'Trial balance')
})

test('finance workspace links only to declared pages that its accounts reader can open', () => {
  for (const section of screen('/').sections({ ...data, admin: false })) {
    const links = section.kind === 'shortcuts' ? section.items : section.kind === 'figures' ? section.figures : []
    for (const link of links) {
      if (!link.href) continue
      const path = new URL(link.href, 'https://college.test').pathname.replace('/m/finance', '') || '/'
      assert.ok(screen(path).roles.includes('accounts_staff'), link.href)
    }
  }
})

test('chart editing and fiscal-year actions retain administrator-only roles', () => {
  const chart = screen('/accounts').sections(data)
  const tree = chart.find(section => section.kind === 'table')
  assert.ok(tree?.kind === 'table' && tree.fixedOrder && tree.emphasis === 'isGroup')
  assert.equal(tree.columns[0]?.indent, 'depth')
  const forms = [...chart, ...screen('/settings').sections(data)].filter((section): section is PluginForm => section.kind === 'form' && section.method !== 'GET')
  for (const form of forms) assert.deepEqual(form.roles?.slice().sort(), ['institution_admin', 'super_admin'])
  for (const path of ['/accounts', '/accounts/update', '/accounts/archive', '/settings', '/fiscal-years/close', '/fiscal-years/reopen']) assert.ok(forms.some(form => form.path === path), path)
})

test('reports submit filters to their own pages and keep accounting row order', () => {
  for (const path of ['/reports/trial-balance', '/reports/income-expenditure', '/reports/balance-sheet', '/reports/cash', '/reports/general-ledger', '/reports/day-book']) {
    const sections = screen(path).sections(data)
    assert.ok(sections.some(section => section.kind === 'form' && section.method === 'GET' && section.path === path), path)
    for (const section of sections) if (section.kind === 'table') assert.equal(section.fixedOrder, true)
  }
  assert.ok(screen('/reports/general-ledger').sections(data).some(section => section.kind === 'note' && /account/i.test(section.text)))
})

test('account archive accepts the host checkbox strings and preserves false', () => {
  const accountId = '10000000-0000-4000-8000-000000000001'
  assert.equal(archiveAccountSchema.parse({ accountId, archived: 'true' }).archived, true)
  assert.equal(archiveAccountSchema.parse({ accountId, archived: 'false' }).archived, false)
})
