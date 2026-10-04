import type { PluginActor, PluginColumn, PluginField, PluginPage, PluginSection, Role, Tone } from '@campusos/module-framework'
import { formatPaise } from '@campusos/money'
import { docRecord, OFFICE, today } from './kit'
import { approval, approvalTable, checks, chooseRecord, col, context, currencyMinor, dateFields, dimensions, display, draftValues, field, filter, form, grid, hidden, href, linkCol, moneyCols, moneyFields, object, page, postingTable, read, rows, select, shortcuts, str, table, tabs, textFields, type Data } from './screen-kit'

export interface DocumentSpec {
  path: string
  base: string
  key: string
  idField: string
  entity: string
  title: string
  menu: string
  kinds?: string[]
  roles?: Role[]
  scope?: 'office' | 'request' | 'stock'
  amend?: boolean
  remove?: boolean
  fields: (data: Data) => PluginField[]
  columns?: PluginColumn[]
  listColumns?: PluginColumn[]
  filters?: PluginField[]
  approve?: (document: Data) => string | undefined
  actions?: (data: Data) => PluginSection[]
  prepare?: (actor: PluginActor, data: Data) => Promise<Data>
}

export function documentPages(spec: DocumentSpec): PluginPage[] {
  const roles = spec.roles ?? OFFICE
  const getRecord = (data: Data) => object(data.document)
  const save = (data: Data) => {
    const document = getRecord(data)
    const values = { postingDate: today(), currency: data.baseCurrency, ...object(data.query), ...object(data.values), ...(document.id ? { [spec.idField]: document.id } : {}) }
    return form('Save draft', spec.base, [...(document.id ? [hidden(spec.idField, document.id)] : []), ...spec.fields(data), ...checks('submit')], values, roles)
  }
  const load = async (actor: PluginActor, request: Request, detail: boolean): Promise<Data> => {
    const query = Object.fromEntries(new URL(request.url).searchParams)
    const result = detail && query.id ? object(await read(actor, `${spec.base}/detail`, { [spec.idField]: query.id })) : {}
    if (spec.scope === 'stock' && !detail) await read(actor, spec.base)
    const data = await context(actor, request, spec.scope)
    const document = object(result[spec.key])
    const currency = str(document.currency) || str(query.currency) || str(data.baseCurrency)
    const source = rows(result.lines)
    const values = draftValues(document, data, currency)
    if (spec.path === '/asset') values.existing = String(document.existing === 'yes')
    const collection = Object.fromEntries(Object.entries(result).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, rows(value).map(row => display(row, data, currency))]))
    let loaded: Data = { ...data, ...result, ...collection, document, values,
      kind: document.kind || query.kind || spec.kinds?.[0], currency,
      lines: source.map(row => display(row, data, currency)),
      editLines: source.map(row => draftValues(row, data, currency)),
      returnLines: source.map(row => ({ lineId: str(row.id), qty: draftValues(row).qty })),
      posting: rows(result.posting), approvals: rows(result.approvals),
    }
    if (spec.path === '/stock-entry') loaded.editLines = source.map(row => ({ ...draftValues(row, data), rate: row.ratePaise === null ? '' : String(Number(row.ratePaise) / 100) }))
    if (spec.prepare) loaded = await spec.prepare(actor, loaded)
    return loaded
  }
  return [
    page({ path: spec.base, title: spec.title, menu: spec.menu, roles,
      async load(actor, request) {
        const query = Object.fromEntries(new URL(request.url).searchParams)
        const kind = query.kind || spec.kinds?.[0]
        const list = rows(await read(actor, spec.base, { ...query, kind }))
        const data = await context(actor, request, spec.scope)
        return { ...data, query: { ...query, kind }, rows: list.map(row => ({ ...display(row, data), overdue: row.status === 'overdue' })) }
      },
      sections: data => [
        ...(spec.kinds ? [tabs(spec.base, object(data.query), 'kind', spec.kinds)] : []),
        filter(spec.base, data, [...(spec.kinds ? [select('kind', spec.kinds)] : []), field('status'), ...(spec.filters ?? [select('partyId', 'parties'), ...dateFields('from', 'to'), field('q')])]),
        ...(spec.path === '/invoice' ? [tabs(spec.base, object(data.query), 'status', ['', 'draft', 'open', 'overdue', 'paid', 'cancelled', 'return'])] : []),
        shortcuts('Create', [{ label: `New ${spec.title.toLowerCase()}`, href: href(`${spec.path}/new`, { kind: object(data.query).kind }) }]),
        table(spec.title, 'rows', spec.listColumns ?? [linkCol('number', spec.path), col('postingDate', 'date'), col('partyName'), col('kind'), col('totalFcText', undefined, { label: 'Total' }), col('status', 'status'), col('docstatus', 'status')]),
      ],
    }),
    page({ path: `${spec.path}/new`, title: `New ${spec.title.toLowerCase()}`, roles,
      load: (actor, request) => load(actor, request, false),
      sections: data => [save(data), ...(spec.path === '/payment' ? [filter('/payment/new', data, [select('kind', spec.kinds ?? []), select('partyId', 'parties'), select('currency', 'currencies')])] : []),
        ...(spec.path === '/voucher' ? [{ kind: 'note' as const, text: 'Opening vouchers send any difference to the opening balance account. Receivable and payable lines must name a party.' }, shortcuts('Rows', [{ label: 'More rows', href: href('/voucher/new', { ...object(data.query), rows: 24 }) }])] : [])],
    }),
    page({ path: spec.path, title: spec.title, roles,
      load: (actor, request) => load(actor, request, true),
      record: data => {
        const document = getRecord(data)
        if (!document.id) return null
        const status = str(data.status || document.docstatus)
        const tone: Record<string, Tone> = { draft: 'gray', submitted: 'blue', cancelled: 'red', paid: 'green', partly_paid: 'orange', overdue: 'red', return: 'violet', unpaid: 'blue' }
        return docRecord({ title: `${document.isReturn ? 'Return · ' : ''}${spec.title} ${document.number || 'Draft'}`, subtitle: str(object(data.party).name || document.name), status: { label: status, tone: tone[status] ?? 'blue' },
          id: str(document.id), idField: spec.idField, base: spec.base, entity: spec.entity,
          docstatus: document.docstatus as 'draft' | 'submitted' | 'cancelled', roles,
          amend: spec.amend ?? false, createdAt: document.createdAt as string, submittedAt: document.submittedAt as string, cancelReason: str(document.cancelReason),
          fields: ['postingDate', 'dueDate', 'billNo', 'currency', 'exchangeRate', 'placeOfSupply', 'reverseCharge', 'costCenter', 'fundId', 'requiredBy', 'tagCode'].filter(key => document[key] !== null && document[key] !== undefined).map(key => ({ label: field(key).label, value: document[key] })),
        })
      },
      sections: data => {
        const document = getRecord(data)
        if (!document.id) return [chooseRecord]
        const draft = document.docstatus === 'draft'
        const approvalType = spec.approve?.(document)
        return [
          ...(draft ? [save(data), ...(approvalType ? [approval(approvalType, document.id)] : []), ...(spec.remove === false ? [] : [form('Delete draft', `${spec.base}/delete`, [hidden(spec.idField, document.id)], {}, roles)])] : []),
          ...(spec.columns ? [table('Lines', 'lines', spec.columns, { fixedOrder: true })] : []),
          ...(spec.approve ? [approvalTable()] : []),
          ...(spec.actions?.(data) ?? []),
        ]
      },
    }),
  ]
}

