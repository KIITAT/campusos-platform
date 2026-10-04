import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginField, PluginForm, Role } from '@campusos/module-framework'
import { accountFor, addCurrency, createAssetCategory, createBankAccount, createItem, createParty, createStockEntry, createWarehouse, grantJob, invoiceFromReceipt, listAccounts, receiptFromOrder, saveAsset, saveInvoice, saveMaterialRequest, saveOrder, savePayment, saveRfq, stockEntryDetail, submitStockEntry, submitOrder, submitInvoice, submitReceipt, type Actor } from './api'
import { pages } from './pages'
import { object, rows, type Data } from './screens/screen-kit'
import { stockEntries, stockLedger } from './schema'

const institutionIds: string[] = []
async function books() {
  const slug = `fin-screen-${randomUUID()}`
  const [institution] = await authDb.insert(institutions).values({ slug, name: 'Screen College', allowedEmailDomains: [`${slug}.test`] }).returning({ id: institutions.id })
  const id = institution!.id
  institutionIds.push(id)
  const people = await authDb.insert(users).values(['institution_admin', 'accounts_staff', 'faculty'].map(role => ({ institutionId: id, email: `${role}@${slug}.test`, role: role as Role, name: role }))).returning({ id: users.id, role: users.role, email: users.email })
  const actors = people.map(person => ({ ...person, institutionId: id }) as Actor)
  await listAccounts(actors[0]!)
  return { id, admin: actors[0]!, staff: actors[1]!, faculty: actors[2]! }
}
after(async () => { if (institutionIds.length) await authDb.delete(institutions).where(inArray(institutions.id, institutionIds)) })
const screen = (path: string) => { const selected = pages.find(page => page.path === path); assert.ok(selected, path); return selected }
const load = async (path: string, actor: Actor, query: Record<string, string> = {}) => {
  const page = screen(path)
  const data = await page.load(actor, new Request(`https://college.test/m/finance${path}?${new URLSearchParams({ from: '2026-10-01', to: '2026-10-31', on: '2026-10-31', ...query })}`))
  const checkFields = (fields: PluginField[]) => { for (const field of fields) { if (typeof field.options === 'string') assert.ok(Array.isArray(data[field.options]), `${path} is missing ${field.options} choices`); if (field.columns) checkFields(field.columns) } }
  for (const section of page.sections(data)) {
    if (section.kind === 'table') assert.ok(Array.isArray(data[section.rows]), `${path} is missing ${section.rows}`)
    if (section.kind === 'form') checkFields(section.fields)
  }
  return data
}
const payload = (path: string, data: Data, action: string) => {
  const section = screen(path).sections(data).find(section => section.kind === 'form' && section.path === action) as PluginForm | undefined
  assert.ok(section, `${path}: ${action}`)
  return Object.fromEntries(section.fields.filter(field => field.value !== undefined || field.kind === 'checkbox').map(field => [field.name, field.kind === 'lines' ? data[field.value!] : field.kind === 'checkbox' ? field.value ?? 'false' : field.value]))
}

test('all finance screens load complete table and nested form choices from the tenant database', async () => {
  const institution = await books()
  for (const page of pages) await load(page.path, institution.admin)
  const material = await load('/material-request/new', institution.faculty)
  assert.equal(material.parties, undefined)
  assert.equal(material.accounts, undefined)
  for (const path of ['/invoice/new', '/bank', '/reports/aging']) await assert.rejects(load(path, institution.faculty), error => object(error).code === 'forbidden')
})

