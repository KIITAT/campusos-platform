import type { PluginField, PluginPage } from '@campusos/module-framework'
import { FinanceError } from '../api'
import { ADMIN, OFFICE, STAFF } from './kit'
import { documentPages } from './documents'
import { checks, chooseRecord, col, context, dateFields, dimensions, display, draftValues, field, filter, form, grid, hidden, linkCol, moneyCols, object, page, read, rows, select, shortcuts, str, table, textFields, type Data } from './screen-kit'

const itemFields = (edit = false): PluginField[] => [...(edit ? [] : [field('code'), select('uom', 'uomOptions'), select('nature', ['stock', 'service', 'asset'], { value: 'stock' }), ...checks('hasBatch', 'hasSerial')]), field('name'), select('groupId', 'groupOptions'), select('assetCategoryId', 'categories'), field('hsnSac'), select('taxTemplateId', 'taxes'), select('expenseAccountId', 'expenseAccounts'), select('incomeAccountId', 'incomeAccounts'), select('valuation', ['moving_average', 'fifo']), field('reorderLevel', 'number', { step: 'any' }), field('reorderQty', 'number', { step: 'any' }), field('standardRate', 'money'), field('description', 'textarea')]
const stockColumns = [col('code'), col('name'), col('warehouse'), col('qtyMilliText', undefined, { label: 'Quantity' }), ...moneyCols('ratePaise', 'valuePaise')]
const ledgerColumns = [col('postingDate', 'date'), col('voucherType'), col('voucherId', undefined, { href: '/m/finance/{page}?id={voucherId}', label: 'Voucher' }), col('itemName'), col('warehouse'), col('batchNo'), col('qtyMilliText', undefined, { label: 'Change' }), col('qtyAfterMilliText', undefined, { label: 'Quantity after' }), ...moneyCols('valuePaise', 'valueAfterPaise')]
const ledgerDisplay = (row: Data): Data => ({ ...display(row), page: str(row.voucherType).includes('invoice') ? 'invoice' : str(row.voucherType).includes('receipt') || str(row.voucherType).includes('delivery') ? 'receipt' : 'stock-entry' })