const commercialFields = (data: Data) => [hidden('kind', data.kind), select('partyId', str(data.kind).includes('purchase') ? 'suppliers' : 'customers', { optional: false }), field('postingDate', 'date'), select('currency', 'currencies'), field('exchangeRate', 'number', { step: 'any', hint: 'Leave blank to use the rate recorded for this date.' }), field('placeOfSupply'), ...dimensions(), field('memo', 'textarea'), field('terms', 'textarea')]
const itemColumns = () => [select('itemId', 'items'), field('description'), field('qty', 'number', { step: 'any' }), field('rate', 'money'), field('discount', 'number', { step: 'any', label: 'Discount %' }), select('taxTemplateId', 'taxes'), select('warehouseId', 'warehouses'), select('costCenter', 'costCenters')]
const lineColumns = [col('description'), col('hsnSac'), col('qtyMilliText', undefined, { label: 'Quantity' }), col('rateFcText', undefined, { label: 'Rate' }), col('discountBpText', undefined, { label: 'Discount %' }), col('netFcText', undefined, { label: 'Net amount' })]
const totals = (data: Data): PluginSection => {
  const document = object(data.document)
  const shown = display(document, data)
  return { kind: 'figures', figures: ['netFc', 'taxFc', 'roundingFc', 'totalFc'].map(key => ({ label: field(key.replace('Fc', '')).label, value: str(shown[`${key}Text`]) })).concat([{ label: 'TDS', value: formatPaise(Number(document.tdsPaise ?? 0)) }, { label: 'Outstanding', value: str(display({ amountFc: object(data.outstanding).fc }, data, str(document.currency)).amountFcText) }]) }
}