test('invoice and payment forms round-trip currency units, allocations and linked draft lines', async () => {
  const institution = await books()
  const party = await createParty(institution.staff, { code: 'BUYER', name: 'Buyer', isCustomer: true, isSupplier: true })
  const item = await createItem(institution.staff, { code: 'SERVICE', name: 'Service', nature: 'service' })
  await addCurrency(institution.admin, { code: 'JPY', name: 'Japanese yen', minorUnits: 0 })
  const invoice = await saveInvoice(institution.staff, { kind: 'sales', partyId: party.id, currency: 'JPY', exchangeRate: '0.60', postingDate: '2026-10-01', lines: [{ itemId: item.id, qty: '2.5', rate: '400' }] })
  const draft = await load('/invoice', institution.staff, { id: invoice.id })
  assert.equal(rows(draft.editLines)[0]?.qty, '2.5')
  assert.equal(rows(draft.editLines)[0]?.rate, '400')
  assert.match(String(rows(draft.lines)[0]?.amountFcText), /^(?:JP)?¥1,000$/)
  const saved = await saveInvoice(institution.staff, payload('/invoice', draft, '/invoices'))
  assert.equal(saved.id, invoice.id)
  await submitInvoice(institution.staff, { invoiceId: invoice.id })
  const paying = await load('/payment/new', institution.staff, { partyId: party.id, invoiceId: invoice.id, currency: 'JPY', kind: 'receive' })
  assert.equal(rows(paying.editAllocations)[0]?.amount, '1000')
  const bank = await withTenant(institution.id, transaction => accountFor(transaction, institution.id, 'bank'))
  const payment = await savePayment(institution.staff, { ...payload('/payment/new', paying, '/payments'), accountId: bank, exchangeRate: '0.60', postingDate: '2026-10-01' })
  const paymentDraft = await load('/payment', institution.staff, { id: payment.id })
  assert.equal(rows(paymentDraft.editAllocations)[0]?.amount, '1000')
  assert.equal(await savePayment(institution.staff, payload('/payment', paymentDraft, '/payments')).then(result => result.id), payment.id)
  const outsider = await books()
  await assert.rejects(load('/invoice', outsider.admin, { id: invoice.id }), error => object(error).code === 'no_such_invoice')
})

test('draft stock forms preserve the entry, replace its lines and submit the edited quantities once', async () => {
  const institution = await books()
  const item = await createItem(institution.staff, { code: 'PAPER', name: 'Paper' })
  const entry = await createStockEntry(institution.staff, { kind: 'receipt', postingDate: '2026-10-01', lines: [{ itemId: item.id, qty: '2.5', rate: '12.50' }] })
  const draft = await load('/stock-entry', institution.staff, { id: entry.id })
  const body = payload('/stock-entry', draft, '/stock-entries')
  rows(body.lines)[0]!.qty = '3.5'
  const edited = await createStockEntry(institution.staff, body)
  assert.equal(edited.id, entry.id)
  const updated = await stockEntryDetail(institution.staff, entry.id)
  assert.equal(updated.lines.length, 1)
  assert.equal(updated.lines[0]?.qtyMilli, 3500)
  assert.equal(updated.lines[0]?.ratePaise, 1250)
  assert.equal((await withTenant(institution.id, transaction => transaction.select().from(stockEntries))).length, 1)
  assert.deepEqual(await withTenant(institution.id, transaction => transaction.select().from(stockLedger)), [])
  await submitStockEntry(institution.staff, { stockEntryId: entry.id })
  const movements = await withTenant(institution.id, transaction => transaction.select().from(stockLedger).where(eq(stockLedger.voucherId, entry.id)))
  assert.equal(movements.length, 1)
  assert.equal(movements[0]?.qtyChangeMilli, 3500)
  assert.equal(movements[0]?.valueChangePaise, 4375)
  await assert.rejects(submitStockEntry(institution.staff, { stockEntryId: entry.id }), error => object(error).code === 'not_a_draft')
  assert.deepEqual(await withTenant(institution.id, transaction => transaction.select().from(stockLedger).where(eq(stockLedger.voucherId, entry.id))), movements)
})

test('submitted and foreign-tenant stock edits leave existing entries and lines untouched', async () => {
  const institution = await books()
  const item = await createItem(institution.staff, { code: 'PAPER', name: 'Paper' })
  const entry = await createStockEntry(institution.staff, { kind: 'receipt', postingDate: '2026-10-01', lines: [{ itemId: item.id, qty: '2', rate: '12.50' }], submit: true })
  const original = await stockEntryDetail(institution.staff, entry.id)
  const body = { stockEntryId: entry.id, kind: 'receipt', lines: [{ itemId: item.id, qty: '3', rate: '12.50' }] }
  await assert.rejects(createStockEntry(institution.staff, body), error => object(error).code === 'not_a_draft')
  assert.deepEqual(await stockEntryDetail(institution.staff, entry.id), original)
  assert.equal((await withTenant(institution.id, transaction => transaction.select().from(stockEntries))).length, 1)
  const other = await books()
  const otherItem = await createItem(other.staff, { code: 'OTHER', name: 'Other paper' })
  await assert.rejects(createStockEntry(other.staff, { ...body, lines: [{ itemId: otherItem.id, qty: '3', rate: '12.50' }] }), error => object(error).code === 'no_such_stock_entry')
  assert.deepEqual(await stockEntryDetail(institution.staff, entry.id), original)
  assert.deepEqual(await withTenant(other.id, transaction => transaction.select().from(stockEntries)), [])
})

