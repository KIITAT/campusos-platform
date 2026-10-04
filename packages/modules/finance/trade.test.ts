import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import {
  FinanceError,
  accountFor,
  aging,
  applyRules,
  assetDetail,
  assetRegister,
  balanceSheet,
  bankDate,
  bankAmount,
  cashMovements,
  createAssetCategory,
  createBankAccount,
  createBankRule,
  createFund,
  createItem,
  createParty,
  decideApproval,
  pendingApprovals,
  depreciationScheduleFor,
  fundStatement,
  grantJob,
  gstr1,
  gstr3b,
  importStatement,
  incomeAndExpenditure,
  invoiceDetail,
  invoiceFromReceipt,
  invoicePdf,
  issueFromRequest,
  listMaterialRequests,
  loadIndiaPreset,
  orderDetail,
  orderFromQuotation,
  parseCamt053,
  parseMt940,
  parseStatement,
  postDepreciation,
  reconciliation,
  receiptFromOrder,
  recordAssetEvent,
  saveAsset,
  saveInvoice,
  saveMaterialRequest,
  saveOrder,
  savePayment,
  setApprovalRule,
  stockBalance,
  submitAsset,
  submitOrder,
  submitReceipt,
  cancelReceipt,
  trialBalance,
  trialBalanceReport,
  updateSettings,
  createStockEntry,
  type Actor,
} from './api'
import { assets, taxTemplates } from './schema'

/**
 * Orders and what moves against them, the stores, fixed assets, the bank, and
 * the statements and returns read from all of it.
 */

let n = 0
const SLUG = 'fin-trade-'
const DAY = '2026-10-01'

interface Books {
  id: string
  admin: Actor
  staff: Actor
  faculty: Actor
  keeper: Actor
}

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Trade College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
      { email: `fac@${tag}.test`, institutionId: id, role: 'faculty', name: 'Fac' },
      { email: `lab@${tag}.test`, institutionId: id, role: 'faculty', name: 'Lab' },
    ])
    .returning({ id: users.id })
  const who = (at: number, role: Role): Actor => ({ id: people[at]!.id, email: `${at}@${tag}.test`, role, institutionId: id })
  return { id, admin: who(0, 'institution_admin'), staff: who(1, 'accounts_staff'), faculty: who(2, 'faculty'), keeper: who(3, 'faculty') }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const balanceOf = async (b: Books, code: string) => (await trialBalance(b.admin)).rows.find((r) => r.code === code)?.balancePaise ?? 0
async function balanced(b: Books) {
  assert.equal((await trialBalance(b.admin)).differencePaise, 0, 'the trial balance balances')
}
async function refused(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof FinanceError, `expected a FinanceError, got ${String(e)}`)
    assert.equal(e.code, code)
    return true
  })
}
const party = (b: Books, kind: 'isCustomer' | 'isSupplier', extra: Record<string, unknown> = {}) =>
  createParty(b.staff, { code: `P${++n}`, name: `Party ${n}`, [kind]: true, ...extra }).then((r) => r.id)
const item = (b: Books, code: string, extra: Record<string, unknown> = {}) =>
  createItem(b.staff, { code, name: `Item ${code}`, ...extra }).then((r) => r.id)

