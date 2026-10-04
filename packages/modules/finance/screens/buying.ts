import type { PluginPage } from '@campusos/module-framework'
import { asc, eq } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { hasCapability, requireRead, tenantOf, FinanceError } from '../api'
import { rfqLines, rfqSuppliers, supplierQuotations, supplierQuotationLines } from '../schema'
import { as, OFFICE, STAFF } from './kit'
import { documentPages } from './documents'
import { checks, chooseRecord, col, context, dateFields, display, draftValues, field, form, grid, hidden, href, linkCol, moneyCols, object, page, read, rows, select, shortcuts, str, table } from './screen-kit'

const requestFields = () => [select('purpose', ['issue', 'purchase'], { value: 'issue', optional: false }), select('costCenter', 'costCenters'), select('warehouseId', 'warehouses'), ...dateFields('requiredBy'), field('reason', 'textarea'), grid('lines', [select('itemId', 'items'), field('qty', 'number', { step: 'any' }), field('note')])]
const rfqFields = () => [...dateFields('postingDate', 'respondBy'), field('terms', 'textarea'), hidden('requestId', ''), select('supplierIds', 'suppliers', { kind: 'checkboxes', optional: false }), grid('lines', [select('itemId', 'items'), field('qty', 'number', { step: 'any' }), hidden('requestLineId', '')]), ...checks('submit')]
const quoteFields = () => [hidden('rfqId', ''), select('partyId', 'suppliers', { optional: false }), ...dateFields('quotedOn', 'validTill'), select('currency', 'currencies'), field('terms', 'textarea'), grid('lines', [select('itemId', 'items'), field('qty', 'number', { step: 'any' }), field('rate', 'money'), select('taxTemplateId', 'taxes'), field('leadDays', 'number'), hidden('rfqLineId', '')]), ...checks('submit')]

