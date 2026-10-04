import { accountPurposes, accountTypes, getSettings, listAccounts, listFiscalYears } from '../api'
import { accountSubtypes } from '../schema/ledger'
import { ADMIN, OFFICE, as } from './kit'
import { action, pick, reportTable, screen, treeColumns, values } from './report-kit'

const classifications = () => [pick('parentCode', 'Parent group', 'groupOptions'), pick('subtype', 'Subtype', values(accountSubtypes)), pick('purpose', 'Posting purpose', values(accountPurposes)), pick('cashFlow', 'Cash flow activity', values(['operating', 'investing', 'financing'])), { name: 'description', label: 'Description', optional: true }]

export const accountingPages = [
  screen({
    path: '/accounts', title: 'Chart of accounts', menu: 'Accounts', roles: OFFICE,
    async load(actor) {
      const accounts = await listAccounts(as(actor))
      return { accounts: accounts.map(account => ({ ...account, status: account.archivedAt ? 'closed' : 'active', ledgerLabel: account.isGroup ? '' : 'View ledger' })),
        accountOptions: accounts.map(account => ({ value: account.id, label: `${account.code} · ${account.name}` })),
        groupOptions: accounts.filter(account => account.isGroup && !account.archivedAt).map(account => ({ value: account.code, label: `${account.code} · ${account.name}` })),
      }
    },
    sections: () => [
      { kind: 'note', text: 'A purpose tells fees, payroll and other modules which account to post to. Changing a purpose moves future postings. Groups collect their child accounts; postings belong to leaf accounts.' },
      reportTable('Chart of accounts', 'accounts', [...treeColumns, { key: 'type', label: 'Type' }, { key: 'subtype', label: 'Subtype' }, { key: 'purpose', label: 'Purpose' }, { key: 'cashFlow', label: 'Cash flow' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'ledgerLabel', label: 'Ledger', href: '/m/finance/reports/general-ledger?accountId={id}' }], { emphasis: 'isGroup', empty: 'No accounts yet.' }),
      action('Add account', '/accounts', [{ name: 'code', label: 'Code' }, { name: 'name', label: 'Name' }, pick('type', 'Type', values(accountTypes), undefined, false), ...classifications(), { name: 'isGroup', label: 'This is a group account', kind: 'checkbox' }, { name: 'currency', label: 'Currency', optional: true, hint: 'Three-letter code, for example USD; leave blank for the base currency.' }]),
      action('Change account', '/accounts/update', [pick('accountId', 'Account', 'accountOptions', undefined, false), { name: 'name', label: 'Name', optional: true }, ...classifications()]),
      action('Close or reopen account', '/accounts/archive', [pick('accountId', 'Account', 'accountOptions', undefined, false), { name: 'archived', label: 'Closed to new postings', kind: 'checkbox' }]),
    ],
  }),
  screen({
    path: '/settings', title: 'Settings and fiscal years', menu: 'Settings', roles: OFFICE,
    async load(actor) {
      const [settings, years] = await Promise.all([getSettings(as(actor)), listFiscalYears(as(actor))])
      return { settings, years, admin: ADMIN.includes(actor.role), settingRows: [
        { label: 'Legal name', value: settings.legalName }, { label: 'Base currency', value: settings.baseCurrency }, { label: 'Fiscal year starts in month', value: settings.fiscalYearStartMonth },
        { label: 'Time zone', value: settings.timeZone }, { label: 'Stock valuation', value: settings.stockValuation },
      ], openYears: years.filter(year => year.status === 'open').map(year => ({ value: year.label, label: year.label })), closedYears: years.filter(year => year.status === 'closed').map(year => ({ value: year.label, label: year.label })) }
    },
    sections: data => [
      { kind: 'note', text: 'Base currency and the fiscal-year starting month can only change before the first posting. Closing a year carries its surplus into retained surplus; only the latest closed year can be reopened.' },
      reportTable('Institution books', 'settingRows', [{ key: 'label', label: 'Setting' }, { key: 'value', label: 'Value' }]),
      { ...action('Save accounting settings', '/settings', [
        ...(['legalName', 'address', 'gstin', 'stateCode', 'pan', 'tan', 'baseCurrency', 'timeZone'] as const).map(name => ({ name, label: ({ legalName: 'Legal name', address: 'Address', gstin: 'GSTIN', stateCode: 'GST state code', pan: 'PAN', tan: 'TAN', baseCurrency: 'Base currency', timeZone: 'Time zone' })[name], optional: true, value: data.settings[name] ?? '' })),
        { name: 'fiscalYearStartMonth', label: 'Fiscal year starts in month (1–12)', kind: 'number', optional: true, value: String(data.settings.fiscalYearStartMonth) },
        { name: 'roundInvoices', label: 'Round invoice totals', kind: 'checkbox', value: String(data.settings.roundInvoices) },
        pick('stockValuation', 'Stock valuation', values(['moving_average', 'fifo']), data.settings.stockValuation),
        { name: 'allowNegativeStock', label: 'Allow negative stock', kind: 'checkbox', value: String(data.settings.allowNegativeStock) },
        { name: 'overReceiptPercent', label: 'Over-receipt tolerance (%)', kind: 'number', optional: true, step: '0.01', value: String(data.settings.overReceiptBp / 100) },
        { name: 'blockExpiredBatches', label: 'Block expired batches', kind: 'checkbox', value: String(data.settings.blockExpiredBatches) },
      ]), placement: 'inline' },
      reportTable('Fiscal years', 'years', [{ key: 'label', label: 'Year' }, { key: 'startsOn', label: 'Starts', kind: 'date' }, { key: 'endsOn', label: 'Ends', kind: 'date' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'closedAt', label: 'Closed', kind: 'when' }, { key: 'reopenedReason', label: 'Reopened because' }]),
      action('Close fiscal year', '/fiscal-years/close', [pick('label', 'Open fiscal year', 'openYears', undefined, false)]),
      action('Reopen fiscal year', '/fiscal-years/reopen', [pick('label', 'Closed fiscal year', 'closedYears', undefined, false), { name: 'reason', label: 'Reason', kind: 'textarea' }]),
    ],
  }),
]