export const stockPages: PluginPage[] = [
  page({ path: '/items', title: 'Items', menu: 'Stock', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); return { ...data, rows: rows(await read(actor, '/items', object(data.query))).map(row => display(row, data)), groupOptions: rows(await read(actor, '/item-groups')).map(row => ({ value: str(row.id), label: str(row.name) })), uomOptions: rows(await read(actor, '/uoms')).map(row => ({ value: str(row.code), label: str(row.name) })) } },
    sections: data => [filter('/items', data, [field('q'), select('groupId', 'groupOptions'), ...checks('archived')]), table('Items', 'rows', [col('code'), linkCol('name', '/item'), col('group'), col('uom'), col('nature'), col('hsnSac'), col('qtyMilliText'), ...moneyCols('valuePaise'), col('hasBatch', 'bool'), col('hasSerial', 'bool'), col('reorderLevelMilliText')]), form('Add item', '/items', itemFields())],
  }),
  page({ path: '/item', title: 'Item', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request); const query = object(data.query)
      if (!query.id) return { ...data, document: {} }
      const item = rows(await read(actor, '/items', { archived: 'true' })).find(row => row.id === query.id)
      if (!item) throw new FinanceError(404, 'no_such_item', 'No such item.')
      const filter = { itemId: query.id, from: data.from, to: data.to }
      return { ...data, document: item, values: draftValues(item, data), balance: rows(await read(actor, '/stock/balance', filter)).map(row => display(row, data)), ledger: rows(await read(actor, '/stock/ledger', filter)).map(ledgerDisplay), batches: rows(await read(actor, '/batches', filter)).map(row => display(row, data)), serials: rows(await read(actor, '/stock/serials', filter)), groupOptions: rows(await read(actor, '/item-groups')).map(row => ({ value: str(row.id), label: str(row.name) })) }
    },
    record: data => { const item = object(data.document); return item.id ? { title: str(item.name), subtitle: `${item.code} · ${item.uom}`, audit: { entity: 'finance_item', entityId: str(item.id) } } : null },
    sections: data => {
      const item = object(data.document)
      if (!item.id) return [chooseRecord]
      return [filter('/item', data, [hidden('id', item.id), ...dateFields('from', 'to')]), table('Balance by store', 'balance', stockColumns), table('Stock ledger', 'ledger', ledgerColumns, { fixedOrder: true }), table('Batches', 'batches', [col('batchNo'), col('madeOn', 'date'), col('expiresOn', 'date'), col('qtyMilliText')]), table('Serials', 'serials', [col('serial'), col('status', 'status'), col('warehouse'), linkCol('assetId', '/asset', 'assetId')]), form('Edit item', '/items/update', [hidden('itemId', item.id), ...itemFields(true)], object(data.values)), form('Archive or restore item', '/items/archive', [hidden('itemId', item.id), ...checks('archived')], { archived: !!item.archivedAt })]
    },
  }),
  page({ path: '/warehouses', title: 'Warehouses', menu: 'Stock', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); const list = rows(await read(actor, '/warehouses')); return { ...data, rows: list.map(row => ({ ...row, archived: !!row.archivedAt })), warehouseOptions: list.map(row => ({ value: str(row.id), label: `${row.code} ${row.name}` })) } },
    sections: () => [table('Warehouses', 'rows', [col('code'), col('name'), col('isGroup', 'bool'), col('items'), ...moneyCols('valuePaise'), col('costCenter'), col('archived', 'bool')]), form('Add warehouse', '/warehouses', [...textFields('code', 'name'), select('parentId', 'warehouseOptions'), ...checks('isGroup'), select('stockAccountId', 'accounts'), select('costCenter', 'costCenters')], {}, ADMIN), form('Archive or restore warehouse', '/warehouses/archive', [select('warehouseId', 'warehouseOptions', { optional: false }), ...checks('archived')], {}, ADMIN)],
  }),
  page({ path: '/batches', title: 'Batches', menu: 'Stock', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); return { ...data, rows: rows(await read(actor, '/batches', object(data.query))).map(row => display(row, data)) } },
    sections: data => [filter('/batches', data, [select('itemId', 'stockItems')]), table('Batches', 'rows', [col('batchNo'), col('itemName'), col('madeOn', 'date'), col('expiresOn', 'date'), col('qtyMilliText')]), form('Add batch', '/batches', [select('itemId', 'stockItems', { optional: false }), field('batchNo', 'text', { optional: false }), ...dateFields('madeOn', 'expiresOn')])],
  }),
  ...documentPages({ path: '/stock-entry', base: '/stock-entries', key: 'entry', idField: 'stockEntryId', entity: 'finance_stock_entry', title: 'Stock entry', menu: 'Stock', roles: STAFF, scope: 'stock', kinds: ['receipt', 'issue', 'transfer', 'reconciliation'], filters: [],
    fields: data => [select('kind', ['receipt', 'issue', 'transfer', 'reconciliation'], { value: str(data.kind), optional: false }), ...dateFields('postingDate'), field('memo', 'textarea'), ...dimensions(), select('accountId', 'accounts'), hidden('materialRequestId', object(data.document).materialRequestId || object(data.query).materialRequestId), grid('lines', [select('itemId', 'stockItems'), ...(data.kind === 'issue' || data.kind === 'transfer' ? [select('fromWarehouseId', 'warehouses')] : []), ...(data.kind !== 'issue' ? [select('toWarehouseId', 'warehouses')] : []), field('qty', 'number', { step: 'any', label: data.kind === 'reconciliation' ? 'Counted quantity' : 'Quantity' }), ...(data.kind === 'receipt' || data.kind === 'reconciliation' ? [field('rate', 'money')] : []), field('batchNo'), field('expiresOn', 'date'), field('serials')])],
    columns: [col('itemName'), col('from'), col('to'), col('qtyMilliText'), ...moneyCols('ratePaise', 'amountPaise'), col('batchNo'), col('serials')],
    listColumns: [linkCol('number', '/stock-entry'), col('postingDate', 'date'), col('kind'), col('memo'), col('costCenter'), col('docstatus', 'status')],
  }),
  ...[
    { path: '/stock/balance', title: 'Stock balance', fields: [...dateFields('on'), select('warehouseId', 'warehouses'), select('itemId', 'stockItems')], columns: stockColumns },
    { path: '/stock/ledger', title: 'Stock ledger', fields: [select('itemId', 'stockItems'), select('warehouseId', 'warehouses'), ...dateFields('from', 'to')], columns: ledgerColumns },
    { path: '/stock/reorder', title: 'Reorder', fields: [], columns: [col('code'), col('name'), col('levelMilliText'), col('heldMilliText'), col('onOrderMilliText'), col('suggestMilliText')] },
    { path: '/stock/expiry', title: 'Expiring batches', fields: [field('days', 'number', { value: '30' })], columns: [col('batchNo'), col('itemName'), col('warehouse'), col('qtyMilliText'), col('expiresOn', 'date', { alertWhen: 'expired' })] },
    { path: '/stock/serials', title: 'Serial register', fields: [select('itemId', 'stockItems'), field('q')], columns: [col('serial'), col('itemName'), col('status', 'status'), col('warehouse'), linkCol('assetId', '/asset', 'assetId')] },
    { path: '/stock/against-books', title: 'Stores against books', fields: [], columns: [col('account'), ...moneyCols('stockPaise', 'booksPaise'), col('differencePaise', 'money', { alertWhen: 'differencePaise' })] },
  ].map(spec => page({ path: spec.path, title: spec.title, roles: OFFICE, menu: 'Stock',
    async load(actor, request) { const data = await context(actor, request); const list = rows(await read(actor, spec.path, { from: data.from, to: data.to, on: data.on, ...object(data.query) })).map(row => spec.path === '/stock/ledger' ? ledgerDisplay(row) : display(row, data)); return { ...data, rows: list, totals: { name: 'Total', valuePaise: list.reduce((sum, row) => sum + Number(row.valuePaise ?? 0), 0) } } },
    sections: data => [filter(spec.path, data, spec.fields), table(spec.title, 'rows', spec.columns, { fixedOrder: spec.path === '/stock/ledger', ...(spec.path === '/stock/balance' ? { footer: 'totals' } : {}) }), ...(spec.path === '/stock/reorder' ? [shortcuts('Order stock', [{ label: 'Raise purchase order', href: '/m/finance/order/new?kind=purchase_order' }])] : [])],
  })),
]