export const sellingPages: PluginPage[] = [
  ...documentPages({ path: '/invoice', base: '/invoices', key: 'invoice', idField: 'invoiceId', entity: 'finance_invoice', title: 'Invoice', menu: 'Selling', kinds: ['sales', 'purchase'], amend: true,
    approve: document => document.kind === 'purchase' ? 'purchase_invoice' : undefined,
    fields: data => [...commercialFields(data), ...dateFields('dueDate'), ...(data.kind === 'purchase' ? [...textFields('billNo'), ...dateFields('billDate'), ...checks('reverseCharge'), select('tdsSectionId', 'tds')] : []), ...checks('updateStock'), select('warehouseId', 'warehouses'),
      grid('lines', [...itemColumns(), select('accountId', data.kind === 'purchase' ? 'expenseAccounts' : 'incomeAccounts'), field('batchNo'), field('expiresOn', 'date'), field('serials'), field('itcEligible', 'checkbox', { value: 'true', label: 'Input tax credit eligible' }), hidden('orderLineId', ''), hidden('receiptLineId', '')])],
    columns: lineColumns,
    listColumns: [linkCol('number', '/invoice'), col('postingDate', 'date'), col('partyName'), col('billNo'), col('dueDate', 'date', { alertWhen: 'overdue' }), col('totalFcText', undefined, { label: 'Total' }), col('outstandingFcText', undefined, { label: 'Outstanding' }), col('status', 'status')],
    actions: data => {
      const document = object(data.document)
      const id = document.id
      const submitted = document.docstatus === 'submitted'
      return [totals(data), table('Taxes', 'taxes', [col('component'), col('rateBpText', undefined, { label: 'Rate %' }), col('taxableFcText', undefined, { label: 'Taxable' }), col('amountFcText', undefined, { label: 'Tax' }), ...moneyCols('ineligiblePaise')]),
        table('Settlements', 'settlements', [col('postingDate', 'date'), col('voucherType'), col('voucherId'), col('amountFcText', undefined, { label: 'Amount' })]), table('Returns', 'returns', [linkCol('number', '/invoice'), col('totalFcText'), col('docstatus', 'status')]),
        table('Assets created', 'assets', [linkCol('name', '/asset'), col('number'), col('docstatus', 'status')]), postingTable(),
        ...(document.docstatus === 'draft' ? [form('Submit with credit-limit override', '/invoices/submit', [hidden('invoiceId', id), hidden('overrideCreditLimit', 'true')], {}, ['institution_admin', 'super_admin'])] : []),
        ...(submitted ? [shortcuts('Invoice actions', [{ label: 'Print', href: `/api/v1/modules/finance/invoices/pdf?invoiceId=${id}` }, { label: 'Record payment', href: href('/payment/new', { kind: document.kind === 'sales' ? 'receive' : 'pay', partyId: document.partyId, invoiceId: id, currency: document.currency }) }]),
          ...(!document.isReturn ? [form('Credit or debit note', '/invoices/return', [hidden('invoiceId', id), ...dateFields('postingDate'), field('memo', 'textarea'), grid('lines', [hidden('lineId', ''), field('qty', 'number', { step: 'any' })], 'returnLines'), ...checks('submit')]),
            form('Make recurring', '/recurring', [hidden('invoiceId', id), select('every', ['month', 'quarter', 'year'], { optional: false }), ...dateFields('nextOn', 'endsOn'), ...checks('autoSubmit')])] : [])] : []),
      ]
    },
  }),
  ...documentPages({ path: '/order', base: '/orders', key: 'order', idField: 'orderId', entity: 'finance_order', title: 'Order', menu: 'Buying', kinds: ['purchase_order', 'sales_order', 'quotation'], amend: true,
    approve: document => document.kind === 'purchase_order' ? 'purchase_order' : undefined,
    fields: data => [...commercialFields(data), ...dateFields(data.kind === 'quotation' ? 'validTill' : 'deliverBy'), select('warehouseId', 'warehouses'), grid('lines', [...itemColumns(), field('deliverBy', 'date'), hidden('requestLineId', ''), hidden('quotationLineId', '')])],
    columns: [...lineColumns, col('movedMilliText', undefined, { label: 'Received / delivered' }), col('billedMilliText', undefined, { label: 'Billed' }), col('orderedMilliText', undefined, { label: 'Ordered' })],
    actions: data => {
      const document = object(data.document)
      return [table('Receipts and deliveries', 'receipts', [linkCol('number', '/receipt'), col('postingDate', 'date'), col('docstatus', 'status')]), table('Invoices raised', 'invoices', [linkCol('number', '/invoice'), col('postingDate', 'date'), col('totalFcText')]),
        ...(document.docstatus === 'submitted' ? [shortcuts('Print', [{ label: 'Print order', href: `/api/v1/modules/finance/orders/pdf?orderId=${document.id}` }]),
          ...(document.kind === 'quotation' ? [form('Make sales order', '/orders/from-quotation', [hidden('quotationId', document.id)])] : [
            form(document.kind === 'purchase_order' ? 'Make goods receipt' : 'Make delivery note', '/receipts/from-order', [hidden('orderId', document.id), ...dateFields('postingDate'), ...checks('submit')]),
            form(document.kind === 'purchase_order' ? 'Make bill' : 'Make invoice', '/invoices/from-order', [hidden('orderId', document.id), ...dateFields('postingDate'), ...checks('updateStock', 'submit')]),
            form('Close order short', '/orders/close', [hidden('orderId', document.id), field('reason', 'textarea', { optional: false })]),
          ])] : []),
      ]
    },
  }),
  ...documentPages({ path: '/receipt', base: '/receipts', key: 'receipt', idField: 'receiptId', entity: 'finance_receipt', title: 'Receipt', menu: 'Buying', kinds: ['purchase_receipt', 'delivery_note'],
    fields: data => [hidden('kind', data.kind), select('partyId', data.kind === 'purchase_receipt' ? 'suppliers' : 'customers', { optional: false }), field('orderId'), ...dateFields('postingDate'), ...textFields('challanNo', 'transporter'), select('costCenter', 'costCenters'), field('memo', 'textarea'), select('currency', 'currencies'), field('exchangeRate', 'number', { step: 'any' }), grid('lines', [select('itemId', 'stockItems'), hidden('orderLineId', ''), select('warehouseId', 'warehouses'), field('qty', 'number', { step: 'any' }), field('rejected', 'number', { step: 'any' }), field('rate', 'money'), field('batchNo'), field('expiresOn', 'date'), field('serials')])],
    columns: [col('itemName'), col('warehouseId'), col('qtyMilliText'), col('rejectedMilliText'), col('rateFcText'), col('batchNo'), col('serials'), col('billedMilliText')],
    actions: data => object(data.document).docstatus === 'submitted' ? [form('Make bill or invoice', '/invoices/from-receipt', [hidden('receiptId', object(data.document).id), ...dateFields('postingDate'), field('billNo'), ...checks('submit')]), form('Return goods', '/receipts/return', [hidden('receiptId', object(data.document).id), ...dateFields('postingDate'), grid('lines', [hidden('lineId', ''), field('qty', 'number', { step: 'any' })], 'returnLines'), ...checks('submit')])] : [],
  }),
  page({ path: '/recurring', title: 'Recurring invoices', menu: 'Selling', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); const list = rows(await read(actor, '/recurring')); return { ...data, rows: list.map(row => display(row, data)), recurringOptions: list.map(row => ({ value: str(row.id), label: `${row.number} · ${row.partyName}` })) } },
    sections: () => [table('Recurring invoices', 'rows', [linkCol('number', '/invoice', 'invoiceId'), col('partyName'), col('kind'), col('totalFcText'), col('every'), col('nextOn', 'date'), col('endsOn', 'date'), col('autoSubmit', 'bool'), col('stopped', 'bool')]), form('Run due now', '/recurring/run', dateFields('on')), form('Stop recurring invoice', '/recurring/stop', [select('recurringId', 'recurringOptions', { optional: false })])],
  }),
]

