import { formatPaise } from '@campusos/money'
import { dashboard } from '../api'
import { ADMIN, OFFICE, as } from './kit'
import { ROOT, reportLinks, screen } from './report-kit'

export const workspacePage = screen({
  path: '/', title: 'Accounts workspace', menu: 'Overview', roles: OFFICE,
  async load(actor) { return { ...await dashboard(as(actor)), admin: ADMIN.includes(actor.role) } },
  sections: data => [
    { kind: 'figures', title: `Fiscal year ${data.fiscalYear}, to ${data.on}`, figures: [
      { label: 'Cash and bank', value: formatPaise(data.cashPaise ?? 0), href: `${ROOT}/reports/cash` },
      { label: 'Owed to us', value: formatPaise(data.receivablePaise ?? 0) }, { label: 'We owe', value: formatPaise(data.payablePaise ?? 0) },
      { label: (data.surplusPaise ?? 0) < 0 ? 'Deficit so far' : 'Surplus so far', value: formatPaise(Math.abs(data.surplusPaise ?? 0)), tone: (data.surplusPaise ?? 0) < 0 ? 'due' : 'clear', href: `${ROOT}/reports/income-expenditure` },
    ] },
    { kind: 'chart', title: 'Income and expenditure by month', type: 'bar', rows: 'months', x: 'month', unit: 'money', series: [{ key: 'incomePaise', label: 'Income' }, { key: 'expensePaise', label: 'Expenditure' }], empty: 'No postings this year yet.' },
    { kind: 'shortcuts', title: 'Statements and ledgers', items: reportLinks },
    { kind: 'shortcuts', title: 'Keep the books', items: [
      { label: 'Chart of accounts', href: `${ROOT}/accounts`, description: 'The account tree and posting purposes' },
      { label: 'Settings and fiscal years', href: `${ROOT}/settings`, description: 'Institution details and year-end close' },
      ...(data.admin ? [{ label: 'Posted journal', href: `${ROOT}/journal` }, { label: 'Period close', href: `${ROOT}/periods` }, { label: 'Budgets', href: `${ROOT}/budgets` }] : []),
    ] },
  ],
})
