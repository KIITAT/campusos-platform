import type { PluginPage } from '@campusos/module-framework'
import { formatPaise } from '@campusos/money'
import { dashboard } from '../api'
import { as, OFFICE, STAFF } from './kit'

/**
 * The way into the books: where the money is, what is owed each way, the
 * year so far, and the work waiting -- each a link to the place it is done.
 */
export const homePages: PluginPage[] = [
  {
    path: '/',
    title: 'Accounts',
    menu: 'Home',
    roles: [...OFFICE],
    async load(actor) {
      const d = await dashboard(as(actor))
      return { ...d, ...Object.fromEntries(Object.entries(d.counts).map(([k, v]) => [k, String(v)])) }
    },
    sections: (data) => {
      const n = (k: string) => Number(data[k] ?? 0)
      const tone = (k: string) => (n(k) > 0 ? ('orange' as const) : ('gray' as const))
      return [
        {
          kind: 'figures',
          title: `Fiscal year ${String(data.fiscalYear)}, to ${String(data.on)}`,
          figures: [
            { label: 'Cash and bank', value: formatPaise(Number(data.cashPaise)), href: '/m/finance/bank' },
            { label: 'Owed to us', value: formatPaise(Number(data.receivablePaise)), href: '/m/finance/reports/aging?side=receivable' },
            { label: 'We owe', value: formatPaise(Number(data.payablePaise)), href: '/m/finance/reports/aging?side=payable' },
            {
              label: Number(data.surplusPaise) >= 0 ? 'Surplus so far' : 'Deficit so far',
              value: formatPaise(Math.abs(Number(data.surplusPaise))),
              tone: Number(data.surplusPaise) >= 0 ? 'clear' : 'due',
              href: '/m/finance/reports/income-expenditure',
            },
          ],
        },
        {
          kind: 'shortcuts',
          title: 'Waiting',
          items: [
            { label: 'Draft invoices', href: '/m/finance/invoices?status=draft', count: String(n('draft_invoices')), tone: tone('draft_invoices') },
            { label: 'Customers overdue', href: '/m/finance/invoices?kind=sales&status=overdue', count: String(n('overdue_sales')), tone: n('overdue_sales') ? 'red' : 'gray' },
            { label: 'Bills due to pay', href: '/m/finance/invoices?kind=purchase&status=open', count: String(n('bills_due')), tone: tone('bills_due') },
            { label: 'Bank lines to match', href: '/m/finance/bank', count: String(n('unmatched')), tone: tone('unmatched') },
            { label: 'Requests to the stores', href: '/m/finance/material-requests', count: String(n('requests')), tone: tone('requests') },
            { label: 'Items to reorder', href: '/m/finance/stock/reorder', count: String(n('reorder')), tone: tone('reorder') },
            { label: 'Depreciation due', href: '/m/finance/depreciation', count: String(n('depreciation_due')), tone: tone('depreciation_due') },
            { label: 'Recurring invoices due', href: '/m/finance/recurring', count: String(n('recurring_due')), tone: tone('recurring_due') },
          ],
        },
        {
          kind: 'chart',
          title: 'Income and expenditure, month by month',
          type: 'bar',
          rows: 'months',
          x: 'month',
          unit: 'money',
          series: [
            { key: 'incomePaise', label: 'Income' },
            { key: 'expensePaise', label: 'Expenditure' },
          ],
          empty: 'Nothing posted this year yet.',
        },
        {
          kind: 'shortcuts',
          title: 'Do',
          items: [
            { label: 'Raise an invoice', href: '/m/finance/invoice/new?kind=sales', description: 'To a customer, with GST' },
            { label: 'Enter a supplier bill', href: '/m/finance/invoice/new?kind=purchase', description: 'With tax deducted at source' },
            { label: 'Record money received', href: '/m/finance/payment/new?kind=receive' },
            { label: 'Record a payment', href: '/m/finance/payment/new?kind=pay' },
            { label: 'Journal voucher', href: '/m/finance/voucher/new' },
            { label: 'Purchase order', href: '/m/finance/order/new?kind=purchase_order' },
            { label: 'Receive or issue stock', href: '/m/finance/stock-entry/new?kind=receipt' },
            { label: 'Import a bank statement', href: '/m/finance/bank' },
          ],
        },
        {
          kind: 'shortcuts',
          title: 'Read',
          items: [
            { label: 'Trial balance', href: '/m/finance/reports/trial-balance' },
            { label: 'Income and expenditure', href: '/m/finance/reports/income-expenditure' },
            { label: 'Balance sheet', href: '/m/finance/reports/balance-sheet' },
            { label: 'Receipts and payments, cash flow', href: '/m/finance/reports/cash' },
            { label: 'GST returns', href: '/m/finance/reports/gst' },
            { label: 'All reports', href: '/m/finance/reports' },
          ],
        },
      ]
    },
  },
  {
    // Staff who are not in the accounts office come here for what is theirs:
    // asking the stores for something.
    path: '/my',
    title: 'Stores and purchasing',
    roles: [...STAFF],
    async load() {
      return {}
    },
    sections: () => [
      {
        kind: 'shortcuts',
        items: [
          { label: 'Ask the stores for something', href: '/m/finance/material-request/new', description: 'From stock, or to be bought' },
          { label: 'My requests', href: '/m/finance/material-requests?mine=true' },
        ],
      },
    ],
  },
]
