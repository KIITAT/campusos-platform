import type { PluginColumn, PluginPage, PluginSection } from '@campusos/module-framework'
import { formatPaise } from '@campusos/money'
import { OFFICE } from './kit'
import { chooseRecord, col, context, dateFields, display, field, filter, href, linkCol, moneyCols, object, page, read, rows, select, shortcuts, str, table, tabs, type Data } from './screen-kit'

export const extraReportLinks = [
  ['Aging of receivables and payables', '/reports/aging'], ['Funds and grants', '/reports/funds'], ['Fund statement', '/reports/fund'], ['Cost centres', '/reports/cost-centers'], ['GST and TDS', '/reports/gst'], ['Stock balance', '/stock/balance'], ['Stock ledger', '/stock/ledger'], ['Stores against books', '/stock/against-books'], ['Asset register', '/assets'], ['Depreciation', '/depreciation'],
].map(([label, path]) => ({ label: label!, href: `/m/finance${path}` }))
const gstLinks = [['GSTR-1', '/reports/gstr1'], ['GSTR-3B', '/reports/gstr3b'], ['HSN / SAC summary', '/reports/hsn'], ['Sales and purchase register', '/reports/register'], ['TDS', '/reports/tds']]
const taxColumns = () => moneyCols('taxablePaise', 'igstPaise', 'cgstPaise', 'sgstPaise', 'cessPaise')
const hsnColumns = () => [col('hsnSac'), col('uom'), col('qtyMilliText', undefined, { label: 'Quantity' }), ...taxColumns()]
const exportCsv = (report: string, data: Data): PluginSection => ({ kind: 'links', links: [{ label: 'Download CSV', href: `/api/v1/modules/finance/reports/export.csv?${new URLSearchParams({ ...Object.fromEntries(Object.entries(object(data.query)).map(([key, value]) => [key, str(value)])), report, from: str(data.from), to: str(data.to), on: str(data.on) })}` }] })
const fundColumns = [col('code'), col('name', undefined, { href: '/m/finance/reports/fund?fundId={fundId}' }), col('kind'), ...moneyCols('sanctionedPaise', 'receivedPaise', 'spentPaise', 'balancePaise')]

