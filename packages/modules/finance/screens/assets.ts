import type { PluginPage } from '@campusos/module-framework'
import { formatPaise } from '@campusos/money'
import { ADMIN, OFFICE } from './kit'
import { documentPages } from './documents'
import { checks, col, context, dateFields, dimensions, display, field, filter, form, hidden, linkCol, moneyCols, moneyFields, object, page, read, rows, select, table } from './screen-kit'

const assetDocuments = documentPages({ path: '/asset', base: '/assets', key: 'asset', idField: 'assetId', entity: 'finance_asset', title: 'Asset', menu: 'Assets', filters: [...dateFields('on'), select('categoryId', 'categories')],
  fields: () => [field('name', 'text', { optional: false }), select('categoryId', 'categories', { optional: false }), select('itemId', 'assetItems'), field('purchasedOn', 'date', { optional: false }), ...dateFields('inUseOn'), field('gross', 'money', { optional: false }), ...checks('existing'), field('openingAccumulated', 'money'), ...dateFields('depreciateFrom'), select('creditAccountId', 'accounts'), select('locationId', 'warehouses'), select('custodianId', 'staff'), ...dimensions(), ...dateFields('warrantyTill', 'insuredTill'), field('tagCode'), field('note', 'textarea')],
  listColumns: [linkCol('number', '/asset'), col('name'), col('category'), col('inUseOn', 'date'), ...moneyCols('grossPaise', 'accumulatedPaise', 'netPaise'), col('location'), col('custodian'), col('tagCode'), col('status', 'status')],
  async prepare(_actor, data) { return { ...data, schedule: rows(data.schedule).map(row => ({ ...row, posted: !!row.entryId })) } },
  actions: data => {
    const document = object(data.document)
    return [{ kind: 'figures', figures: [{ label: 'Gross cost', value: formatPaise(Number(document.grossPaise ?? 0)) }, { label: 'Accumulated depreciation', value: formatPaise(Number(data.accumulatedPaise ?? 0)) }, { label: 'Net book value', value: formatPaise(Number(data.netPaise ?? 0)) }] },
      table('Depreciation schedule', 'schedule', [col('periodEnd', 'date'), ...moneyCols('amountPaise', 'accumulatedAfterPaise'), col('posted', 'bool')], { fixedOrder: true }),
      table('Asset events', 'events', [col('on', 'date'), col('kind'), col('note'), col('finding'), ...moneyCols('costPaise', 'amountPaise'), col('recordedByName')]),
      ...(document.docstatus === 'submitted' ? [form('Record asset event', '/assets/events', [hidden('assetId', document.id), select('kind', ['transfer', 'maintenance', 'verification', 'impairment', 'sold', 'scrapped'], { optional: false }), ...dateFields('on'), field('note', 'textarea'), select('toLocationId', 'warehouses'), select('toCustodianId', 'staff'), select('toCostCenter', 'costCenters'), ...moneyFields('cost', 'amount'), select('vendorId', 'suppliers'), ...dateFields('nextDueOn'), select('finding', ['found', 'elsewhere', 'missing']), select('proceedsAccountId', 'accounts')])] : []),
    ]
  },
})

export const assetPages: PluginPage[] = [
  ...assetDocuments.map(spec => spec.path === '/assets' ? { ...spec,
    async load(actor, request) { const data = await spec.load(actor, request); return { ...data, totals: { name: 'Total', ...Object.fromEntries(['grossPaise', 'accumulatedPaise', 'netPaise'].map(key => [key, rows(data.rows).reduce((sum, row) => sum + Number(row[key] ?? 0), 0)])) } } },
    sections: data => [...spec.sections(data).map(section => section.kind === 'table' ? { ...section, footer: 'totals' } : section), form('Run depreciation', '/depreciation/run', dateFields('upTo'))],
  } as PluginPage : spec),
  page({ path: '/asset-categories', title: 'Asset categories', menu: 'Assets', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); return { ...data, rows: rows(await read(actor, '/asset-categories')).map(row => ({ ...display(row, data), lifeYears: row.lifeMonths ? Number(row.lifeMonths) / 12 : '' })) } },
    sections: () => [table('Asset categories', 'rows', [col('name'), col('method'), col('lifeYears'), col('rateBpText', undefined, { label: 'Rate %' }), col('residualBpText', undefined, { label: 'Residual %' }), col('frequency')]),
      form('Add asset category', '/asset-categories', [field('name', 'text', { optional: false }), select('method', ['slm', 'wdv', 'none'], { optional: false }), field('lifeYears', 'number', { step: 'any' }), field('ratePercent', 'number', { step: 'any' }), field('residualPercent', 'number', { step: 'any' }), select('frequency', ['month', 'year'], { value: 'month' }), select('assetAccountId', 'accounts'), select('accumulatedAccountId', 'accounts'), select('depreciationAccountId', 'expenseAccounts')], {}, ADMIN)],
  }),
  page({ path: '/depreciation', title: 'Depreciation', menu: 'Assets', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); return { ...data, rows: rows(await read(actor, '/depreciation', { from: data.from, to: data.to })) } },
    sections: data => [filter('/depreciation', data, dateFields('from', 'to')), table('Depreciation by category', 'rows', [col('category'), col('assets'), ...moneyCols('amountPaise', 'postedPaise')]), form('Run depreciation', '/depreciation/run', dateFields('upTo'))],
  }),
  page({ path: '/assets/maintenance', title: 'Maintenance due', menu: 'Assets', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); return { ...data, rows: rows(await read(actor, '/assets/maintenance-due', object(data.query))) } },
    sections: data => [filter('/assets/maintenance', data, [field('days', 'number', { value: '30' })]), table('Maintenance due', 'rows', [linkCol('name', '/asset', 'assetId'), col('lastOn', 'date'), col('nextDueOn', 'date'), col('overdue', 'bool', { alertWhen: 'overdue' })])],
  }),
]