test('a purchase order is approved, received into the store, and billed at a different price', async () => {
  const b = await books()
  const supplier = await party(b, 'isSupplier')
  const toner = await item(b, 'TONER')
  await setApprovalRule(b.admin, { docType: 'purchase_order', minAmount: '10000', approver: 'institution_admin' })
  const po = (await saveOrder(b.staff, {
    kind: 'purchase_order',
    partyId: supplier,
    postingDate: DAY,
    lines: [{ itemId: toner, qty: '10', rate: '2000' }],
  })) as { id: string }
  await refused(submitOrder(b.staff, { orderId: po.id }), 'needs_approval')
  await refused(decideApproval(b.staff, { docType: 'purchase_order', docId: po.id, decision: 'approved' }), 'forbidden')
  // The admin sees it waiting; the clerk, who may not approve it, does not.
  assert.deepEqual((await pendingApprovals(b.admin)).map((p) => [p.docType, p.docId, p.refused]), [['purchase_order', po.id, false]])
  assert.equal((await pendingApprovals(b.staff)).length, 0)
  await decideApproval(b.admin, { docType: 'purchase_order', docId: po.id, decision: 'approved' })
  assert.equal((await pendingApprovals(b.admin)).length, 0)
  const submitted = (await submitOrder(b.staff, { orderId: po.id })) as { number: string }
  assert.match(submitted.number, /^PO\/2627\/0001$/)

  const grn = (await receiptFromOrder(b.staff, { orderId: po.id, postingDate: DAY })) as { id: string }
  await submitReceipt(b.staff, { receiptId: grn.id })
  assert.equal(await balanceOf(b, '1300'), 2_000_000, 'in the store at the order’s price')
  assert.equal(await balanceOf(b, '2050'), 2_000_000, 'owed before the bill arrives')
  assert.equal((await orderDetail(b.admin, po.id)).status, 'to_bill')

  await refused(receiptFromOrder(b.staff, { orderId: po.id }), 'nothing_left')

  // The bill comes in a little higher: the receipt's value is cleared, the rest is an adjustment.
  const bill = (await invoiceFromReceipt(b.staff, { receiptId: grn.id, postingDate: DAY, billNo: 'T-1' })) as { id: string }
  const draft = await invoiceDetail(b.admin, bill.id)
  const line = draft.lines[0]!
  assert.ok(line.receiptLineId, 'the draft names the receipt line it bills')
  const bill2 = (await saveInvoice(b.staff, {
    invoiceId: bill.id,
    kind: 'purchase',
    partyId: supplier,
    postingDate: DAY,
    billNo: 'T-1',
    lines: [{ itemId: toner, qty: '10', rate: '2050', receiptLineId: line.receiptLineId, orderLineId: line.orderLineId }],
    submit: true,
  })) as { id: string }
  assert.equal(await balanceOf(b, '5420'), 50_000, 'fifty more a unit is a stock adjustment')
  assert.equal(await balanceOf(b, '2050'), 0, 'goods-received-not-billed is cleared')
  assert.equal((await orderDetail(b.admin, po.id)).status, 'completed')
  await refused(cancelReceipt(b.staff, { receiptId: grn.id, reason: 'received in error' }), 'receipt_billed')
  assert.ok((await invoicePdf(b.admin, bill2.id)).bytes.length > 1000)
  await balanced(b)
})

test('a quotation becomes a sales order, goes out on a delivery note, and is billed from it', async () => {
  const b = await books()
  await updateSettings(b.admin, { stateCode: '21' })
  await loadIndiaPreset(b.admin)
  const gst18 = await withTenant(b.id, async (tx) => (await tx.select().from(taxTemplates).where(eq(taxTemplates.name, 'GST 18%')))[0]!.id)
  const customer = await party(b, 'isCustomer', { stateCode: '21', gstin: '21ABCDE1234F1Z5' })
  const book = await item(b, 'BOOK', { taxTemplateId: gst18, hsnSac: '4901' })
  await createStockEntry(b.staff, { kind: 'receipt', postingDate: DAY, submit: true, lines: [{ itemId: book, qty: '50', rate: '200' }] })

  const q = (await saveOrder(b.staff, { kind: 'quotation', partyId: customer, postingDate: DAY, lines: [{ itemId: book, qty: '20', rate: '300' }], submit: true })) as { id: string }
  const so = (await orderFromQuotation(b.staff, { quotationId: q.id })) as { id: string }
  await submitOrder(b.staff, { orderId: so.id })
  assert.equal((await orderDetail(b.admin, q.id)).status, 'ordered')

  const dn = (await receiptFromOrder(b.staff, { orderId: so.id, postingDate: DAY })) as { id: string }
  await submitReceipt(b.staff, { receiptId: dn.id })
  assert.equal(await balanceOf(b, '5410'), 400_000, 'twenty books at 200 to cost of goods')
  const inv = (await invoiceFromReceipt(b.staff, { receiptId: dn.id, postingDate: DAY, submit: true })) as { id: string }
  assert.equal((await invoiceDetail(b.admin, inv.id)).invoice.totalFc, 708_000)
  assert.equal((await orderDetail(b.admin, so.id)).status, 'completed')

  const r1 = await gstr1(b.admin, { from: '2026-10-01', to: '2026-10-31' })
  assert.equal(r1.b2b.length, 1)
  assert.equal(r1.b2b[0]!.taxablePaise, 600_000)
  assert.equal(r1.b2b[0]!.cgstPaise, 54_000)
  assert.equal(r1.hsn[0]!.hsnSac, '4901')
  const r3 = await gstr3b(b.admin, { from: '2026-10-01', to: '2026-10-31' })
  assert.equal(r3['3.1'].outward.cgstPaise, 54_000)
  assert.equal(r3.payable.sgstPaise, 54_000)
  await balanced(b)
})

