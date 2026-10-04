import { jsonBody, requiredParam, type PluginActor, type PluginRoute } from '@campusos/module-framework'
import type * as z from 'zod'
import * as api from './api'

/**
 * Every operation of the books, as an HTTP route.
 *
 * Declared once, as a list of what each route does and what it takes: the
 * routes are this list, and so is the OpenAPI document (api/openapi.ts reads
 * it), so the two cannot drift apart.
 */

type A = api.Actor
type Query = Record<string, string | undefined>

export interface RouteSpec extends PluginRoute {
  summary: string
  /** The request body's schema, for the API document. */
  body?: z.ZodType
  tag: string
}

const as = (actor: PluginActor) => actor as A
const query = (req: Request): Query => Object.fromEntries(new URL(req.url).searchParams)

function post(tag: string, path: string, summary: string, fn: (a: A, body: unknown) => Promise<unknown>, body?: z.ZodType): RouteSpec {
  return { method: 'POST', path, summary, body, tag, handler: async (actor, req) => fn(as(actor), await jsonBody(req)) }
}
function get(tag: string, path: string, summary: string, fn: (a: A, q: Query) => Promise<unknown>): RouteSpec {
  return { method: 'GET', path, summary, tag, handler: (actor, req) => fn(as(actor), query(req)) }
}
/** Bytes, not JSON: a printed document or a spreadsheet. */
function file(
  tag: string,
  path: string,
  summary: string,
  fn: (a: A, req: Request) => Promise<{ bytes: Uint8Array | string; fileName: string; type?: string }>,
): RouteSpec {
  return {
    method: 'GET',
    path,
    summary,
    tag,
    raw: true,
    handler: async (actor, req) => {
      const out = await fn(as(actor), req)
      const type = out.type ?? 'application/pdf'
      return new Response(out.bytes as unknown as BodyInit, {
        headers: {
          'content-type': type,
          'content-disposition': `${type.startsWith('text/csv') ? 'attachment' : 'inline'}; filename="${out.fileName}"`,
          'cache-control': 'no-store',
        },
      })
    },
  }
}

const csv = (rows: Record<string, unknown>[], name: string) => ({
  bytes: api.toCsv(rows),
  fileName: `${name}.csv`,
  type: 'text/csv; charset=utf-8',
})
const today = () => new Date().toISOString().slice(0, 10)
const range = (q: Query) => ({ from: q.from ?? `${today().slice(0, 8)}01`, to: q.to ?? today() })
const side = (q: Query) => (q.side === 'payable' ? 'payable' : 'receivable') as 'receivable' | 'payable'
const kind = (q: Query) => (q.kind === 'purchase' ? 'purchase' : 'sales') as 'sales' | 'purchase'

