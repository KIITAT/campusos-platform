import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import {
  FinanceError,
  accountFor,
  addCurrency,
  applyAdvances,
  cancelInvoice,
  cancelPayment,
  cancelStockEntry,
  createItem,
  createParty,
  createStockEntry,
  invoiceDetail,
  listInvoices,
  loadIndiaPreset,
  makeReturn,
  partyStatement,
  saveInvoice,
  saveJournal,
  savePayment,
  setRate,
  stockAgainstBooks,
  stockBalance,
  trialBalance,
  updateSettings,
  type Actor,
} from './api'
import { taxTemplates, tdsSections } from './schema'

/**
 * The business books end to end: stores, invoices, payments, vouchers. Each
 * test gets its own institution, and every one ends by checking the trial
 * balance still balances -- the invariant everything else rests on.
 */

let n = 0
const SLUG = 'fin-biz-'
const DAY = '2026-10-01'

interface Books {
  id: string
  admin: Actor
  staff: Actor
  faculty: Actor
}

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Biz', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
      { email: `fac@${tag}.test`, institutionId: id, role: 'faculty', name: 'Fac' },
    ])
    .returning({ id: users.id })
  const who = (at: number, role: Role): Actor => ({ id: people[at]!.id, email: `${role}@${tag}.test`, role, institutionId: id })
  return { id, admin: who(0, 'institution_admin'), staff: who(1, 'accounts_staff'), faculty: who(2, 'faculty') }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

async function balanced(b: Books) {
  const tb = await trialBalance(b.admin)
  assert.equal(tb.differencePaise, 0, 'the trial balance balances')
  return tb
}

const balanceOf = async (b: Books, code: string) => (await trialBalance(b.admin)).rows.find((r) => r.code === code)?.balancePaise ?? 0

async function refused(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof FinanceError, `expected a FinanceError, got ${String(e)}`)
    assert.equal(e.code, code)
    return true
  })
}

async function item(b: Books, code: string, extra: Record<string, unknown> = {}) {
  const r = await createItem(b.staff, { code, name: `Item ${code}`, uom: 'Nos', ...extra })
  return r.id
}

async function stock(b: Books, kind: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return createStockEntry(b.staff, { kind, postingDate: DAY, lines, submit: true, ...extra }) as Promise<{
    id: string
    number: string
  }>
}

test('stock moves at moving average, and the stores and the books agree', async () => {
  const b = await books()
  const paper = await item(b, 'PAPER')
  await stock(b, 'receipt', [{ itemId: paper, qty: '10', rate: '100' }])
  await stock(b, 'receipt', [{ itemId: paper, qty: '10', rate: '130' }])
  const issue = await stock(b, 'issue', [{ itemId: paper, qty: '5' }])
  assert.match(issue.number, /^SE\/2627\/\d{4}$/)

  const [row] = await stockBalance(b.admin, { itemId: paper })
  assert.equal(row!.qtyMilli, 15_000)
  // 20 units worth 2,300.00 is 115.00 each; five went out at 575.00.
  assert.equal(row!.valuePaise, 230_000 - 57_500)
  assert.equal(await balanceOf(b, '1300'), 172_500)
  assert.equal(await balanceOf(b, '5400'), 57_500, 'the issue is charged to consumption')
  for (const r of await stockAgainstBooks(b.admin)) assert.equal(r.differencePaise, 0)

  await refused(stock(b, 'issue', [{ itemId: paper, qty: '16' }]), 'finance_stock_negative')

  await cancelStockEntry(b.staff, { stockEntryId: issue.id, reason: 'issued in error' })
  const [after] = await stockBalance(b.admin, { itemId: paper })
  assert.equal(after!.qtyMilli, 20_000)
  assert.equal(after!.valuePaise, 230_000)
  await balanced(b)
})

test('first in, first out issues the oldest receipts first, and a used receipt stays', async () => {
  const b = await books()
  const acid = await item(b, 'ACID', { valuation: 'fifo' })
  const first = await stock(b, 'receipt', [{ itemId: acid, qty: '10', rate: '100' }])
  await stock(b, 'receipt', [{ itemId: acid, qty: '10', rate: '130' }])
  await stock(b, 'issue', [{ itemId: acid, qty: '15' }])
  const [row] = await stockBalance(b.admin, { itemId: acid })
  // Ten at 100 and five at 130 went out; five at 130 are left.
  assert.equal(row!.valuePaise, 65_000)
  await refused(cancelStockEntry(b.staff, { stockEntryId: first.id, reason: 'received in error' }), 'stock_consumed')
  await balanced(b)
})

