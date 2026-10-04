import type { PluginColumn, PluginPage, PluginSection, Role } from '@campusos/module-framework'
import { DEFAULT_SERIES } from '../api'
import { ADMIN, OFFICE, STAFF } from './kit'
import { checks, col, context, dateFields, display, field, filter, form, grid, label, moneyCols, moneyFields, object, page, read, rows, select, str, table, textFields, type Data } from './screen-kit'

function setup(path: string, title: string, columns: PluginColumn[], sections: (data: Data) => PluginSection[], roles: Role[] = OFFICE): PluginPage {
  return page({ path, title, menu: 'Setup', roles,
    async load(actor, request) {
      const data = await context(actor, request)
      const list: Data[] = rows(await read(actor, path)).map(row => ({ ...display(row, data), archived: !!row.archivedAt }))
      return { ...data, rows: list, rowOptions: list.map(row => ({ value: str(row.id ?? row.docType), label: str(row.name ?? row.docType ?? row.code ?? row.id) })),
        accountCodes: rows(await read(actor, '/accounts')).filter(account => !account.isGroup).map(account => ({ value: str(account.code), label: `${account.code} ${account.name}` })),
      }
    },
    sections: data => [table(title, 'rows', columns, path === '/cost-centers' ? { fixedOrder: true } : {}), ...sections(data)],
  })
}