test('a lecturer asks the stores, a storekeeper issues it, and nobody else may', async () => {
  const b = await books()
  const chalk = await item(b, 'CHALK2')
  await createStockEntry(b.staff, { kind: 'receipt', postingDate: DAY, submit: true, lines: [{ itemId: chalk, qty: '100', rate: '5' }] })
  const mr = (await saveMaterialRequest(b.faculty, { purpose: 'issue', costCenter: 'PHY', lines: [{ itemId: chalk, qty: '10' }], submit: true })) as { id: string }
  assert.equal((await listMaterialRequests(b.faculty))[0]!.status, 'pending')
  await refused(issueFromRequest(b.keeper, { requestId: mr.id }), 'forbidden')
  await grantJob(b.admin, { userId: b.keeper.id, capability: 'storekeeper' })
  const issue = (await issueFromRequest(b.keeper, { requestId: mr.id })) as { id: string }
  assert.ok(issue.id)
  const { submitStockEntry } = await import('./api')
  await submitStockEntry(b.keeper, { stockEntryId: issue.id })
  assert.equal((await listMaterialRequests(b.faculty))[0]!.status, 'issued')
  const [held] = await stockBalance(b.admin, { itemId: chalk })
  assert.equal(held!.qtyMilli, 90_000)
  await balanced(b)
})

test('a straight-line schedule spreads exactly what is to be depreciated, by days', () => {
  const rows = depreciationScheduleFor({
    method: 'slm',
    lifeMonths: 60,
    rateBp: null,
    residualBp: 500,
    frequency: 'month',
    fyStartMonth: 4,
    gross: 10_000_000,
    accumulated: 0,
    from: '2026-10-16',
    usedMonths: 0,
  })
  assert.equal(rows.length, 61, 'a part month at each end')
  assert.equal(rows.reduce((n, r) => n + r.amount, 0), 9_500_000)
  assert.equal(rows.at(-1)!.accumulatedAfter, 9_500_000)
  assert.equal(rows[0]!.periodEnd, '2026-10-31')
  assert.ok(rows[0]!.amount < rows[1]!.amount, 'the first month is charged for its days only')

  const wdv = depreciationScheduleFor({
    method: 'wdv',
    lifeMonths: null,
    rateBp: 1500,
    residualBp: 0,
    frequency: 'year',
    fyStartMonth: 4,
    gross: 1_000_000,
    accumulated: 0,
    from: '2026-04-01',
    usedMonths: 0,
  })
  assert.equal(wdv[0]!.amount, 150_000)
  assert.equal(wdv[1]!.amount, 127_500, '15% of what was left')
})

test('an asset is bought on a bill, capitalised, depreciated, and sold at a gain', async () => {
  const b = await books()
  const cat = (await createAssetCategory(b.admin, { name: 'Computers', method: 'slm', lifeYears: '3', residualPercent: '0', frequency: 'month' })) as { id: string }
  const laptop = await item(b, 'LAPTOP', { nature: 'asset', assetCategoryId: cat.id })
  const vendor = await party(b, 'isSupplier')
  await saveInvoice(b.staff, { kind: 'purchase', partyId: vendor, postingDate: '2026-04-01', lines: [{ itemId: laptop, qty: '2', rate: '36000' }], submit: true })
  assert.equal(await balanceOf(b, '1500'), 7_200_000)
  const drafts = await withTenant(b.id, (tx) => tx.select().from(assets).where(eq(assets.docstatus, 'draft')))
  assert.equal(drafts.length, 2, 'one asset for each laptop')
  assert.equal(drafts[0]!.grossPaise, 3_600_000)

  const a = (await submitAsset(b.staff, { assetId: drafts[0]!.id })) as { periods: number }
  assert.equal(a.periods, 36)
  await postDepreciation(b.staff, { upTo: '2026-09-30' })
  assert.equal(await balanceOf(b, '5500'), 600_000, 'six months at 1,000')
  const bank = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))
  await recordAssetEvent(b.staff, { assetId: drafts[0]!.id, kind: 'sold', on: '2026-10-15', amount: '32000', proceedsAccountId: bank })
  const d = await assetDetail(b.admin, drafts[0]!.id)
  assert.equal(d.schedule.filter((r) => !r.entryId).length, 0, 'the rest of the schedule is dropped')
  assert.equal(await balanceOf(b, '5510'), -200_000, 'sold for 2,000 more than it stood at: a gain')
  const reg = await assetRegister(b.admin, { on: '2026-10-31' })
  assert.equal(reg.find((r) => r.id === drafts[0]!.id)!.status, 'disposed')
  await refused(recordAssetEvent(b.staff, { assetId: drafts[0]!.id, kind: 'transfer', toCostCenter: 'X' }), 'finance_asset_disposed')
  await balanced(b)
})