test('serial numbers are moved one by one, and an expired batch stays on the shelf', async () => {
  const b = await books()
  const scope = await item(b, 'SCOPE', { hasSerial: true })
  await stock(b, 'receipt', [{ itemId: scope, qty: '2', rate: '50000', serials: 'M-1, M-2' }])
  await refused(stock(b, 'issue', [{ itemId: scope, qty: '1', serials: 'M-9' }]), 'finance_stock_serial_missing')
  await refused(stock(b, 'receipt', [{ itemId: scope, qty: '1', rate: '1', serials: 'M-1' }]), 'finance_stock_serial_in_stock')
  await stock(b, 'issue', [{ itemId: scope, qty: '1', serials: 'M-2' }])

  const drug = await item(b, 'DRUG', { hasBatch: true })
  await stock(b, 'receipt', [{ itemId: drug, qty: '5', rate: '10', batchNo: 'B1', expiresOn: '2026-09-01' }])
  await refused(stock(b, 'issue', [{ itemId: drug, qty: '1', batchNo: 'B1' }]), 'batch_expired')
  await balanced(b)
})

async function gstBooks() {
  const b = await books()
  await updateSettings(b.admin, { stateCode: '21' })
  await loadIndiaPreset(b.admin)
  const gst18 = await withTenant(b.id, async (tx) => {
    const [t] = await tx.select().from(taxTemplates).where(eq(taxTemplates.name, 'GST 18%'))
    return t!.id
  })
  return { b, gst18 }
}

const customer = (b: Books, extra: Record<string, unknown> = {}) =>
  createParty(b.staff, { code: `C${++n}`, name: `Customer ${n}`, isCustomer: true, stateCode: '21', ...extra }).then((r) => r.id)
const supplier = (b: Books, extra: Record<string, unknown> = {}) =>
  createParty(b.staff, { code: `S${++n}`, name: `Supplier ${n}`, isSupplier: true, stateCode: '21', ...extra }).then(
    (r) => r.id,
  )
const bankOf = (b: Books) => withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))

test('a sales invoice: GST inside the state, rounding, payments against it, and a credit note', async () => {
  const { b, gst18 } = await gstBooks()
  const c = await customer(b)
  const consult = await item(b, 'CONSULT', { nature: 'service', taxTemplateId: gst18 })
  const inv = (await saveInvoice(b.staff, {
    kind: 'sales',
    partyId: c,
    postingDate: DAY,
    lines: [{ itemId: consult, qty: '1', rate: '1000.50' }],
    submit: true,
  })) as { id: string; number: string }
  assert.equal(inv.number, 'SI/2627/0001')

  const d = await invoiceDetail(b.admin, inv.id)
  // 1,000.50 at 9% + 9% is 90.045 each, rounded once to 90.05; 1,180.60 rounds to 1,181.
  assert.deepEqual(d.taxes.map((t) => [t.component, t.taxFc]).sort(), [
    ['cgst', 9005],
    ['sgst', 9005],
  ])
  assert.equal(d.invoice.roundingFc, 40)
  assert.equal(d.invoice.totalFc, 118_100)
  assert.equal(d.outstanding.fc, 118_100)
  assert.equal(d.status, 'unpaid')

  const bank = await bankOf(b)
  const p1 = (await savePayment(b.staff, {
    kind: 'receive',
    partyId: c,
    postingDate: DAY,
    accountId: bank,
    amount: '500',
    allocations: [{ invoiceId: inv.id, amount: '500' }],
    submit: true,
  })) as { id: string }
  assert.equal((await invoiceDetail(b.admin, inv.id)).status, 'partly_paid')
  const p2 = (await savePayment(b.staff, {
    kind: 'receive',
    partyId: c,
    postingDate: DAY,
    accountId: bank,
    amount: '681',
    autoAllocate: true,
    submit: true,
  })) as { id: string }
  assert.equal((await invoiceDetail(b.admin, inv.id)).status, 'paid')
  assert.equal(await balanceOf(b, '1150'), 0)

  await refused(cancelInvoice(b.staff, { invoiceId: inv.id, reason: 'billed in error' }), 'invoice_settled')
  await cancelPayment(b.staff, { paymentId: p2.id, reason: 'cheque bounced' })
  assert.equal((await invoiceDetail(b.admin, inv.id)).outstanding.fc, 68_100)

  // A credit note for all of it: what is open comes off the invoice, the rest
  // stands to the customer's credit.
  const cn = (await makeReturn(b.staff, { invoiceId: inv.id, postingDate: DAY, submit: true })) as { id: string; number: string }
  assert.equal(cn.number, 'SCN/2627/0001')
  assert.equal((await invoiceDetail(b.admin, inv.id)).status, 'paid')
  const st = await partyStatement(b.admin, { partyId: c })
  assert.equal(st.closingPaise, -50_000, 'the 500 paid is now the customer’s credit')
  assert.equal(await balanceOf(b, '2401'), 0, 'output CGST is back to nothing')
  await cancelPayment(b.staff, { paymentId: p1.id, reason: 'refunded' }).catch(() => undefined)
  await balanced(b)
})