test('stock draft edits require access to both the existing and replacement warehouses', async () => {
  const institution = await books()
  const item = await createItem(institution.staff, { code: 'PAPER', name: 'Paper' })
  const allowed = await createWarehouse(institution.admin, { code: 'ALLOWED', name: 'Allowed store' })
  const restricted = await createWarehouse(institution.admin, { code: 'RESTRICTED', name: 'Restricted store' })
  await grantJob(institution.admin, { userId: institution.faculty.id, capability: 'storekeeper', warehouseId: allowed.id })
  for (const [source, destination] of [[allowed.id, restricted.id], [restricted.id, allowed.id]]) {
    const entry = await createStockEntry(institution.staff, { kind: 'receipt', lines: [{ itemId: item.id, qty: '2', rate: '12.50', toWarehouseId: source }] })
    const original = await stockEntryDetail(institution.staff, entry.id)
    await assert.rejects(createStockEntry(institution.faculty, { stockEntryId: entry.id, kind: 'receipt', lines: [{ itemId: item.id, qty: '3', rate: '12.50', toWarehouseId: destination }] }), error => object(error).code === 'forbidden')
    assert.deepEqual(await stockEntryDetail(institution.staff, entry.id), original)
  }
  assert.equal((await withTenant(institution.id, transaction => transaction.select().from(stockEntries))).length, 2)
})

test('purchasing, asset and request detail screens retain operational records and ownership', async () => {
  const institution = await books()
  const party = await createParty(institution.staff, { code: 'SUP', name: 'Supplier', isSupplier: true })
  const item = await createItem(institution.staff, { code: 'DESK', name: 'Desk' })
  const request = await saveMaterialRequest(institution.faculty, { purpose: 'purchase', lines: [{ itemId: item.id, qty: '2' }], submit: true })
  await load('/material-request', institution.faculty, { id: request.id })
  const order = await saveOrder(institution.staff, { kind: 'purchase_order', partyId: party.id, postingDate: '2026-10-01', lines: [{ itemId: item.id, qty: '2', rate: '500' }] })
  const orderDraft = await load('/order', institution.staff, { id: order.id })
  assert.equal(rows(orderDraft.editLines)[0]?.rate, '500')
  await submitOrder(institution.staff, { orderId: order.id })
  const receipt = await receiptFromOrder(institution.staff, { orderId: order.id, postingDate: '2026-10-01' })
  await load('/receipt', institution.staff, { id: receipt.id })
  await submitReceipt(institution.staff, { receiptId: receipt.id })
  const invoice = await invoiceFromReceipt(institution.staff, { receiptId: receipt.id, postingDate: '2026-10-01' })
  const invoiceDraft = await load('/invoice', institution.staff, { id: invoice.id })
  assert.ok(rows(invoiceDraft.editLines)[0]?.receiptLineId)
  assert.equal(await saveInvoice(institution.staff, payload('/invoice', invoiceDraft, '/invoices')).then(result => result.id), invoice.id)
  const category = await createAssetCategory(institution.admin, { name: 'Furniture', method: 'slm', lifeYears: '5' })
  const asset = await saveAsset(institution.staff, { name: 'Opening desk', categoryId: category.id, purchasedOn: '2025-01-01', inUseOn: '2025-01-01', gross: '500', existing: true, openingAccumulated: '100' })
  const assetDraft = await load('/asset', institution.staff, { id: asset.id })
  assert.equal(object(assetDraft.values).existing, 'true')
  assert.equal(object(assetDraft.values).openingAccumulated, '100')
  const rfq = await saveRfq(institution.staff, { requestId: request.id, supplierIds: [party.id], submit: true })
  await load('/rfq', institution.staff, { id: rfq.id })
  const quoteDraft = await load('/supplier-quotation/new', institution.staff, { rfqId: rfq.id })
  assert.ok(rows(quoteDraft.editLines)[0]?.rfqLineId)
  const bank = await createBankAccount(institution.admin, { bankName: 'College bank', accountNumber: '123456' })
  await load('/bank-account', institution.staff, { id: bank.id })
  await load('/bank/reconciliation', institution.staff, { bankAccountId: bank.id })
})