export const extraReportPages: PluginPage[] = [
  page({ path: '/reports/aging', title: 'Receivable and payable aging', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request)
      const query: Data = { side: 'receivable', ...object(data.query) }
      const report = object(await read(actor, '/reports/aging', { ...query, on: data.on }))
      const flatten = (buckets: unknown) => Object.fromEntries((Array.isArray(buckets) ? buckets : []).map((value, index) => [`bucket${index}`, value]))
      return { ...data, ...report, query, rows: rows(report.rows).map(row => ({ ...row, ...flatten(row.buckets) })), invoices: query.partyId ? rows(report.rows).flatMap(row => rows(row.invoices)) : [], footer: { name: 'Total', ...flatten(report.totals), advancePaise: report.advancePaise, totalPaise: report.totalPaise } }
    },
    sections: data => [filter('/reports/aging', data, [select('side', ['receivable', 'payable'], { value: 'receivable' }), ...dateFields('on'), select('partyId', 'parties')]), table('Aging by party', 'rows', [linkCol('name', '/party', 'partyId'), ...(Array.isArray(data.bucketLabels) ? data.bucketLabels : []).map((label, index) => col(`bucket${index}`, 'money', { label: str(label) })), ...moneyCols('advancePaise', 'totalPaise')], { footer: 'footer' }), ...(object(data.query).partyId ? [table('Open invoices', 'invoices', [linkCol('number', '/invoice'), col('postingDate', 'date'), col('dueDate', 'date'), col('days', 'days'), ...moneyCols('openPaise')])] : []), exportCsv('aging', data)],
  }),
  page({ path: '/reports/funds', title: 'Fund balances', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); return { ...data, rows: rows(await read(actor, '/reports/funds', { on: data.on })) } },
    sections: data => [filter('/reports/funds', data, dateFields('on')), table('Funds', 'rows', fundColumns)],
  }),
  page({ path: '/reports/fund', title: 'Fund statement', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); const query = object(data.query); const report = query.fundId ? object(await read(actor, '/reports/fund-statement', { fundId: query.fundId, from: data.from, to: data.to })) : null; return { ...data, ...report, report } },
    sections: data => [filter('/reports/fund', data, [select('fundId', 'funds', { optional: false }), ...dateFields('from', 'to')]), ...(data.report ? [
      { kind: 'figures' as const, figures: ['openingPaise', 'receivedPaise', 'spentPaise', 'capitalPaise', 'closingPaise', 'sanctionedPaise'].map(key => ({ label: field(key.replace('Paise', '')).label, value: data[key] === null ? 'Not specified' : formatPaise(Number(data[key] ?? 0)) })).concat([{ label: 'Utilised', value: data.utilisedPercent === null ? 'Not applicable' : `${data.utilisedPercent}%` }]) },
      table('Received', 'received', [col('code'), col('name'), ...moneyCols('amountPaise')]), table('Spent by head', 'spent', [col('code'), col('name'), ...moneyCols('amountPaise')]),
    ] : [chooseRecord])],
  }),
  page({ path: '/reports/cost-centers', title: 'Income and expenditure by cost centre', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); return { ...data, ...object(await read(actor, '/reports/cost-centers', { from: data.from, to: data.to })) } },
    sections: data => [filter('/reports/cost-centers', data, dateFields('from', 'to')), table('Cost centres', 'rows', [col('costCenter'), col('name'), ...moneyCols('incomePaise', 'expensePaise', 'netPaise')])],
  }),
  page({ path: '/reports/gst', title: 'GST and TDS reports', roles: OFFICE,
    load: context,
    sections: data => [filter('/reports/gst', data, dateFields('from', 'to')), shortcuts('Tax reports', gstLinks.map(([label, path]) => ({ label: label!, href: href(path!, { from: data.from, to: data.to }) })))],
  }),
  page({ path: '/reports/gstr1', title: 'GSTR-1', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request)
      const report = object(await read(actor, '/reports/gstr1', { from: data.from, to: data.to }))
      const tables = ['b2b', 'sez', 'b2cl', 'b2cs', 'exports', 'cdnr', 'cdnur', 'nil', 'hsn', 'documents']
      const selected = tables.includes(str(object(data.query).table)) ? str(object(data.query).table) : 'b2b'
      return { ...data, query: { ...object(data.query), table: selected }, selected, rows: (selected === 'nil' ? [object(report.nil)] : rows(report[selected])).map(row => display(row, data)) }
    },
    sections: data => {
      const selected = str(data.selected || 'b2b')
      let columns: PluginColumn[] = [linkCol('number', '/invoice', 'invoiceId'), col('date', 'date'), col('party'), col('gstin'), col('placeOfSupply'), col('ratePercent'), ...taxColumns(), ...moneyCols('invoiceValuePaise'), col('originalNumber'), col('originalDate', 'date')]
      if (selected === 'b2cs') columns = [col('placeOfSupply'), col('ratePercent'), ...taxColumns()]
      if (selected === 'nil') columns = moneyCols('nilRatedPaise', 'exemptPaise', 'nonGstPaise')
      if (selected === 'hsn') columns = hsnColumns()
      if (selected === 'documents') columns = [col('nature'), col('first'), col('last'), col('total'), col('cancelled')]
      return [filter('/reports/gstr1', data, [...dateFields('from', 'to'), select('table', ['b2b', 'sez', 'b2cl', 'b2cs', 'exports', 'cdnr', 'cdnur', 'nil', 'hsn', 'documents'])]), tabs('/reports/gstr1', { ...object(data.query), from: data.from, to: data.to }, 'table', ['b2b', 'sez', 'b2cl', 'b2cs', 'exports', 'cdnr', 'cdnur', 'nil', 'hsn', 'documents']), table(selected.toUpperCase(), 'rows', columns), ...(['b2b', 'sez', 'b2cl', 'b2cs', 'exports', 'cdnr', 'cdnur'].includes(selected) ? [exportCsv('gstr1', data)] : [])]
    },
  }),
  page({ path: '/reports/gstr3b', title: 'GSTR-3B', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request); const report = object(await read(actor, '/reports/gstr3b', { from: data.from, to: data.to }))
      return { ...data, outward: Object.entries(object(report['3.1'])).map(([name, value]) => ({ name, ...object(value) })), input: Object.entries(object(report['4'])).map(([name, value]) => ({ name, ...object(value) })), exempt: [object(report['5'])], payable: [object(report.payable)] }
    },
    sections: data => [filter('/reports/gstr3b', data, dateFields('from', 'to')), table('3.1 Outward supplies and reverse charge', 'outward', [col('name'), ...taxColumns()]), table('4 Input tax credit', 'input', [col('name'), ...taxColumns()]), table('5 Exempt inward supplies', 'exempt', moneyCols('intraStatePaise', 'interStatePaise')), table('Tax payable', 'payable', taxColumns().filter(column => column.key !== 'taxablePaise'))],
  }),
  ...['hsn', 'register'].map(report => page({ path: `/reports/${report}`, title: report === 'hsn' ? 'HSN / SAC summary' : 'Sales and purchase register', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); const query = { kind: 'sales', ...object(data.query) }; return { ...data, query, rows: rows(await read(actor, `/reports/${report}`, { ...query, from: data.from, to: data.to })).map(row => display(row, data)) } },
    sections: data => [filter(`/reports/${report}`, data, [select('kind', ['sales', 'purchase']), ...dateFields('from', 'to')]), table(report === 'hsn' ? 'HSN / SAC totals' : 'Invoice register', 'rows', report === 'hsn' ? hsnColumns() : [linkCol('number', '/invoice', 'invoiceId'), col('date', 'date'), col('isReturn', 'bool'), col('party'), col('gstin'), col('placeOfSupply'), col('reverseCharge', 'bool'), ...taxColumns(), ...moneyCols('totalPaise')]), exportCsv(report, data)],
  })),
  page({ path: '/reports/tds', title: 'Tax deducted at source', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); return { ...data, ...object(await read(actor, '/reports/tds', { from: data.from, to: data.to })) } },
    sections: data => [filter('/reports/tds', data, dateFields('from', 'to')), ...(Number(data.rowsWithoutPan) > 0 ? [{ kind: 'note' as const, tone: 'warn' as const, text: `${data.rowsWithoutPan} rows lack PAN; check the higher rate before filing.` }] : []), table('TDS deducted', 'deducted', [col('section'), col('party'), col('pan'), ...moneyCols('paidPaise', 'tdsPaise'), col('documents')]), { kind: 'figures', figures: [{ label: 'Total deducted', value: formatPaise(Number(data.deductedPaise ?? 0)) }] }, table('TDS deducted by customers', 'deductedByOthers', [col('party'), ...moneyCols('tdsPaise'), col('receipts')]), exportCsv('tds', data)],
  }),
]