test('a purchase: tax deducted at source past the threshold, stock received, and reverse charge', async () => {
  const { b, gst18 } = await gstBooks()
  const prof = await withTenant(b.id, async (tx) => {
    const [s] = await tx.select().from(tdsSections).where(eq(tdsSections.code, 'PROF'))
    return s!.id
  })
  const auditor = await supplier(b, { pan: 'ABCDE1234F', stateCode: '07', tdsSectionId: prof })
  const audit = await item(b, 'AUDIT', { nature: 'service', taxTemplateId: gst18 })
  const bill = (await saveInvoice(b.staff, {
    kind: 'purchase',
    partyId: auditor,
    postingDate: DAY,
    billNo: 'A-17',
    lines: [{ itemId: audit, qty: '1', rate: '60000' }],
    submit: true,
  })) as { id: string; number: string }
  const d = await invoiceDetail(b.admin, bill.id)
  assert.deepEqual(d.taxes.map((t) => [t.component, t.taxFc]), [['igst', 1_080_000]], 'across the state: IGST')
  assert.equal(d.invoice.tdsPaise, 600_000, '10% of 60,000, the year being past 50,000')
  assert.equal(d.outstanding.fc, 7_080_000 - 600_000)
  assert.equal(await balanceOf(b, '2410'), 600_000)

  await refused(
    saveInvoice(b.staff, { kind: 'purchase', partyId: auditor, billNo: 'A-17', lines: [{ itemId: audit, rate: '1' }], submit: true }),
    'finance_invoices_bill',
  )

  const bank = await bankOf(b)
  await savePayment(b.staff, { kind: 'pay', partyId: auditor, postingDate: DAY, accountId: bank, amount: '64800', autoAllocate: true, submit: true })
  assert.equal((await invoiceDetail(b.admin, bill.id)).status, 'paid')

  // Stock bought on the bill itself: valued at the bill's price, tax claimed.
  const vendor = await supplier(b)
  const chalk = await item(b, 'CHALK', { taxTemplateId: gst18 })
  await saveInvoice(b.staff, {
    kind: 'purchase',
    partyId: vendor,
    postingDate: DAY,
    updateStock: true,
    lines: [{ itemId: chalk, qty: '10', rate: '50' }],
    submit: true,
  })
  const [held] = await stockBalance(b.admin, { itemId: chalk })
  assert.equal(held!.valuePaise, 50_000)
  for (const r of await stockAgainstBooks(b.admin)) assert.equal(r.differencePaise, 0)

  // Reverse charge: the supplier bills no tax; the institution owes it and claims it.
  const unregistered = await supplier(b)
  const rcm = (await saveInvoice(b.staff, {
    kind: 'purchase',
    partyId: unregistered,
    postingDate: DAY,
    reverseCharge: true,
    lines: [{ itemId: audit, qty: '1', rate: '1000' }],
    submit: true,
  })) as { id: string }
  const r = await invoiceDetail(b.admin, rcm.id)
  assert.equal(r.invoice.totalFc, 100_000)
  assert.equal(r.invoice.taxFc, 18_000)
  assert.equal(await balanceOf(b, '2401'), 9_000, 'CGST owed under reverse charge')
  await balanced(b)
})

