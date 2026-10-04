import { formatPaise } from '@campusos/money'
import { balanceSheet, cashMovements, dayBook, generalLedger, incomeAndExpenditure, trialBalanceReport } from '../api'
import { OFFICE, as } from './kit'
import { extraReportLinks } from './extra-reports'
import { ROOT, costFilter, csv, filters, fundFilter, ledgerColumn, money, partyChoices, pick, reportContext, reportLinks, reportTable, screen, treeColumns, values, withLedger } from './report-kit'

export const reportPages = [
  screen({ path: '/reports', title: 'Financial reports', menu: 'Reports', roles: OFFICE, async load() { return {} }, sections: () => [{ kind: 'shortcuts', title: 'Statements and ledgers', items: reportLinks }, { kind: 'shortcuts', title: 'Parties, tax, stock and assets', items: extraReportLinks }] }),
  screen({
    path: '/reports/trial-balance', title: 'Trial balance', roles: OFFICE,
    async load(actor, request) {
      const data = await reportContext(actor, request)
      const report = await trialBalanceReport(as(actor), { from: data.from, to: data.to, fundId: data.query.fundId, costCenter: data.query.costCenter })
      return { ...data, ...report, rows: withLedger(report.rows), totalsRow: { name: 'Period totals', debitPaise: report.totals.debitPaise, creditPaise: report.totals.creditPaise } }
    },
    sections: data => [
      filters('/reports/trial-balance', data, [fundFilter(data), costFilter(data)]),
      { kind: 'figures', figures: [
        { label: 'Opening debits', value: formatPaise(data.totals.openingDebitPaise ?? 0) }, { label: 'Opening credits', value: formatPaise(data.totals.openingCreditPaise ?? 0) },
        { label: 'Closing debits', value: formatPaise(data.totals.closingDebitPaise ?? 0) }, { label: 'Closing credits', value: formatPaise(data.totals.closingCreditPaise ?? 0) },
      ] },
      reportTable('Trial balance', 'rows', [...treeColumns, money('openingPaise', 'Opening'), money('debitPaise', 'Debits'), money('creditPaise', 'Credits'), money('closingPaise', 'Closing'), ledgerColumn(data)], { emphasis: 'isGroup', footer: 'totalsRow' }),
      csv('trial-balance', { ...data.query, from: data.from, to: data.to }),
    ],
  }),
  screen({
    path: '/reports/income-expenditure', title: 'Income and expenditure', roles: OFFICE,
    async load(actor, request) {
      const data = await reportContext(actor, request)
      const compare = data.query.compare === 'true'
      const report = await incomeAndExpenditure(as(actor), { from: data.from, to: data.to, fundId: data.query.fundId, costCenter: data.query.costCenter, compare })
      return { ...data, ...report, compare }
    },
    sections: data => [
      filters('/reports/income-expenditure', data, [fundFilter(data), costFilter(data), { name: 'compare', label: 'Compare with the same period last year', kind: 'checkbox', value: String(data.compare) }]),
      ...(['income', 'expense'] as const).map(rows => reportTable(rows === 'income' ? 'Income' : 'Expenditure', rows, [...treeColumns, money('amountPaise', 'Amount'), ...(data.compare ? [money('previousPaise', 'Previous year')] : [])], { emphasis: 'isGroup' })),
      { kind: 'figures', figures: [
        { label: 'Total income', value: formatPaise(data.incomePaise ?? 0) }, { label: 'Total expenditure', value: formatPaise(data.expensePaise ?? 0) },
        { label: (data.surplusPaise ?? 0) < 0 ? 'Deficit' : 'Surplus', value: formatPaise(Math.abs(data.surplusPaise ?? 0)), tone: (data.surplusPaise ?? 0) < 0 ? 'due' : 'clear' },
      ] },
    ],
  }),
  screen({
    path: '/reports/balance-sheet', title: 'Balance sheet', roles: OFFICE,
    async load(actor, request) {
      const data = await reportContext(actor, request)
      return { ...data, ...await balanceSheet(as(actor), { on: data.on, fundId: data.query.fundId }) }
    },
    sections: data => [
      filters('/reports/balance-sheet', data, [fundFilter(data)], true),
      ...(['assets', 'liabilities', 'funds'] as const).map(rows => reportTable(rows[0]!.toUpperCase() + rows.slice(1), rows, [...treeColumns, money('closingPaise', 'Balance')], { emphasis: 'isGroup' })),
      { kind: 'figures', figures: [
        { label: 'Assets', value: formatPaise(data.assetsPaise ?? 0) }, { label: 'Liabilities', value: formatPaise(data.liabilitiesPaise ?? 0) },
        { label: 'Funds including unclosed result', value: formatPaise(data.fundsPaise ?? 0) }, { label: 'Unclosed surplus / deficit', value: formatPaise(data.unclosedSurplusPaise ?? 0) },
        { label: 'Difference', value: formatPaise(data.differencePaise ?? 0), tone: data.differencePaise ? 'due' : 'clear' },
      ] },
      ...(data.differencePaise ? [{ kind: 'note' as const, tone: 'danger' as const, text: 'Assets do not equal liabilities and funds. Investigate the difference before relying on this statement.' }] : []),
    ],
  }),
  screen({
    path: '/reports/cash', title: 'Receipts, payments and cash flow', roles: OFFICE,
    async load(actor, request) {
      const data = await reportContext(actor, request)
      const report = await cashMovements(as(actor), { from: data.from, to: data.to, fundId: data.query.fundId })
      return { ...data, ...report, operatingRows: report.operating.heads, investingRows: report.investing.heads, financingRows: report.financing.heads }
    },
    sections: data => [
      filters('/reports/cash', data, [fundFilter(data), pick('view', 'View', values(['rp', 'cf']).map(option => ({ ...option, label: option.value === 'rp' ? 'Receipts and payments' : 'Cash flow by activity' })), data.query.view || 'rp', false)]),
      { kind: 'links', links: ['rp', 'cf'].map(view => ({ label: view === 'rp' ? 'Receipts and payments' : 'Cash flow', href: `${ROOT}/reports/cash?${new URLSearchParams({ ...data.query, from: data.from, to: data.to, view })}`, active: (data.query.view || 'rp') === view })) },
      { kind: 'figures', figures: [{ label: 'Opening cash and bank', value: formatPaise(data.openingPaise ?? 0) }, { label: 'Closing cash and bank', value: formatPaise(data.closingPaise ?? 0) }] },
      ...(data.query.view === 'cf' ? (['operating', 'investing', 'financing'] as const).flatMap(activity => [
        reportTable(activity[0]!.toUpperCase() + activity.slice(1), `${activity}Rows`, [{ key: 'name', label: 'Head' }, money('receivedPaise', 'Received'), money('paidPaise', 'Paid')]),
        { kind: 'figures' as const, figures: [{ label: `Net ${activity}`, value: formatPaise(data[activity].netPaise) }] },
      ]) : [
        reportTable('Receipts', 'receipts', [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Head' }, money('receivedPaise', 'Received')]),
        reportTable('Payments', 'payments', [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Head' }, money('paidPaise', 'Paid')]),
      ]),
    ],
  }),
  screen({
    path: '/reports/general-ledger', title: 'General ledger', roles: OFFICE,
    async load(actor, request) {
      const data = await reportContext(actor, request)
      const [parties, report] = await Promise.all([partyChoices(actor), data.query.accountId ? generalLedger(as(actor), { accountId: data.query.accountId, from: data.from, to: data.to, partyId: data.query.partyId, costCenter: data.query.costCenter }) : null])
      return { ...data, partyOptions: parties, report, lines: report?.lines ?? [] }
    },
    sections: data => [
      filters('/reports/general-ledger', data, [pick('accountId', 'Account', 'accountOptions', data.query.accountId, false), pick('partyId', 'Party', 'partyOptions', data.query.partyId), costFilter(data)]),
      ...(data.report ? [
        { kind: 'figures' as const, figures: [{ label: 'Opening', value: formatPaise(data.report.openingPaise) }, { label: 'Closing', value: formatPaise(data.report.closingPaise) }] },
        reportTable(`${data.report.account.code} · ${data.report.account.name}`, 'lines', [
          { key: 'postingDate', label: 'Date', kind: 'date' }, { key: 'memo', label: 'Entry' }, { key: 'lineMemo', label: 'Line note' }, { key: 'account', label: 'Account' },
          { key: 'party', label: 'Party' }, { key: 'costCenter', label: 'Cost centre' }, { key: 'sourceModule', label: 'Source' }, money('debitPaise', 'Debit'), money('creditPaise', 'Credit'), money('balancePaise', 'Balance'),
        ]), csv('general-ledger', { ...data.query, from: data.from, to: data.to }),
      ] : [{ kind: 'note' as const, text: 'Choose an account to read its postings. Group accounts include all their leaf accounts.' }]),
    ],
  }),
  screen({
    path: '/reports/day-book', title: 'Day book', roles: OFFICE,
    async load(actor, request) {
      const data = await reportContext(actor, request)
      const report = await dayBook(as(actor), { from: data.from, to: data.to, sourceModule: data.query.sourceModule })
      return { ...data, rows: report.entries.flatMap(entry => entry.lines.map((line, index) => ({ ...line,
        entryId: entry.id, postingDate: index === 0 ? entry.postingDate : '', memo: index === 0 ? entry.memo : '', sourceModule: index === 0 ? entry.sourceModule : '',
        reversal: index === 0 && entry.reversal, entryStart: index === 0,
      }))) }
    },
    sections: data => [
      filters('/reports/day-book', data, [{ name: 'sourceModule', label: 'Source module', optional: true, value: data.query.sourceModule }]),
      reportTable('Journal lines', 'rows', [{ key: 'postingDate', label: 'Date', kind: 'date' }, { key: 'memo', label: 'Entry' }, { key: 'sourceModule', label: 'Source' }, { key: 'account', label: 'Account' }, { key: 'party', label: 'Party' }, { key: 'costCenter', label: 'Cost centre' }, money('debitPaise', 'Debit'), money('creditPaise', 'Credit'), { key: 'reversal', label: 'Reversal', kind: 'bool' }], { emphasis: 'entryStart' }),
    ],
  }),
]