export const buyingPages: PluginPage[] = [
  ...documentPages({ path: '/material-request', base: '/material-requests', key: 'request', idField: 'requestId', entity: 'finance_material_request', title: 'Material request', menu: 'Buying', roles: STAFF, scope: 'request', remove: false, fields: requestFields, approve: () => 'material_request', filters: checks('mine'),
    columns: [col('itemName'), col('qtyMilliText'), col('issuedMilliText'), col('orderedMilliText'), col('note')],
    listColumns: [linkCol('number', '/material-request'), col('createdAt', 'when'), col('purpose'), col('requestedByName'), col('requiredBy', 'date'), col('costCenter'), col('status', 'status'), col('docstatus', 'status')],
    async prepare(actor, data) {
      const capability = await withTenant(tenantOf(as(actor)), async transaction => ({ canIssue: await hasCapability(transaction, as(actor), 'storekeeper'), canOrder: OFFICE.includes(actor.role) }))
      return { ...data, ...capability }
    },
    actions: data => [table('Issues made', 'issues', [linkCol('number', '/stock-entry'), col('postingDate', 'date'), col('docstatus', 'status')]),
      ...(object(data.document).docstatus === 'submitted' ? [
        ...(data.canIssue ? [form('Issue from stores', '/material-requests/issue', [hidden('requestId', object(data.document).id), select('warehouseId', 'warehouses')], {}, STAFF)] : []),
        ...(data.canOrder ? [form('Draft purchase order', '/material-requests/order', [hidden('requestId', object(data.document).id), select('partyId', 'suppliers', { optional: false })]), shortcuts('Purchasing', [{ label: 'Ask for quotations', href: href('/rfq/new', { requestId: object(data.document).id }) }])] : []),
      ] : []),
    ],
  }),
  page({ path: '/rfqs', title: 'Requests for quotation', menu: 'Buying', roles: OFFICE,
    async load(actor) { return { rows: rows(await read(actor, '/rfqs')).map(row => display(row)) } },
    sections: () => [shortcuts('Create', [{ label: 'New request for quotation', href: '/m/finance/rfq/new' }]), table('Requests for quotation', 'rows', [linkCol('number', '/rfq'), col('postingDate', 'date'), col('respondBy', 'date'), col('docstatus', 'status')])],
  }),
  page({ path: '/rfq/new', title: 'Request supplier quotations', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request); const query = object(data.query)
      const material = query.requestId ? object(await read(actor, '/material-requests/detail', { requestId: query.requestId })) : {}
      return { ...data, editLines: rows(material.lines).filter(line => Number(line.qtyMilli) > Number(line.orderedMilli)).map(line => ({ itemId: str(line.itemId), qty: str((Number(line.qtyMilli) - Number(line.orderedMilli)) / 1000), requestLineId: str(line.id) })) }
    },
    sections: data => [form('Save request for quotation', '/rfqs', rfqFields(), object(data.query))],
  }),
  page({ path: '/rfq', title: 'Compare supplier offers', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request); const query = object(data.query)
      if (!query.id) return { ...data, document: {} }
      const report = object(await read(actor, '/rfqs/compare', { rfqId: query.id }))
      const persisted = await withTenant(requireRead(as(actor)), async transaction => ({ lines: await transaction.select().from(rfqLines).where(eq(rfqLines.rfqId, str(query.id))).orderBy(asc(rfqLines.seq)), suppliers: await transaction.select().from(rfqSuppliers).where(eq(rfqSuppliers.rfqId, str(query.id))) }))
      const offers = rows(report.items).flatMap(item => rows(item.offers).map(offer => display({ ...offer, itemName: item.itemName, qtyMilli: item.qtyMilli }, data)))
      return { ...data, document: report.rfq, rows: offers, requested: rows(report.items).map(row => display(row, data)), editLines: persisted.lines.map(line => draftValues(line, data)), supplierIds: persisted.suppliers.map(supplier => supplier.partyId).join(','), quoteOptions: [...new Map(offers.filter(offer => !offer.expired).map(offer => [str(offer.quotationId), { value: str(offer.quotationId), label: `${offer.number} · ${offer.supplier}` }])).values()] }
    },
    record: data => { const document = object(data.document); return document.id ? { title: `Request for quotation ${document.number || 'Draft'}`, status: { label: str(document.docstatus) }, audit: { entity: 'finance_rfq', entityId: str(document.id) } } : null },
    sections: data => {
      const document = object(data.document)
      if (!document.id) return [chooseRecord]
      return [table('Items requested', 'requested', [col('itemName'), col('qtyMilliText')]), table('Supplier comparison', 'rows', [col('itemName'), col('supplier'), col('rateFcText', undefined, { label: 'Rate' }), col('leadDays'), col('validTill', 'date', { alertWhen: 'expired' }), col('lowest', 'bool')], { emphasis: 'lowest' }),
        ...(document.docstatus === 'draft' ? [form('Save request for quotation', '/rfqs', [hidden('rfqId', document.id), ...rfqFields()], { ...document, supplierIds: data.supplierIds })] : [shortcuts('Quotes', [{ label: 'Record a quotation', href: href('/supplier-quotation/new', { rfqId: document.id }) }]), form('Order chosen quotation', '/orders/from-supplier-quotation', [select('supplierQuotationId', 'quoteOptions', { optional: false })])]),
      ]
    },
  }),
  page({ path: '/supplier-quotations', title: 'Supplier quotations', menu: 'Buying', roles: OFFICE,
    async load(actor) { return { rows: rows(await read(actor, '/supplier-quotations')).map(row => display(row)) } },
    sections: () => [shortcuts('Create', [{ label: 'Record supplier quotation', href: '/m/finance/supplier-quotation/new' }]), table('Supplier quotations', 'rows', [linkCol('number', '/supplier-quotation'), col('partyName'), col('quotedOn', 'date'), col('validTill', 'date'), col('currency'), col('docstatus', 'status')])],
  }),
  ...['/supplier-quotation/new', '/supplier-quotation'].map(path => page({ path, title: 'Supplier quotation', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request); const query = object(data.query)
      const saved = query.id ? await withTenant(requireRead(as(actor)), async transaction => {
        const [document] = await transaction.select().from(supplierQuotations).where(eq(supplierQuotations.id, str(query.id)))
        if (!document) throw new FinanceError(404, 'no_such_quotation', 'No such quotation.')
        return { document, lines: await transaction.select().from(supplierQuotationLines).where(eq(supplierQuotationLines.quotationId, document.id)).orderBy(asc(supplierQuotationLines.seq)) }
      }) : { document: {}, lines: [] }
      const requested = !query.id && query.rfqId ? await withTenant(requireRead(as(actor)), transaction => transaction.select().from(rfqLines).where(eq(rfqLines.rfqId, str(query.rfqId))).orderBy(asc(rfqLines.seq))) : []
      const document = object(saved.document)
      return { ...data, document, values: { ...query, ...document }, lines: saved.lines.map(line => display(line, data, str(document.currency))), editLines: saved.lines.length ? saved.lines.map(line => draftValues(line, data, str(document.currency))) : requested.map(line => ({ ...draftValues(line), rfqLineId: line.id })) }
    },
    record: data => { const document = object(data.document); return document.id ? { title: `Supplier quotation ${document.number || 'Draft'}`, status: { label: str(document.docstatus) }, audit: { entity: 'finance_supplier_quotation', entityId: str(document.id) } } : null },
    sections: data => {
      const document = object(data.document)
      return !document.id || document.docstatus === 'draft' ? [form('Save supplier quotation', '/supplier-quotations', [...(document.id ? [hidden('quotationId', document.id)] : []), ...quoteFields()], object(data.values))] : [table('Quoted items', 'lines', [col('itemId'), col('qtyMilliText'), col('rateFcText'), col('leadDays')]), form('Make purchase order', '/orders/from-supplier-quotation', [hidden('supplierQuotationId', document.id)])]
    },
  })),
  page({ path: '/commitments', title: 'Purchase commitments', menu: 'Buying', roles: OFFICE,
    async load(actor) { return { rows: rows(await read(actor, '/commitments')) } },
    sections: () => [table('Unbilled purchase orders', 'rows', [col('costCenter'), ...moneyCols('openPaise'), col('orders')]), shortcuts('Budget', [{ label: 'Compare budgets and spending', href: '/m/finance/budgets' }])],
  }),
]