export const setupPages: PluginPage[] = [
  setup('/cost-centers', 'Cost centres', [col('code', 'code', { indent: 'depth' }), col('name'), col('archived', 'bool')], () => [
    form('Add cost centre', '/cost-centers', [...textFields('code', 'name'), select('parentCode', 'costCenters')], {}, ADMIN),
    form('Close or reopen cost centre', '/cost-centers/archive', [select('id', 'rowOptions', { optional: false }), ...checks('archived')], {}, ADMIN),
  ]),
  page({ path: '/funds', title: 'Funds and grants', menu: 'Setup', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request)
      return { ...data, rows: rows(await read(actor, '/reports/funds', { on: data.on })) }
    },
    sections: data => [filter('/funds', data, dateFields('on')), table('Funds and grants', 'rows', [col('code'), col('name', undefined, { href: '/m/finance/reports/fund?fundId={id}' }), col('kind'), col('grantor'), ...moneyCols('sanctionedPaise', 'receivedPaise', 'spentPaise', 'balancePaise')]),
      form('Add fund', '/funds', [...textFields('code', 'name'), select('kind', ['unrestricted', 'restricted', 'endowment', 'grant'], { optional: false }), ...textFields('grantor', 'sanctionRef'), ...moneyFields('sanctioned'), ...dateFields('startsOn', 'endsOn'), field('note', 'textarea')], {}, ADMIN)],
  }),
  page({ path: '/currencies', title: 'Currencies and rates', menu: 'Setup', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); const report = object(await read(actor, '/currencies')); return { ...data, currencyRows: rows(report.currencies), rates: rows(report.rates).map(row => display(row, data)) } },
    sections: () => [table('Currencies', 'currencyRows', [col('code'), col('name'), col('symbol'), col('minorUnits'), col('isBase', 'bool')]), table('Exchange rates', 'rates', [col('currency'), col('on', 'date'), col('rate'), col('source'), col('createdAt', 'when')]),
      form('Add currency', '/currencies', [...textFields('code', 'name', 'symbol'), field('minorUnits', 'number', { value: '2' })], {}, ADMIN),
      form('Enter exchange rate', '/currencies/rates', [select('currency', 'currencies', { optional: false }), ...dateFields('on'), field('rate', 'number', { step: 'any', optional: false }), field('source')]),
      { kind: 'note', text: 'Revaluation values open foreign-currency invoices at the selected day’s rate, and reverses on the next day.' }, form('Revalue open balances', '/currencies/revalue', dateFields('on'))],
  }),
  setup('/series', 'Document numbering', [col('docType'), col('prefix', 'code'), col('padding'), col('custom', 'bool'), col('issued')], () => [
    { kind: 'note', text: 'Use {FYS} for the four-digit fiscal year and {FY} for its name. The expanded prefix and padding must fit in 16 characters.' },
    form('Set numbering', '/series', [select('docType', Object.keys(DEFAULT_SERIES), { optional: false }), field('prefix', 'text', { optional: false }), field('padding', 'number', { value: '4' })], {}, ADMIN),
  ], ADMIN),
  setup('/approval-rules', 'Approval rules', [col('docType'), ...moneyCols('minAmountPaise'), col('approver')], () => [
    { kind: 'note', text: 'The highest rule at or below the document amount wins. Editing a draft invalidates its previous approval.' },
    form('Set approval rule', '/approval-rules', [select('docType', ['purchase_order', 'payment_pay', 'journal', 'material_request', 'purchase_invoice'], { optional: false }), field('minAmount', 'money', { optional: false }), select('approver', ['institution_admin', 'hod', 'accounts_staff', 'approver'], { optional: false })], {}, ADMIN),
    form('Remove approval rule', '/approval-rules/remove', [select('id', 'rowOptions', { optional: false })], {}, ADMIN),
  ], ADMIN),
  setup('/staff', 'Jobs in the books', [col('name'), col('email'), col('capability'), col('warehouseId')], () => [
    form('Grant job', '/staff', [select('userId', 'staff', { optional: false }), select('capability', ['storekeeper', 'purchaser', 'approver'], { optional: false }), select('warehouseId', 'warehouses')], {}, ADMIN),
    form('Revoke job', '/staff/revoke', [select('id', 'rowOptions', { optional: false })], {}, ADMIN),
  ], ADMIN),
  setup('/uoms', 'Units of measure', [col('code'), col('name'), col('whole', 'bool')], () => [form('Add unit', '/uoms', [...textFields('code', 'name'), ...checks('whole')], {}, ADMIN)]),
  setup('/item-groups', 'Item groups', [col('name'), col('parentId')], () => [form('Add item group', '/item-groups', [field('name', 'text', { optional: false }), select('parentId', 'rowOptions'), select('stockAccountId', 'accounts'), select('expenseAccountId', 'expenseAccounts'), select('incomeAccountId', 'incomeAccounts'), select('taxTemplateId', 'taxes')], {}, ADMIN)]),
  page({ path: '/taxes', title: 'Taxes and TDS', menu: 'Setup', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request); const tax = object(await read(actor, '/taxes'))
      return { ...data, templates: rows(tax.templates).map(row => ({ ...display(row, data), ratePercent: Number(row.rate) / 100 })), sections: rows(tax.sections).map(row => display(row, data)),
        templateOptions: rows(tax.templates).map(row => ({ value: str(row.id), label: str(row.name) })),
        accountCodes: rows(await read(actor, '/accounts')).filter(row => !row.isGroup).map(row => ({ value: str(row.code), label: `${row.code} ${row.name}` })),
      }
    },
    sections: () => [table('Tax templates', 'templates', [col('name'), col('kind'), col('treatment'), col('ratePercent'), col('summary'), col('archived', 'bool')]), table('TDS sections', 'sections', [col('code'), col('name'), col('rateBpText', undefined, { label: 'Rate %' }), col('rateNoPanBpText', undefined, { label: 'Rate without PAN %' }), ...moneyCols('thresholdSinglePaise', 'thresholdAnnualPaise'), col('payable')]),
      { kind: 'note', text: 'The India preset is a starting set; check it with your auditor.' }, form('Load India preset', '/taxes/india-preset', [], {}, ADMIN),
      form('Add tax template', '/taxes', [field('name', 'text', { optional: false }), select('kind', ['gst', 'other'], { value: 'gst' }), select('treatment', ['taxable', 'exempt', 'nil_rated', 'non_gst'], { value: 'taxable' }), grid('components', [select('component', ['cgst', 'sgst', 'utgst', 'igst', 'cess', 'other']), select('applies', ['intra', 'inter', 'always']), field('ratePercent', 'number', { step: 'any' }), select('outputAccountCode', 'accountCodes'), select('inputAccountCode', 'accountCodes')], 'components', 6)], {}, ADMIN),
      form('Retire or restore template', '/taxes/archive', [select('id', 'templateOptions', { optional: false }), ...checks('archived')], {}, ADMIN),
      form('Add TDS section', '/tds-sections', [...textFields('code', 'name'), field('ratePercent', 'number', { step: 'any', optional: false }), field('rateNoPanPercent', 'number', { step: 'any', optional: false }), ...moneyFields('thresholdSingle', 'thresholdAnnual'), select('payableAccountCode', 'accountCodes')], {}, ADMIN)],
  }),
  page({ path: '/approvals', title: 'Approvals waiting', menu: 'Approvals', roles: STAFF,
    async load(actor) { return { rows: rows(await read(actor, '/approvals/pending')).map(row => ({ ...display(row), docType: label(str(row.docType)), target: str(row.href).replace(/^\/m\/finance/, '') })) } },
    sections: () => [table('Waiting for your approval', 'rows', [col('docType'), col('number'), ...moneyCols('amountPaise'), col('approver'), col('refused', 'bool', { alertWhen: 'refused' }), col('createdAt', 'when')])],
  }),
]