test('an asset from earlier books comes in with what it had depreciated', async () => {
  const b = await books()
  const cat = (await createAssetCategory(b.admin, { name: 'Buildings', method: 'wdv', ratePercent: '10', frequency: 'year' })) as { id: string }
  await saveAsset(b.staff, {
    name: 'Old hostel',
    categoryId: cat.id,
    purchasedOn: '2010-04-01',
    gross: '1000000',
    existing: true,
    openingAccumulated: '600000',
    depreciateFrom: '2026-04-01',
    submit: true,
  })
  assert.equal(await balanceOf(b, '1500'), 100_000_000)
  assert.equal(await balanceOf(b, '1550'), -60_000_000)
  assert.equal(await balanceOf(b, '3900'), 40_000_000)
  await balanced(b)
})

/** A one-sheet workbook, as a spreadsheet program writes it, zipped by hand. */
function xlsx(rows: string[][]): Buffer {
  const strings: string[] = []
  const at = (s: string) => (strings.includes(s) ? strings.indexOf(s) : strings.push(s) - 1)
  const col = (i: number) => String.fromCharCode(65 + i)
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => (/^-?\d+(\.\d+)?$/.test(c) ? `<c r="${col(ci)}${ri + 1}"><v>${c}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${at(c)}</v></c>`)).join('')}</row>`)
    .join('')}</sheetData></worksheet>`
  const shared = `<?xml version="1.0"?><sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`
  const files: [string, Buffer][] = [
    ['xl/sharedStrings.xml', Buffer.from(shared)],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet)],
  ]
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, data] of files) {
    const packed = deflateRawSync(data)
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt32LE(packed.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, packed)
    central.push(dir, nameBuf)
    offset += 30 + nameBuf.length + packed.length
  }
  const dirBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dirBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dirBuf, end])
}

test('statements are read from CSV, XLSX, MT940 and camt.053', () => {
  assert.equal(bankAmount('1,23,456.78'), 12_345_678)
  assert.equal(bankAmount('(500.00)'), -50_000)
  assert.equal(bankAmount('500.00 Dr'), -50_000)
  assert.equal(bankAmount('1.234,56'), 123_456)
  assert.equal(bankDate('01/10/2026'), '2026-10-01')
  assert.equal(bankDate('01-Oct-26'), '2026-10-01')
  assert.equal(bankDate(46296), '2026-10-01')

  const csv = Buffer.from(
    'Account statement for COLLEGE\nFrom 01/10/2026\n\nTxn Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance\n01/10/2026,NEFT-ACME LTD-INV 42,UTR123456,,"1,180.00","11,180.00"\n02/10/2026,CHARGES,,118.00,,"11,062.00"\n',
  )
  const c = parseStatement(csv, 'stmt.csv')
  assert.equal(c.format, 'csv')
  assert.equal(c.lines.length, 2)
  assert.equal(c.lines[0]!.depositPaise, 118_000)
  assert.equal(c.lines[1]!.withdrawalPaise, 11_800)
  assert.equal(c.lines[1]!.balancePaise, 1_106_200)

  const x = parseStatement(xlsx([['Date', 'Description', 'Debit', 'Credit'], ['46296', 'Fee received', '', '2500'], ['46297', 'Rent', '1000', '']]), 'stmt.xlsx')
  assert.equal(x.format, 'xlsx')
  assert.deepEqual(x.lines.map((l) => [l.txnDate, l.depositPaise, l.withdrawalPaise]), [
    ['2026-10-01', 250_000, 0],
    ['2026-10-02', 0, 100_000],
  ])

  const mt = parseMt940(':20:STMT\n:25:SBIN0001234/1234567\n:28C:1/1\n:60F:C261001INR10000,00\n:61:2610011001C1180,00NTRFUTR123456//BANKREF\n:86:NEFT ACME LTD INV 42\n:61:2610021002D118,00NCHGNONREF\n:86:SMS CHARGES\n:62F:C261002INR11062,00\n-')
  assert.equal(mt.lines.length, 2)
  assert.equal(mt.openingPaise, 1_000_000)
  assert.equal(mt.closingPaise, 1_106_200)
  assert.equal(mt.lines[0]!.reference, 'UTR123456')
  assert.equal(mt.lines[1]!.withdrawalPaise, 11_800)

  const camt = parseCamt053(`<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
    <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="INR">10000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
    <Ntry><Amt Ccy="INR">1180.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-10-01</Dt></BookgDt><NtryDtls><TxDtls><Refs><EndToEndId>E2E-42</EndToEndId></Refs><RmtInf><Ustrd>INV 42</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
    </Stmt></BkToCstmrStmt></Document>`)
  assert.equal(camt.lines[0]!.depositPaise, 118_000)
  assert.equal(camt.lines[0]!.reference, 'E2E-42')
  assert.equal(camt.openingPaise, 1_000_000)
})

