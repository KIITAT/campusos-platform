import type { PluginPage } from '@campusos/module-framework'
import { formatPaise } from '@campusos/money'
import { FinanceError } from '../api'
import { OFFICE } from './kit'
import { checks, chooseRecord, col, context, dateFields, display, draftValues, field, filter, form, hidden, href, linkCol, moneyCols, object, page, read, rows, select, shortcuts, str, table, textFields } from './screen-kit'

const partyFields = () => [...textFields('code', 'name'), ...checks('isCustomer', 'isSupplier'), ...textFields('gstin', 'pan', 'stateCode'), select('gstCategory', ['registered', 'unregistered', 'composition', 'sez', 'overseas']), field('address', 'textarea'), ...textFields('email', 'phone'), select('currency', 'currencies'), field('paymentTermsDays', 'number'), field('creditLimit', 'money'), select('tdsSectionId', 'tds'), ...checks('msme'), ...textFields('msmeNumber', 'bankName', 'bankAccount', 'ifsc')]

export const partyPages: PluginPage[] = [
  page({ path: '/parties', title: 'Customers and suppliers', menu: 'Selling', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); return { ...data, rows: rows(await read(actor, '/parties', object(data.query))) } },
    sections: data => [filter('/parties', data, [select('side', ['customer', 'supplier']), field('q'), ...checks('archived')]), table('Customers and suppliers', 'rows', [col('code'), linkCol('name', '/party'), col('gstin'), col('stateCode'), col('isCustomer', 'bool'), col('isSupplier', 'bool'), ...moneyCols('receivablePaise', 'payablePaise'), col('msme', 'bool')]), form('Add party', '/parties', partyFields(), { isCustomer: object(data.query).side !== 'supplier', isSupplier: object(data.query).side === 'supplier' })],
  }),
  page({ path: '/party', title: 'Party account', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request); const query = object(data.query)
      if (!query.id) return { ...data, document: {} }
      const party = rows(await read(actor, '/parties', { archived: 'true' })).find(row => row.id === query.id)
      if (!party) throw new FinanceError(404, 'no_such_party', 'No such party.')
      const side = query.side || (party.isCustomer ? 'receivable' : 'payable')
      const report = object(await read(actor, '/parties/statement', { partyId: query.id, side, from: data.from, to: data.to }))
      const open = rows(await read(actor, '/payments/open-invoices', { partyId: query.id, side }))
      return { ...data, document: party, side, openingPaise: report.openingPaise, closingPaise: report.closingPaise,
        statement: rows(report.lines).map(row => ({ ...row, page: str(row.voucherType).includes('invoice') ? 'invoice' : row.voucherType === 'journal' ? 'voucher' : 'payment' })),
        totals: { voucherType: 'Closing balance', balancePaise: report.closingPaise }, open: open.map(row => display(row, data)), values: draftValues(party, data),
      }
    },
    record: data => { const party = object(data.document); return party.id ? { title: str(party.name), subtitle: str(party.code), audit: { entity: 'finance_party', entityId: str(party.id) }, fields: ['gstin', 'pan', 'stateCode', 'paymentTermsDays', 'creditLimitPaise', 'msme'].map(key => ({ label: field(key).label, value: party[key], kind: key === 'creditLimitPaise' ? 'money' as const : undefined })) } : null },
    sections: data => {
      const party = object(data.document)
      if (!party.id) return [chooseRecord]
      return [{ kind: 'figures', figures: [{ label: 'Owed to us', value: formatPaise(Number(party.receivablePaise ?? 0)) }, { label: 'We owe', value: formatPaise(Number(party.payablePaise ?? 0)) }, { label: 'Opening', value: formatPaise(Number(data.openingPaise ?? 0)) }, { label: 'Closing', value: formatPaise(Number(data.closingPaise ?? 0)) }] },
        filter('/party', data, [hidden('id', party.id), select('side', ['receivable', 'payable'], { value: str(data.side) }), ...dateFields('from', 'to')]),
        table('Statement', 'statement', [col('postingDate', 'date'), col('voucherType'), col('voucherId', undefined, { href: '/m/finance/{page}?id={voucherId}', label: 'Voucher' }), ...moneyCols('amountPaise', 'balancePaise')], { fixedOrder: true, footer: 'totals' }),
        table('Open invoices', 'open', [linkCol('number', '/invoice'), col('postingDate', 'date'), col('dueDate', 'date'), col('totalFcText'), col('outstandingFcText')]),
        shortcuts('New document', [{ label: 'New invoice', href: href('/invoice/new', { kind: data.side === 'receivable' ? 'sales' : 'purchase', partyId: party.id }) }, { label: 'Record payment', href: href('/payment/new', { kind: data.side === 'receivable' ? 'receive' : 'pay', partyId: party.id }) }]),
        { kind: 'note', text: 'Set off advances applies this party’s advances and credit notes against their oldest open invoices.' },
        form('Set off advances', '/parties/apply-advances', [hidden('partyId', party.id), hidden('side', data.side), ...dateFields('on')]),
        form('Edit party', '/parties/update', [hidden('partyId', party.id), ...partyFields()], object(data.values)),
        form('Archive or restore party', '/parties/archive', [hidden('partyId', party.id), ...checks('archived')], { archived: !!party.archivedAt }),
      ]
    },
  }),
]