export const paymentPages: PluginPage[] = [
  ...documentPages({ path: '/payment', base: '/payments', key: 'payment', idField: 'paymentId', entity: 'finance_payment', title: 'Payment', menu: 'Money', kinds: ['receive', 'pay', 'transfer'], amend: true,
    approve: document => document.kind === 'pay' ? 'payment_pay' : undefined,
    async prepare(actor, data) {
      const document = object(data.document)
      const query = object(data.query)
      const partyId = str(document.partyId || query.partyId)
      const currency = str(document.currency || query.currency || data.baseCurrency)
      const open = partyId ? rows(await read(actor, '/payments/open-invoices', { partyId, currency, side: document.side || query.side || (data.kind === 'receive' ? 'receivable' : 'payable') })) : []
      const current = rows(data.allocations)
      const allocations = current.length ? current.map(row => draftValues(row, data, currency)) : open.filter(row => !query.invoiceId || row.id === query.invoiceId).map(row => ({ invoiceId: str(row.id), amount: query.invoiceId ? String(Number(row.outstandingFc ?? row.openFc ?? 0) / 10 ** currencyMinor(data, currency)) : '' }))
      const options = [...open, ...current.map(row => ({ id: row.invoiceId, number: row.number }))]
      return { ...data, allocations: current, editAllocations: allocations, openInvoices: open.map(row => display(row, data, currency)), invoiceOptions: [...new Map(options.map(row => [str(row.id), { value: str(row.id), label: str(row.number || 'Draft') }])).values()], values: { ...object(data.values), ...(query.invoiceId && allocations[0]?.amount ? { amount: allocations[0].amount } : {}) } }
    },
    fields: data => [hidden('kind', data.kind), ...(data.kind === 'transfer' ? [] : [select('partyId', 'parties', { optional: false }), select('side', ['receivable', 'payable'])]), ...dateFields('postingDate'), select('accountId', 'cashBank', { optional: false }), ...(data.kind === 'transfer' ? [select('toAccountId', 'cashBank', { optional: false })] : []), select('currency', 'currencies'), field('exchangeRate', 'number', { step: 'any' }), field('amount', 'money', { optional: false }), ...moneyFields('tds', 'bankCharges'), select('tdsSectionId', 'tds'), select('mode', ['cash', 'cheque', 'dd', 'neft', 'rtgs', 'imps', 'upi', 'card', 'wire', 'other'], { value: 'neft' }), field('instrumentNo'), ...dateFields('instrumentDate'), field('reference'), field('memo', 'textarea'), ...dimensions(), ...checks('autoAllocate'), ...(data.kind === 'transfer' ? [] : [grid('allocations', [select('invoiceId', 'invoiceOptions'), field('amount', 'money')], 'editAllocations')])],
    listColumns: [linkCol('number', '/payment'), col('postingDate', 'date'), col('kind'), col('partyName'), col('accountName'), col('amountFcText', undefined, { label: 'Amount' }), ...moneyCols('tdsPaise'), col('mode'), col('reference'), col('docstatus', 'status')],
    actions: data => [table('Allocations', 'allocations', [linkCol('number', '/invoice', 'invoiceId'), col('postingDate', 'date'), col('totalFcText'), col('amountFcText')]), table('Applied advances', 'applied', [col('postingDate', 'date'), linkCol('againstId', '/invoice', 'againstId'), col('amountFcText')]), postingTable(),
      { kind: 'note', text: 'Unallocated money remains an advance. Set it off against open invoices from the party page.' },
      ...(object(data.document).docstatus === 'submitted' ? [shortcuts('Print', [{ label: 'Print receipt or voucher', href: `/api/v1/modules/finance/payments/pdf?paymentId=${object(data.document).id}` }])] : [])],
  }),
  ...documentPages({ path: '/voucher', base: '/vouchers', key: 'journal', idField: 'journalId', entity: 'finance_journal', title: 'Voucher', menu: 'Money', kinds: ['journal', 'contra', 'opening', 'adjustment'], amend: true, approve: () => 'journal',
    filters: [],
    fields: data => [select('kind', ['journal', 'contra', 'opening', 'adjustment'], { value: str(data.kind), optional: false }), ...dateFields('postingDate'), field('memo', 'textarea', { optional: false }), field('reference'), grid('lines', [select('accountId', 'accounts'), select('partyId', 'parties'), ...moneyFields('debit', 'credit'), ...dimensions(), select('currency', 'currencies'), field('amountFc', 'money'), field('exchangeRate', 'number', { step: 'any' }), field('memo')], 'editLines', Math.min(200, Math.max(8, Number(object(data.query).rows) || 8)))],
    columns: [col('code'), col('accountName'), col('partyName'), ...moneyCols('debitPaise', 'creditPaise'), col('costCenter'), col('memo')],
    listColumns: [linkCol('number', '/voucher'), col('postingDate', 'date'), col('kind'), col('memo'), col('reference'), ...moneyCols('totalPaise'), col('docstatus', 'status')],
    actions: () => [postingTable()],
  }),
]