test('a statement is imported, matched to the books, its charges posted by rule, and reconciled', async () => {
  const b = await books()
  const ba = (await createBankAccount(b.admin, { bankName: 'State Bank', accountNumber: '1234567890', ifsc: 'SBIN0001234' })) as { id: string }
  const [bankAccountId] = await withTenant(b.id, async (tx) => {
    const { bankAccounts } = await import('./schema')
    return [(await tx.select().from(bankAccounts).where(eq(bankAccounts.id, ba.id)))[0]!.accountId]
  })
  const customer = await party(b, 'isCustomer')
  await savePayment(b.staff, { kind: 'receive', partyId: customer, postingDate: DAY, accountId: bankAccountId, amount: '1180', reference: 'UTR123456', submit: true })
  const charges = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank_charges'))
  await createBankRule(b.staff, { contains: 'charges', direction: 'out', accountId: charges })
  const csv = 'Txn Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance\n01/10/2026,NEFT-ACME-UTR123456,UTR123456,,1180.00,1180.00\n02/10/2026,SMS CHARGES,,11.80,,1168.20\n'
  const imp = (await importStatement(b.staff, {
    bankAccountId: ba.id,
    file: { name: 'oct.csv', type: 'text/csv', size: csv.length, base64: Buffer.from(csv).toString('base64') },
  })) as { lines: number; matched: number }
  assert.equal(imp.lines, 2)
  assert.equal(imp.matched, 1)
  await refused(
    importStatement(b.staff, { bankAccountId: ba.id, file: { name: 'oct.csv', type: 'text/csv', size: csv.length, base64: Buffer.from(csv).toString('base64') } }),
    'finance_bank_statements_file',
  )
  const ruled = (await applyRules(b.staff, { bankAccountId: ba.id })) as { posted: number }
  assert.equal(ruled.posted, 1)
  const brs = await reconciliation(b.admin, { bankAccountId: ba.id, on: '2026-10-31' })
  assert.equal(brs.booksPaise, 116_820)
  assert.equal(brs.differencePaise, 0)
  await balanced(b)
})

test('the statements agree with each other: the balance sheet balances and the surplus is income less expenditure', async () => {
  const b = await books()
  const fund = (await createFund(b.admin, { code: 'DST', name: 'DST research grant', kind: 'grant', sanctioned: '500000' })) as { id: string }
  const customer = await party(b, 'isCustomer')
  const supplier = await party(b, 'isSupplier')
  const bank = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))
  await saveInvoice(b.staff, { kind: 'sales', partyId: customer, postingDate: '2026-06-10', lines: [{ description: 'Consultancy', rate: '100000' }], submit: true })
  await saveInvoice(b.staff, { kind: 'purchase', partyId: supplier, postingDate: '2026-06-12', fundId: fund.id, lines: [{ description: 'Lab consumables', rate: '30000' }], submit: true })
  await savePayment(b.staff, { kind: 'receive', partyId: customer, postingDate: '2026-07-01', accountId: bank, amount: '60000', autoAllocate: true, submit: true })

  const ie = await incomeAndExpenditure(b.admin, { from: '2026-04-01', to: '2027-03-31' })
  assert.equal(ie.surplusPaise, 7_000_000)
  const bs = await balanceSheet(b.admin, { on: '2027-03-31' })
  assert.equal(bs.differencePaise, 0)
  assert.equal(bs.unclosedSurplusPaise, 7_000_000)
  const tb = await trialBalanceReport(b.admin, { from: '2026-04-01', to: '2027-03-31' })
  assert.equal(tb.totals.closingDebitPaise, tb.totals.closingCreditPaise)
  const cash = await cashMovements(b.admin, { from: '2026-04-01', to: '2027-03-31' })
  assert.equal(cash.closingPaise, 6_000_000)
  assert.equal(cash.operating.netPaise, 6_000_000)
  const ag = await aging(b.admin, { side: 'receivable', on: '2026-10-01' })
  assert.equal(ag.totalPaise, 4_000_000)
  const fs = await fundStatement(b.admin, { fundId: fund.id, from: '2026-04-01', to: '2027-03-31' })
  assert.equal(fs.spentPaise, 3_000_000)
  assert.equal(fs.utilisedPercent, 6)
  await balanced(b)
})