export const specs: RouteSpec[] = [
  // --- the ledger --------------------------------------------------------------------
  get('ledger', '/accounts', 'The chart of accounts, as a tree', (a) => api.listAccounts(a)),
  post('ledger', '/accounts', 'Add an account or a group to the chart', api.createAccount, api.createAccountSchema),
  post('ledger', '/accounts/update', 'Rename, move or re-purpose an account', api.updateAccount, api.updateAccountSchema),
  post('ledger', '/accounts/archive', 'Close an account to new postings, or reopen it', api.archiveAccount, api.archiveAccountSchema),
  get('ledger', '/journal', 'Posted entries, most recent first', (a) => api.listEntries(a)),
  get('ledger', '/journal/lines', 'The lines of one entry', (a, q) => api.entryLines(a, q.entryId ?? '')),
  post('ledger', '/journal', 'Post one balanced entry by hand (administrators; the office uses journal vouchers)', api.postEntry, api.postEntrySchema),
  post('ledger', '/journal/reverse', 'Post the mirror image of an entry', api.reverseEntry, api.reverseEntrySchema),
  get('ledger', '/trial-balance', 'Every account with its debits, credits and balance', (a, q) => api.trialBalance(a, { from: q.from, to: q.to })),
  get('ledger', '/periods', 'Accounting months and whether each is open', (a, q) => api.listPeriods(a, { year: q.year })),
  post('ledger', '/periods/close', 'Close a month', api.closePeriod, api.closePeriodSchema),
  post('ledger', '/periods/reopen', 'Open a closed month again, with a reason', api.reopenPeriod, api.reopenPeriodSchema),
  get('ledger', '/budgets', 'Budget against actual by cost centre for a fiscal year', (a, q) => api.budgetReport(a, { year: q.year, costCenter: q.costCenter })),
  post('ledger', '/budgets', "Set a cost centre's budget on an account for a year", api.setBudget, api.setBudgetSchema),

  // --- settings and lists ---------------------------------------------------------
  get('setup', '/settings', "The institution's book-keeping settings", (a) => api.getSettings(a)),
  post('setup', '/settings', 'Change the settings', api.updateSettings, api.updateSettingsSchema),
  get('setup', '/fiscal-years', 'Fiscal years and whether each is closed', (a) => api.listFiscalYears(a)),
  post('setup', '/fiscal-years/close', 'Close a fiscal year: carry its result to retained surplus', api.closeFiscalYear),
  post('setup', '/fiscal-years/reopen', 'Reopen the latest closed fiscal year, with a reason', api.reopenFiscalYear),
  get('setup', '/cost-centers', 'Cost centres, as a tree', (a) => api.listCostCenters(a)),
  post('setup', '/cost-centers', 'Add a cost centre', api.createCostCenter, api.costCenterSchema),
  post('setup', '/cost-centers/archive', 'Close or reopen a cost centre', api.archiveCostCenter),
  get('setup', '/funds', 'Funds and grants', (a) => api.listFunds(a)),
  post('setup', '/funds', 'Add a fund or grant', api.createFund, api.fundSchema),
  get('setup', '/currencies', 'Currencies kept, and exchange rates entered', (a) => api.listCurrencies(a)),
  post('setup', '/currencies', 'Add a currency', api.addCurrency, api.currencySchema),
  post('setup', '/currencies/rates', 'Enter an exchange rate for a day', api.setRate, api.rateSchema),
  post('setup', '/currencies/revalue', "Value open foreign-currency balances at a day's rates (reversed the next day)", api.revalueForeign),
  get('setup', '/series', 'How each kind of document is numbered', (a) => api.listSeries(a)),
  post('setup', '/series', 'Change how a kind of document is numbered', api.setSeries, api.seriesSchema),
  get('setup', '/approval-rules', 'Who approves which documents, from what amount', (a) => api.listApprovalRules(a)),
  post('setup', '/approval-rules', 'Set an approval rule', api.setApprovalRule, api.approvalRuleSchema),
  post('setup', '/approval-rules/remove', 'Remove an approval rule', api.removeApprovalRule),
  post('setup', '/approvals/decide', 'Approve or refuse a draft as it stands', api.decideApproval, api.decideSchema),
  get('setup', '/approvals/pending', 'Drafts waiting for an approval this reader may give', (a) => api.pendingApprovals(a)),
  get('setup', '/staff', 'Staff given jobs in the books: storekeepers, purchasers, approvers', (a) => api.listStaff(a)),
  post('setup', '/staff', 'Give a member of staff a job', api.grantJob, api.staffSchema),
  post('setup', '/staff/revoke', 'Take a job back', api.revokeJob),
  get('tax', '/taxes', 'Tax templates and TDS sections', (a) => api.listTaxes(a)),
  post('tax', '/taxes', 'Add a tax template', api.createTaxTemplate, api.taxTemplateSchema),
  post('tax', '/taxes/archive', 'Retire a tax template', api.archiveTaxTemplate),
  post('tax', '/tds-sections', 'Add a TDS section', api.createTdsSection, api.tdsSectionSchema),
  post('tax', '/taxes/india-preset', 'Load the India starter set: GST accounts and slabs, TDS sections (to be checked)', (a) => api.loadIndiaPreset(a)),

  // --- parties ---------------------------------------------------------------------
  get('parties', '/parties', 'Customers and suppliers, with what each owes or is owed', (a, q) =>
    api.listParties(a, { side: q.side as 'customer' | 'supplier' | undefined, q: q.q, archived: q.archived === 'true' })),
  post('parties', '/parties', 'Add a customer or supplier', api.createParty, api.partySchema),
  post('parties', '/parties/update', 'Change a party', api.updateParty, api.updatePartySchema),
  post('parties', '/parties/archive', 'Archive or restore a party', api.archiveParty),
  get('parties', '/parties/statement', "A party's statement of account", (a, q) =>
    api.partyStatement(a, { partyId: q.partyId ?? '', side: q.side ? side(q) : undefined, from: q.from, to: q.to })),
  post('parties', '/parties/apply-advances', "Set a party's advances and credit notes against their open invoices", api.applyAdvances),

  // --- stock -----------------------------------------------------------------------
  get('stock', '/uoms', 'Units of measure', (a) => api.listUoms(a)),
  post('stock', '/uoms', 'Add a unit of measure', api.createUom, api.uomSchema),
  get('stock', '/item-groups', 'Item groups', (a) => api.listItemGroups(a)),
  post('stock', '/item-groups', 'Add an item group', api.createItemGroup, api.itemGroupSchema),
  get('stock', '/items', 'Items, with what the stores hold of each', (a, q) => api.listItems(a, { q: q.q, groupId: q.groupId, archived: q.archived === 'true' })),
  post('stock', '/items', 'Add an item', api.createItem, api.itemSchema),
  post('stock', '/items/update', 'Change an item', api.updateItem, api.updateItemSchema),
  post('stock', '/items/archive', 'Archive or restore an item', api.archiveItem),
  get('stock', '/warehouses', 'Stores, with what each holds', (a) => api.listWarehouses(a)),
  post('stock', '/warehouses', 'Add a store', api.createWarehouse, api.warehouseSchema),
  post('stock', '/warehouses/archive', 'Archive or restore a store', api.archiveWarehouse),
  get('stock', '/batches', 'Batches, with what is left of each', (a, q) => api.listBatches(a, { itemId: q.itemId })),
  post('stock', '/batches', 'Add a batch', api.createBatch, api.batchSchema),
  get('stock', '/stock-entries', 'Stock entries: receipts, issues, transfers and counts', (a, q) => api.listStockEntries(a, { kind: q.kind, status: q.status })),
  get('stock', '/stock-entries/detail', 'One stock entry with its lines', (a, q) => api.stockEntryDetail(a, q.stockEntryId ?? '')),
  post('stock', '/stock-entries', 'Save a stock entry (and submit it, if asked)', api.createStockEntry, api.stockEntrySchema),
  post('stock', '/stock-entries/submit', 'Submit a stock entry: move the stock and post its value', api.submitStockEntry),
  post('stock', '/stock-entries/cancel', 'Cancel a stock entry', api.cancelStockEntry),
  post('stock', '/stock-entries/delete', 'Delete a draft stock entry', api.deleteStockEntry),
  get('stock', '/stock/balance', 'Stock balance by item and store, on a day', (a, q) => api.stockBalance(a, { on: q.on, warehouseId: q.warehouseId, itemId: q.itemId })),
  get('stock', '/stock/ledger', 'Every movement of stock, with running balances', (a, q) =>
    api.stockLedgerReport(a, { itemId: q.itemId, warehouseId: q.warehouseId, from: q.from, to: q.to })),
  get('stock', '/stock/reorder', 'Items at or below their reorder level', (a) => api.reorderReport(a)),
  get('stock', '/stock/expiry', 'Batches expired or expiring soon', (a, q) => api.expiryReport(a, { days: q.days ? Number(q.days) : undefined })),
  get('stock', '/stock/serials', 'Serial numbers and where each is', (a, q) => api.serialRegister(a, { itemId: q.itemId, q: q.q })),
  get('stock', '/stock/against-books', 'Whether the stores and the stock accounts agree', (a) => api.stockAgainstBooks(a)),

  // --- invoices ----------------------------------------------------------------------
  get('invoices', '/invoices', 'Sales or purchase invoices, with what is still owed on each', (a, q) =>
    api.listInvoices(a, { kind: q.kind ? kind(q) : undefined, status: q.status, partyId: q.partyId, q: q.q, from: q.from, to: q.to })),
  get('invoices', '/invoices/detail', 'One invoice: lines, taxes, settlements, posting', (a, q) => api.invoiceDetail(a, q.invoiceId ?? '')),
  post('invoices', '/invoices', 'Save an invoice as a draft (and submit it, if asked)', api.saveInvoice, api.invoiceSchema),
  post('invoices', '/invoices/submit', 'Submit an invoice: number it and post it', api.submitInvoice),
  post('invoices', '/invoices/cancel', 'Cancel an invoice', api.cancelInvoice),
  post('invoices', '/invoices/amend', 'Copy a cancelled invoice into a new draft', api.amendInvoice),
  post('invoices', '/invoices/delete', 'Delete a draft invoice', api.deleteInvoice),
  post('invoices', '/invoices/return', 'Raise a credit note or debit note against an invoice', api.makeReturn, api.returnSchema),
  post('invoices', '/invoices/from-receipt', 'Draft an invoice for what a goods receipt or delivery note brought', api.invoiceFromReceipt),
  post('invoices', '/invoices/from-order', 'Draft an invoice for what is left to bill on an order', api.invoiceFromOrder),
  file('invoices', '/invoices/pdf', 'The invoice, printed', (a, req) => api.invoicePdf(a, requiredParam(req, 'invoiceId'))),
  get('invoices', '/recurring', 'Recurring invoices', (a) => api.listRecurring(a)),
  post('invoices', '/recurring', 'Repeat an invoice every month, quarter or year', api.makeRecurring, api.recurringSchema),
  post('invoices', '/recurring/stop', 'Stop a recurring invoice', api.stopRecurring),
  post('invoices', '/recurring/run', 'Raise every recurring invoice that has fallen due', api.runRecurring),

  // --- payments and vouchers -----------------------------------------------------------
  get('payments', '/payments', 'Receipts, payments and transfers', (a, q) =>
    api.listPayments(a, { kind: q.kind as 'receive' | 'pay' | 'transfer' | undefined, partyId: q.partyId, status: q.status, from: q.from, to: q.to })),
  get('payments', '/payments/detail', 'One payment with what it settled', (a, q) => api.paymentDetail(a, q.paymentId ?? '')),
  get('payments', '/payments/open-invoices', "A party's open invoices, oldest first", (a, q) =>
    api.openInvoicesFor(a, { partyId: q.partyId ?? '', side: side(q), currency: q.currency })),
  post('payments', '/payments', 'Save a payment as a draft (and submit it, if asked)', api.savePayment, api.paymentSchema),
  post('payments', '/payments/submit', 'Submit a payment', api.submitPayment),
  post('payments', '/payments/cancel', 'Cancel a payment', api.cancelPayment),
  post('payments', '/payments/amend', 'Copy a cancelled payment into a new draft', api.amendPayment),
  post('payments', '/payments/delete', 'Delete a draft payment', api.deletePayment),
  file('payments', '/payments/pdf', 'The receipt or voucher, printed', (a, req) => api.paymentPdf(a, requiredParam(req, 'paymentId'))),
  get('payments', '/vouchers', 'Journal vouchers', (a, q) => api.listJournals(a, { kind: q.kind, status: q.status })),
  get('payments', '/vouchers/detail', 'One journal voucher', (a, q) => api.journalDetail(a, q.journalId ?? '')),
  post('payments', '/vouchers', 'Save a journal voucher (and submit it, if asked)', api.saveJournal, api.journalSchema),
  post('payments', '/vouchers/submit', 'Submit a journal voucher', api.submitJournal),
  post('payments', '/vouchers/cancel', 'Cancel a journal voucher', api.cancelJournal),
  post('payments', '/vouchers/amend', 'Copy a cancelled voucher into a new draft', api.amendJournal),
  post('payments', '/vouchers/delete', 'Delete a draft voucher', api.deleteJournal),

  // --- orders and receipts -----------------------------------------------------------
  get('orders', '/orders', 'Quotations, sales orders or purchase orders, with their status', (a, q) =>
    api.listOrders(a, { kind: (q.kind as api.OrderKind) ?? 'purchase_order', status: q.status, partyId: q.partyId })),
  get('orders', '/orders/detail', 'One order with what has been received, delivered and billed', (a, q) => api.orderDetail(a, q.orderId ?? '')),
  post('orders', '/orders', 'Save an order as a draft (and submit it, if asked)', api.saveOrder, api.orderSchema),
  post('orders', '/orders/submit', 'Submit an order', api.submitOrder),
  post('orders', '/orders/cancel', 'Cancel an order nothing has moved against', api.cancelOrder),
  post('orders', '/orders/close', 'Close an order short', api.closeOrder),
  post('orders', '/orders/amend', 'Copy a cancelled order into a new draft', api.amendOrder),
  post('orders', '/orders/delete', 'Delete a draft order', api.deleteOrder),
  post('orders', '/orders/from-quotation', 'Draft a sales order from a quotation', api.orderFromQuotation),
  post('orders', '/orders/from-supplier-quotation', "Draft a purchase order from a supplier's quotation", api.orderFromSupplierQuotation),
  file('orders', '/orders/pdf', 'The order, printed', (a, req) => api.orderPdf(a, requiredParam(req, 'orderId'))),
  get('orders', '/receipts', 'Goods receipts and delivery notes', (a, q) =>
    api.listReceipts(a, { kind: q.kind as 'purchase_receipt' | 'delivery_note' | undefined, partyId: q.partyId })),
  get('orders', '/receipts/detail', 'One goods receipt or delivery note', (a, q) => api.receiptDetail(a, q.receiptId ?? '')),
  post('orders', '/receipts', 'Save a goods receipt or delivery note (and submit it, if asked)', api.saveReceipt, api.receiptSchema),
  post('orders', '/receipts/submit', 'Submit a receipt: move the stock and post its value', api.submitReceipt),
  post('orders', '/receipts/cancel', 'Cancel a receipt', api.cancelReceipt),
  post('orders', '/receipts/delete', 'Delete a draft receipt', api.deleteReceipt),
  post('orders', '/receipts/return', 'Return goods against a receipt or delivery note', api.returnReceipt),
  post('orders', '/receipts/from-order', 'Draft a receipt or delivery note for what is left on an order', api.receiptFromOrder),

  // --- buying ----------------------------------------------------------------------
  get('buying', '/material-requests', 'Requests to the stores', (a, q) => api.listMaterialRequests(a, { mine: q.mine === 'true', status: q.status })),
  get('buying', '/material-requests/detail', 'One request with what has been issued and ordered', (a, q) => api.materialRequestDetail(a, q.requestId ?? '')),
  post('buying', '/material-requests', 'Ask the stores for something', api.saveMaterialRequest, api.materialRequestSchema),
  post('buying', '/material-requests/submit', 'Send a request to the stores', api.submitMaterialRequest),
  post('buying', '/material-requests/cancel', 'Withdraw a request', api.cancelMaterialRequest),
  post('buying', '/material-requests/issue', 'Draft an issue from the stores for a request', api.issueFromRequest),
  post('buying', '/material-requests/order', 'Draft a purchase order for a request', api.orderFromRequest),
  get('buying', '/rfqs', 'Requests for quotation', (a) => api.listRfqs(a)),
  get('buying', '/rfqs/compare', 'The quotations for a request, side by side', (a, q) => api.compareQuotations(a, q.rfqId ?? '')),
  post('buying', '/rfqs', 'Ask suppliers for prices', api.saveRfq, api.rfqSchema),
  get('buying', '/supplier-quotations', "Suppliers' quotations", (a) => api.listSupplierQuotations(a)),
  post('buying', '/supplier-quotations', "Record a supplier's quotation", api.saveSupplierQuotation, api.supplierQuotationSchema),
  get('buying', '/commitments', 'Purchase orders not yet billed, by cost centre', (a) => api.commitments(a)),

  // --- fixed assets ------------------------------------------------------------------
  get('assets', '/asset-categories', 'Asset categories and how each depreciates', (a) => api.listAssetCategories(a)),
  post('assets', '/asset-categories', 'Add an asset category', api.createAssetCategory, api.assetCategorySchema),
  get('assets', '/assets', 'The fixed asset register on a day', (a, q) => api.assetRegister(a, { on: q.on, categoryId: q.categoryId, status: q.status })),
  get('assets', '/assets/detail', 'One asset: its schedule and its history', (a, q) => api.assetDetail(a, q.assetId ?? '')),
  post('assets', '/assets', 'Save an asset (and capitalise it, if asked)', api.saveAsset, api.assetSchema),
  post('assets', '/assets/submit', 'Capitalise an asset and write its depreciation schedule', api.submitAsset),
  post('assets', '/assets/cancel', 'Cancel an asset that has not depreciated or moved', api.cancelAsset),
  post('assets', '/assets/delete', 'Delete a draft asset', api.deleteAsset),
  post('assets', '/assets/events', 'Record a transfer, maintenance, count, write-down, sale or scrapping', api.recordAssetEvent, api.assetEventSchema),
  post('assets', '/depreciation/run', 'Post every period of depreciation that has ended', api.postDepreciation),
  get('assets', '/depreciation', 'Depreciation for a period, by category', (a, q) => api.depreciationReport(a, range(q))),
  get('assets', '/assets/maintenance-due', 'Maintenance due or overdue', (a, q) => api.maintenanceDue(a, { days: q.days ? Number(q.days) : undefined })),

  // --- the bank --------------------------------------------------------------------
  get('bank', '/bank-accounts', 'Bank accounts, with their book balance and unmatched lines', (a) => api.listBankAccounts(a)),
  post('bank', '/bank-accounts', 'Add a bank account', api.createBankAccount, api.bankAccountSchema),
  post('bank', '/bank-accounts/mapping', "Say which column of this bank's downloads is which", api.setMapping, api.mappingSchema),
  post('bank', '/bank-statements/import', 'Import a statement: CSV, XLSX, MT940 or camt.053', api.importStatement),
  post('bank', '/bank-statements/delete', 'Remove a statement none of whose lines is matched', api.deleteStatement),
  get('bank', '/bank-statements', 'Statements imported for a bank account', (a, q) => api.listStatements(a, q.bankAccountId ?? '')),
  get('bank', '/bank-lines', 'Statement lines, by status', (a, q) =>
    api.statementLines(a, { bankAccountId: q.bankAccountId ?? '', status: q.status, statementId: q.statementId })),
  get('bank', '/bank-lines/candidates', 'The postings a statement line could be', (a, q) => api.candidatesFor(a, q.lineId ?? '')),
  post('bank', '/bank-lines/match', 'Match a statement line to a posting', api.matchLine),
  post('bank', '/bank-lines/unmatch', 'Undo a match', api.unmatchLine),
  post('bank', '/bank-lines/ignore', 'Set a statement line aside, with a note', api.ignoreLine),
  post('bank', '/bank-lines/post', 'Post a statement line the books do not have yet, and match it', api.postFromLine),
  post('bank', '/bank/auto-match', 'Match every line that can only mean one posting', api.autoMatch),
  get('bank', '/bank-rules', 'Rules that post recurring bank lines', (a) => api.listBankRules(a)),
  post('bank', '/bank-rules', 'Add a bank rule', api.createBankRule, api.bankRuleSchema),
  post('bank', '/bank-rules/delete', 'Remove a bank rule', api.deleteBankRule),
  post('bank', '/bank-rules/apply', 'Post and match every unmatched line a rule recognises', api.applyRules),
  get('bank', '/bank/reconciliation', 'The bank reconciliation statement on a day', (a, q) =>
    api.reconciliation(a, { bankAccountId: q.bankAccountId ?? '', on: q.on ?? today() })),

  // --- reports ---------------------------------------------------------------------
  get('reports', '/reports/trial-balance', 'Trial balance with opening and closing, as a tree', (a, q) => api.trialBalanceReport(a, q)),
  get('reports', '/reports/income-expenditure', 'Income and expenditure for a period', (a, q) => api.incomeAndExpenditure(a, { ...q, compare: q.compare === 'true' })),
  get('reports', '/reports/balance-sheet', 'The balance sheet on a day', (a, q) => api.balanceSheet(a, q)),
  get('reports', '/reports/cash', 'Receipts and payments, and the cash flow statement', (a, q) => api.cashMovements(a, q)),
  get('reports', '/reports/general-ledger', "An account's ledger for a period", (a, q) =>
    api.generalLedger(a, { accountId: q.accountId ?? '', from: q.from, to: q.to, partyId: q.partyId, costCenter: q.costCenter })),
  get('reports', '/reports/day-book', 'Every entry in a period', (a, q) => api.dayBook(a, q)),
  get('reports', '/reports/aging', 'Receivables or payables by age', (a, q) => api.aging(a, { side: side(q), on: q.on, partyId: q.partyId })),
  get('reports', '/reports/fund-statement', "A fund's statement: received, spent by head, and left", (a, q) =>
    api.fundStatement(a, { fundId: q.fundId ?? '', from: q.from, to: q.to })),
  get('reports', '/reports/funds', "Every fund's balance", (a, q) => api.fundBalances(a, q)),
  get('reports', '/reports/cost-centers', 'Income and expenditure by cost centre', (a, q) => api.costCenterReport(a, q)),
  get('reports', '/reports/gstr1', 'GSTR-1 tables for a period', (a, q) => api.gstr1(a, range(q))),
  get('reports', '/reports/gstr3b', 'GSTR-3B summary for a period', (a, q) => api.gstr3b(a, range(q))),
  get('reports', '/reports/hsn', 'HSN/SAC summary', (a, q) => api.hsnReport(a, { kind: kind(q), ...range(q) })),
  get('reports', '/reports/register', 'Sales or purchase register', (a, q) => api.register(a, { kind: kind(q), ...range(q) })),
  get('reports', '/reports/tds', 'Tax deducted at source by section and payee', (a, q) => api.tdsReport(a, range(q))),
  file(
    'reports',
    '/reports/export.csv',
    'A report as CSV: report=gstr1 (table=b2b|b2cl|b2cs|cdnr|cdnur|exports|sez), hsn, register, tds, aging, trial-balance, general-ledger',
    async (a, req) => {
      const q = query(req)
      const r = range(q)
      switch (q.report) {
        case 'gstr1': {
          const g = await api.gstr1(a, r)
          const table = (['b2b', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'exports', 'sez'].includes(q.table ?? '') ? q.table : 'b2b') as
            | 'b2b'
            | 'b2cl'
            | 'b2cs'
            | 'cdnr'
            | 'cdnur'
            | 'exports'
            | 'sez'
          return csv(g[table] as unknown as Record<string, unknown>[], `gstr1-${table}-${r.from}-${r.to}`)
        }
        case 'hsn':
          return csv(await api.hsnReport(a, { kind: kind(q), ...r }), `hsn-${kind(q)}-${r.from}-${r.to}`)
        case 'register':
          return csv(await api.register(a, { kind: kind(q), ...r }), `${kind(q)}-register-${r.from}-${r.to}`)
        case 'tds':
          return csv((await api.tdsReport(a, r)).deducted, `tds-${r.from}-${r.to}`)
        case 'aging': {
          const ag = await api.aging(a, { side: side(q), on: q.on })
          return csv(
            ag.rows.map((p) => ({
              party: p.name,
              notYetDuePaise: p.buckets[0],
              upTo30Paise: p.buckets[1],
              upTo60Paise: p.buckets[2],
              upTo90Paise: p.buckets[3],
              upTo180Paise: p.buckets[4],
              over180Paise: p.buckets[5],
              advancePaise: p.advancePaise,
              totalPaise: p.totalPaise,
            })),
            `aging-${side(q)}-${ag.on}`,
          )
        }
        case 'trial-balance': {
          const tb = await api.trialBalanceReport(a, q)
          return csv(tb.rows.map((row) => api.without(row, 'id', 'parentId')), `trial-balance-${tb.from}-${tb.to}`)
        }
        case 'general-ledger': {
          const gl = await api.generalLedger(a, { accountId: q.accountId ?? '', from: q.from, to: q.to })
          return csv(gl.lines.map((row) => api.without(row, 'id', 'entryId')), `ledger-${gl.account.code}-${gl.from}-${gl.to}`)
        }
      }
      throw new api.FinanceError(400, 'no_such_report', 'no such report')
    },
  ),
]

export const routes: PluginRoute[] = specs.map((s) => api.without(s, 'summary', 'body', 'tag'))