test('an invoice in dollars is settled at the day’s rate, and the difference is an exchange gain', async () => {
  const b = await books()
  await addCurrency(b.admin, { code: 'USD', name: 'US Dollar', symbol: '$', minorUnits: 2 })
  await setRate(b.staff, { currency: 'USD', on: '2026-09-30', rate: '83' })
  const c = await customer(b, { currency: 'USD', gstCategory: 'overseas', stateCode: '' })
  const inv = (await saveInvoice(b.staff, {
    kind: 'sales',
    partyId: c,
    postingDate: DAY,
    lines: [{ description: 'Exam fee, international', qty: '1', rate: '100' }],
    submit: true,
  })) as { id: string }
  assert.equal(await balanceOf(b, '1150'), 830_000)

  const bank = await bankOf(b)
  await savePayment(b.staff, {
    kind: 'receive',
    partyId: c,
    postingDate: DAY,
    accountId: bank,
    currency: 'USD',
    exchangeRate: '84',
    amount: '100',
    autoAllocate: true,
    submit: true,
  })
  assert.equal((await invoiceDetail(b.admin, inv.id)).status, 'paid')
  assert.equal(await balanceOf(b, '1150'), 0)
  assert.equal(await balanceOf(b, '1010'), 840_000)
  assert.equal(await balanceOf(b, '4900'), 10_000, 'a gain of one rupee per dollar')
  await balanced(b)
})

test('opening balances come in by journal voucher, and a party’s opening moves their account', async () => {
  const b = await books()
  const c = await customer(b)
  const [bank, ar] = await withTenant(b.id, async (tx) => [await accountFor(tx, b.id, 'bank'), await accountFor(tx, b.id, 'accounts_receivable')])
  await saveJournal(b.staff, { kind: 'opening', postingDate: '2026-04-01', memo: 'Bank at the start', lines: [{ accountId: bank, debit: '50000' }], submit: true })
  assert.equal(await balanceOf(b, '3900'), 5_000_000, 'waiting in the opening balance account')
  await refused(
    saveJournal(b.staff, { memo: 'Debtor', postingDate: '2026-04-01', lines: [{ accountId: ar, debit: '100' }, { accountId: bank, credit: '100' }], submit: true }),
    'party_required',
  )
  await saveJournal(b.staff, {
    kind: 'opening',
    postingDate: '2026-04-01',
    memo: 'Debtor brought forward',
    lines: [{ accountId: ar, partyId: c, debit: '10000' }],
    submit: true,
  })
  assert.equal((await partyStatement(b.admin, { partyId: c })).closingPaise, 1_000_000)
  await refused(
    saveJournal(b.staff, { memo: 'Lopsided', lines: [{ accountId: bank, debit: '1' }, { accountId: ar, partyId: c, credit: '2' }], submit: true }),
    'unbalanced',
  )
  await balanced(b)
})

test('money paid ahead is set against the next invoice, and taken back if the payment is cancelled', async () => {
  const b = await books()
  const c = await customer(b)
  const bank = await bankOf(b)
  const ahead = (await savePayment(b.staff, { kind: 'receive', partyId: c, postingDate: DAY, accountId: bank, amount: '5000', submit: true })) as {
    id: string
  }
  const inv = (await saveInvoice(b.staff, {
    kind: 'sales',
    partyId: c,
    postingDate: DAY,
    lines: [{ description: 'Hall hire', rate: '3000' }],
    submit: true,
  })) as { id: string }
  await applyAdvances(b.staff, { partyId: c, side: 'receivable', on: DAY })
  assert.equal((await invoiceDetail(b.admin, inv.id)).status, 'paid')
  assert.equal((await partyStatement(b.admin, { partyId: c })).closingPaise, -200_000)

  await cancelPayment(b.staff, { paymentId: ahead.id, reason: 'cheque bounced' })
  assert.equal((await invoiceDetail(b.admin, inv.id)).outstanding.fc, 300_000)
  const open = await listInvoices(b.admin, { kind: 'sales', status: 'open' })
  assert.equal(open.length, 1)
  await balanced(b)
})

test('a faculty member cannot raise an invoice, and an accountant cannot load the tax presets', async () => {
  const b = await books()
  const c = await customer(b)
  await refused(saveInvoice(b.faculty, { kind: 'sales', partyId: c, lines: [{ description: 'x', rate: '1' }] }), 'forbidden')
  await refused(loadIndiaPreset(b.staff), 'forbidden')
})
