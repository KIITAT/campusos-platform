import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import {
  FinanceError,
  accountFor,
  budgetReport,
  cancelInvoice,
  closePeriod,
  createAssetCategory,
  createBankAccount,
  importStatement,
  reopenPeriod,
  setSeries,
  setSingleOfficer,
  updateSettings,
  createItem,
  createParty,
  createStockEntry,
  createTdsSection,
  loadIndiaPreset,
  makeReturn,
  markFiled,
  postDepreciation,
  postEntry,
  postWithin,
  refusal,
  saveAsset,
  saveInvoice,
  saveJournal,
  saveOrder,
  setBudget,
  submitOrder,
  savePayment,
  submitInvoice,
  subledgerReport,
  type Actor,
} from './api'
import { gstFilings, orderLines } from './schema'

/**
 * Close discipline (P1-04): control accounts, sub-ledgers against the books, the
 * close checklist, Rule 46 numbering, filed GST returns, TDS under a lock,
 * encumbrance and the report fixes.
 */

let n = 0
const SLUG = 'fin-disc-'

interface Books {
  id: string
  admin: Actor
  admin2: Actor
  clerk: Actor
}

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Discipline College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `adm2@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm Two' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
    ])
    .returning({ id: users.id })
  const who = (at: number, role: Role): Actor => ({ id: people[at]!.id, email: `${at}@${tag}.test`, role, institutionId: id })
  const b = { id, admin: who(0, 'institution_admin'), admin2: who(1, 'institution_admin'), clerk: who(2, 'accounts_staff') }
  await loadIndiaPreset(b.admin)
  return b
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const customer = (b: Books) =>
  createParty(b.clerk, { code: `C${++n}`, name: `Customer ${n}`, isCustomer: true, stateCode: '21' }).then((r) => r.id)

/** The refusal a database rule raises, named the way a caller sees it. */
async function dbRefuses(p: Promise<unknown>, constraint: string) {
  await assert.rejects(p, (e: unknown) => {
    const r = refusal(e)
    assert.ok(r instanceof FinanceError && r.code === constraint, `expected ${constraint}, got ${String(r)}`)
    return true
  })
}

test('gst filings are isolated by institution', async () => {
  const a = await books()
  const other = await books()
  await withTenant(a.id, (tx) =>
    tx.insert(gstFilings).values({ institutionId: a.id, returnType: 'gstr1', periodFrom: '2026-04-01', periodTo: '2026-04-30', filedOn: '2026-05-11' }),
  )
  assert.equal((await withTenant(other.id, (tx) => tx.select().from(gstFilings))).length, 0)
  assert.equal((await withTenant(a.id, (tx) => tx.select().from(gstFilings))).length, 1)
})

test('a receivable line without a party is refused by the database', async () => {
  const b = await books()
  const entry = (purpose: 'accounts_receivable' | 'fees_receivable', ref: string) =>
    withTenant(b.id, (tx) =>
      postWithin(tx, b.id, b.admin.id, {
        memo: 'x',
        sourceModule: 'test',
        sourceRef: ref,
        lines: [
          { purpose, debitPaise: 100, creditPaise: 0 },
          { purpose: 'sales_income', debitPaise: 0, creditPaise: 100 },
        ],
      }),
    )
  await dbRefuses(entry('accounts_receivable', 'r1'), 'finance_control_line_needs_party')
  await entry('fees_receivable', 'r2')
})

test('a sales invoice inside a filed GSTR-1 cannot be cancelled in the database', async () => {
  const b = await books()
  const c = await customer(b)
  const inv = (await saveInvoice(b.clerk, {
    kind: 'sales',
    partyId: c,
    postingDate: '2026-04-10',
    lines: [{ description: 'Hire', qty: '1', rate: '100' }],
    submit: true,
  })) as { id: string }
  await withTenant(b.id, (tx) =>
    tx.insert(gstFilings).values({ institutionId: b.id, returnType: 'gstr1', periodFrom: '2026-04-01', periodTo: '2026-04-30', filedOn: '2026-05-11' }),
  )
  await dbRefuses(
    withTenant(b.id, (tx) =>
      tx.execute(sql`update finance_invoices set docstatus = 'cancelled', cancelled_at = now(), cancel_reason = 'test' where id = ${inv.id}`),
    ),
    'finance_invoice_in_filed_return',
  )
})

const supplier = (b: Books) =>
  createParty(b.clerk, { code: `S${++n}`, name: `Supplier ${n}`, isSupplier: true, stateCode: '21' }).then((r) => r.id)

async function refused(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof FinanceError, `expected a FinanceError, got ${String(e)}`)
    assert.equal(e.code, code)
    if (status) assert.equal(e.status, status)
    return true
  })
}

// --- Step 2: control accounts and the sub-ledger report (ACC-02) -------------------

test('raw postings to control accounts are refused (ACC-02)', async () => {
  const b = await books()
  const c = await customer(b)
  await refused(
    postEntry(b.admin, {
      memo: 'x',
      sourceModule: 'test',
      sourceRef: 'raw-1',
      lines: [
        { purpose: 'accounts_receivable', debitPaise: 100, creditPaise: 0, partyId: c },
        { purpose: 'sales_income', debitPaise: 0, creditPaise: 100 },
      ],
    }),
    'control_account',
    400,
  )
  await refused(
    postEntry(b.admin, {
      memo: 'x',
      sourceModule: 'test',
      sourceRef: 'raw-2',
      lines: [
        { purpose: 'stock_in_hand', debitPaise: 100, creditPaise: 0 },
        { purpose: 'sales_income', debitPaise: 0, creditPaise: 100 },
      ],
    }),
    'control_account',
    400,
  )
})

test('a journal voucher cannot touch a stock account', async () => {
  const b = await books()
  const [stock, cash] = await withTenant(b.id, async (tx) => [await accountFor(tx, b.id, 'stock_in_hand'), await accountFor(tx, b.id, 'cash')])
  await refused(
    saveJournal(b.admin, { kind: 'journal', memo: 'Stock by hand', postingDate: '2026-10-01', lines: [{ accountId: stock, debit: '1' }, { accountId: cash, credit: '1' }], submit: false }),
    'control_account',
    400,
  )
})

test('the sub-ledgers agree after ordinary business', async () => {
  const b = await books()
  const DAY = '2026-10-01'
  const c = await customer(b)
  const s = await supplier(b)
  const bank = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))
  const service = await createItem(b.clerk, { code: 'SVC', name: 'Service', nature: 'service' })
  await saveInvoice(b.clerk, { kind: 'sales', partyId: c, postingDate: DAY, lines: [{ itemId: service.id, qty: '1', rate: '1000' }], submit: true })
  await savePayment(b.clerk, { kind: 'receive', partyId: c, postingDate: DAY, accountId: bank, amount: '500', submit: true })
  const bill = (await saveInvoice(b.clerk, { kind: 'purchase', partyId: s, postingDate: DAY, billNo: 'B-1', lines: [{ description: 'Paper', qty: '1', rate: '700' }] })) as { id: string }
  await submitInvoice(b.admin, { invoiceId: bill.id })
  const chalk = await createItem(b.clerk, { code: 'CHALK', name: 'Chalk' })
  await createStockEntry(b.clerk, { kind: 'receipt', postingDate: DAY, submit: true, lines: [{ itemId: chalk.id, qty: '10', rate: '20' }] })
  const cat = (await createAssetCategory(b.admin, { name: 'Computers', method: 'slm', lifeYears: '3', residualPercent: '0', frequency: 'month' })) as { id: string }
  await saveAsset(b.clerk, { name: 'Laptop', categoryId: cat.id, purchasedOn: '2025-04-01', gross: '36000', existing: true, openingAccumulated: '12000', depreciateFrom: '2026-04-01', submit: true })
  await postDepreciation(b.clerk, { upTo: '2026-06-30' })

  const { rows } = await subledgerReport(b.admin, { on: '2026-10-31' })
  assert.deepEqual(rows.map((r) => r.ledger).sort(), ['assets', 'payable', 'receivable', 'stock'])
  for (const r of rows) assert.equal(r.differencePaise, 0, `${r.ledger} ${r.name} differs by ${r.differencePaise}`)
})

test('a manual entry on a receivable account shows as a difference', async () => {
  const b = await books()
  const c = await customer(b)
  await withTenant(b.id, (tx) =>
    postWithin(tx, b.id, b.admin.id, {
      memo: 'a module posted without the party ledger',
      sourceModule: 'test',
      sourceRef: 'diff-1',
      postingDate: '2026-10-01',
      lines: [
        { purpose: 'accounts_receivable', debitPaise: 500, creditPaise: 0, partyId: c },
        { purpose: 'sales_income', debitPaise: 0, creditPaise: 500 },
      ],
    }),
  )
  const { rows } = await subledgerReport(b.admin, { on: '2026-10-31' })
  const r = rows.find((x) => x.ledger === 'receivable')!
  assert.equal(r.differencePaise, 500)
})

// --- Step 3: close checklist, zone, two-person reopen (ACC-07) ---------------------

const MONTH = { year: 2026, month: 9 }
const trail = (b: Books, action: string) =>
  withTenant(b.id, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.institutionId, b.id), eq(auditLog.action, action))))

async function closeRefusal(p: Promise<unknown>): Promise<FinanceError> {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof FinanceError, String(e))
    return e
  }
  assert.fail('expected the close to be refused')
}
const failing = (e: FinanceError) => ((e.detail as { checks: { key: string }[] }).checks ?? []).map((c) => c.key)

test('a month with a draft does not close without an override (ACC-07)', async () => {
  const b = await books()
  const c = await customer(b)
  const service = await createItem(b.clerk, { code: 'SVC', name: 'Service', nature: 'service' })
  await saveInvoice(b.clerk, { kind: 'sales', partyId: c, postingDate: '2026-09-10', lines: [{ itemId: service.id, qty: '1', rate: '100' }] })
  const e = await closeRefusal(closePeriod(b.admin, MONTH))
  assert.equal(e.code, 'close_checks_failed')
  assert.equal(e.status, 409)
  assert.deepEqual(failing(e), ['drafts'])
  await refused(closePeriod(b.admin, { ...MONTH, override: true, overrideReason: 'short' }), 'override_reason', 400)
  const closed = await closePeriod(b.admin, { ...MONTH, override: true, overrideReason: 'auditor accepted the draft' })
  assert.equal(closed.status, 'closed')
  const rows = await trail(b, 'period.close_overridden')
  assert.equal(rows.length, 1)
  assert.deepEqual((rows[0]!.detail as { failed: string[] }).failed, ['drafts'])
})

test('an unmatched bank line blocks the close', async () => {
  const b = await books()
  const ba = (await createBankAccount(b.admin, { bankName: 'State Bank', accountNumber: '1234567890', ifsc: 'SBIN0001234' })) as { id: string }
  const csv = ['Txn Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance', '05/09/2026,UNKNOWN CREDIT,,,500.00,500.00', ''].join('\n')
  await importStatement(b.clerk, { bankAccountId: ba.id, file: { name: 'sep.csv', type: 'text/csv', size: csv.length, base64: Buffer.from(csv).toString('base64') } })
  const e = await closeRefusal(closePeriod(b.admin, MONTH))
  assert.equal(e.code, 'close_checks_failed')
  assert.deepEqual(failing(e), ['bank'])
})

test('a sub-ledger difference blocks the close', async () => {
  const b = await books()
  const c = await customer(b)
  await withTenant(b.id, (tx) =>
    postWithin(tx, b.id, b.admin.id, {
      memo: 'a module posted without the party ledger',
      sourceModule: 'test',
      sourceRef: 'diff-close',
      postingDate: '2026-09-10',
      lines: [
        { purpose: 'accounts_receivable', debitPaise: 500, creditPaise: 0, partyId: c },
        { purpose: 'sales_income', debitPaise: 0, creditPaise: 500 },
      ],
    }),
  )
  const e = await closeRefusal(closePeriod(b.admin, MONTH))
  assert.deepEqual(failing(e), ['subledgers'])
})

test("the month is over in the institution's zone", async () => {
  const b = await books()
  await updateSettings(b.admin, { timeZone: 'Pacific/Kiritimati' })
  const today = await withTenant(b.id, async (tx) => (await tx.execute(sql`select (now() at time zone 'Pacific/Kiritimati')::date::text as d`)).rows[0] as { d: string })
  const [y, m] = today.d.split('-').map(Number) as [number, number]
  const prev = m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 }
  const { periodChecklist } = await import('./api')
  const state = async (p: { year: number; month: number }) =>
    ((await periodChecklist(b.admin, p)) as { checks: { key: string; ok: boolean }[] }).checks.find((c) => c.key === 'month_over')!.ok
  assert.equal(await state({ year: y, month: m }), false)
  assert.equal(await state(prev), true)
})

test('reopening needs a second administrator (ACC-07)', async () => {
  const b = await books()
  await closePeriod(b.admin, MONTH)
  const first = (await reopenPeriod(b.admin, { ...MONTH, reason: 'late supplier bill' })) as { status: string; notice?: string }
  assert.equal(first.status, 'closed')
  assert.match(String(first.notice), /Another administrator must confirm/)
  await refused(reopenPeriod(b.admin, { ...MONTH, reason: 'late supplier bill' }), 'separation_of_duties', 403)
  const done = await reopenPeriod(b.admin2, { ...MONTH, reason: 'confirmed' })
  assert.equal(done.status, 'open')
  assert.equal(done.reopenedReason, 'late supplier bill')
  assert.equal(done.reopenRequestedAt, null)
  const asked = await trail(b, 'period.reopen_requested')
  const reopened = await trail(b, 'period.reopened')
  assert.equal(asked[0]!.actorId, b.admin.id)
  assert.equal(reopened[0]!.actorId, b.admin2.id)
})

test('single-officer mode lets one administrator reopen, on the trail', async () => {
  const b = await books()
  await setSingleOfficer(b.admin, { enabled: true, reason: 'one administrator only' })
  await closePeriod(b.admin, MONTH)
  await reopenPeriod(b.admin, { ...MONTH, reason: 'late supplier bill' })
  const done = await reopenPeriod(b.admin, { ...MONTH, reason: 'late supplier bill' })
  assert.equal(done.status, 'open')
  assert.ok((await trail(b, 'sod.single_officer_used')).length >= 1)
})

// --- Step 4: Rule 46 numbering, series lock and audit (ACC-04) ---------------------

test('a sales series longer than 16 characters is refused (ACC-04)', async () => {
  const b = await books()
  await refused(setSeries(b.admin, { docType: 'sales_invoice', prefix: 'CAMPUS-INV/{FY}/', padding: 5 }), 'series_too_long', 400)
  await refused(setSeries(b.admin, { docType: 'sales_invoice', prefix: 'SI#{FYS}', padding: 4 }), 'series_characters', 400)
  await setSeries(b.admin, { docType: 'sales_invoice', prefix: 'SI/{FYS}/', padding: 5 })
})

test('the series is locked once a number is issued this year, and every change is audited', async () => {
  const b = await books()
  const c = await customer(b)
  const service = await createItem(b.clerk, { code: 'SVC', name: 'Service', nature: 'service' })
  await setSeries(b.admin, { docType: 'sales_invoice', prefix: 'SI/{FYS}/', padding: 5 })
  await saveInvoice(b.clerk, { kind: 'sales', partyId: c, postingDate: '2026-10-01', lines: [{ itemId: service.id, qty: '1', rate: '100' }], submit: true })
  await refused(setSeries(b.admin, { docType: 'sales_invoice', prefix: 'S/{FYS}/', padding: 4 }), 'series_in_use', 409)
  const rows = await trail(b, 'series.set')
  assert.equal(rows.length, 1)
  assert.equal((rows[0]!.detail as { after: { prefix: string } }).after.prefix, 'SI/{FYS}/')
})

test('a non-GST series keeps its freedom', async () => {
  const b = await books()
  await setSeries(b.admin, { docType: 'journal', prefix: 'JOURNAL-VOUCHER/{FY}/', padding: 6 })
})

// --- Step 5: GST filings and the cancel refusal (ACC-05) ---------------------------

const APRIL = { returnType: 'gstr1', periodFrom: '2026-04-01', periodTo: '2026-04-30', filedOn: '2026-05-11' }

test('a sales invoice in a filed GSTR-1 cannot be cancelled (ACC-05)', async () => {
  const b = await books()
  const c = await customer(b)
  const service = await createItem(b.clerk, { code: 'SVC', name: 'Service', nature: 'service' })
  const inv = (await saveInvoice(b.clerk, { kind: 'sales', partyId: c, postingDate: '2026-04-10', lines: [{ itemId: service.id, qty: '1', rate: '100' }], submit: true })) as { id: string }
  await markFiled(b.admin, APRIL)
  await refused(cancelInvoice(b.admin, { invoiceId: inv.id, reason: 'wrong party' }), 'gst_return_filed', 409)
  const note = (await makeReturn(b.clerk, { invoiceId: inv.id, postingDate: '2026-05-02', submit: true })) as { id: string }
  assert.ok(note.id)
})

test('a purchase invoice in that month still cancels', async () => {
  const b = await books()
  const s = await supplier(b)
  const bill = (await saveInvoice(b.clerk, { kind: 'purchase', partyId: s, postingDate: '2026-04-10', billNo: 'B-9', lines: [{ description: 'Paper', qty: '1', rate: '100' }] })) as { id: string }
  await submitInvoice(b.admin, { invoiceId: bill.id })
  await markFiled(b.admin, APRIL)
  await cancelInvoice(b.admin, { invoiceId: bill.id, reason: 'wrong supplier' })
})

test('filings refuse overlap and odd periods', async () => {
  const b = await books()
  await markFiled(b.admin, APRIL)
  await refused(markFiled(b.admin, APRIL), 'return_already_filed', 409)
  await refused(markFiled(b.admin, { ...APRIL, periodFrom: '2026-04-02' }), 'bad_return_period', 400)
  await markFiled(b.admin, { returnType: 'gstr1', periodFrom: '2026-07-01', periodTo: '2026-09-30', filedOn: '2026-10-25' })
})

test('only administrators mark a return filed', async () => {
  const b = await books()
  await refused(markFiled(b.clerk, APRIL), 'forbidden', 403)
})

// --- Step 6: TDS under a lock (ACC-06) ---------------------------------------------

test('two bills submitted together deduct TDS once the year crosses the threshold (ACC-06)', async () => {
  const b = await books()
  const section = (await createTdsSection(b.admin, {
    code: '194C', name: 'Contractors', ratePercent: '1', rateNoPanPercent: '20', thresholdSingle: '0', thresholdAnnual: '100000',
  })) as { id: string }
  const payee = (await createParty(b.clerk, { code: 'PAYEE', name: 'Payee', isSupplier: true, stateCode: '21', pan: 'ABCDE1234F', tdsSectionId: section.id })).id
  const other = await supplier(b)
  const bill = async (partyId: string, billNo: string) =>
    ((await saveInvoice(b.clerk, { kind: 'purchase', partyId, postingDate: '2026-10-01', billNo, lines: [{ description: 'Work', qty: '1', rate: '60000' }] })) as { id: string }).id
  // The numbering row for purchase bills must exist, so the barrier below can hold it.
  await submitInvoice(b.admin, { invoiceId: await bill(other, 'O-1') })
  const first = await bill(payee, 'P-1')
  const second = await bill(payee, 'P-2')

  let release!: () => void
  const barrier = new Promise<void>((resolve) => (release = resolve))
  let held!: () => void
  const holding = new Promise<void>((resolve) => (held = resolve))
  const hold = withTenant(b.id, async (tx) => {
    await tx.execute(sql`select 1 from finance_series_counters where doc_type = 'purchase_invoice' for update`)
    held()
    await barrier
  })
  await holding
  const one = submitInvoice(b.admin, { invoiceId: first })
  const two = submitInvoice(b.admin2, { invoiceId: second })
  await new Promise((resolve) => setTimeout(resolve, 700))
  release()
  await Promise.all([hold, one, two])

  const rows = await withTenant(b.id, (tx) =>
    tx.execute<{ tds_paise: string }>(sql`select tds_paise from finance_invoices where id in (${first}, ${second}) order by tds_paise`),
  )
  const tds = rows.rows.map((r) => Number(r.tds_paise))
  assert.equal(tds[0], 0)
  assert.equal(tds[0]! + tds[1]!, 120_000)
})

// --- Step 7: encumbrance and the purchase-order budget check (ACC-12) --------------

async function budgeted(b: Books, hardLimit: boolean) {
  const service = await createItem(b.clerk, { code: 'SVC', name: 'Service', nature: 'service' })
  await setBudget(b.admin, { year: 2026, costCenter: 'ADMIN-CC', accountCode: '5400', amount: '10000', hardLimit })
  const vendor = await supplier(b)
  const po = async (rate: string) =>
    (await saveOrder(b.clerk, { kind: 'purchase_order', partyId: vendor, postingDate: '2026-10-01', costCenter: 'ADMIN-CC', lines: [{ itemId: service.id, qty: '1', rate }] })) as { id: string }
  return { service, vendor, po }
}

const row = async (b: Books) => (await budgetReport(b.admin, { year: 2026 })).rows.find((r) => r.costCenter === 'ADMIN-CC')!

test('a purchase order beyond its budget is refused at submit (ACC-12)', async () => {
  const b = await books()
  const { po } = await budgeted(b, true)
  await submitOrder(b.admin, { orderId: (await po('8000')).id })
  const e = await closeRefusal(submitOrder(b.admin, { orderId: (await po('3000')).id }))
  assert.equal(e.code, 'over_budget')
  assert.equal(e.status, 409)
  assert.equal((e.detail as { wouldBePaise: number }).wouldBePaise, 1_100_000)
})

test('billing a PO moves the amount from committed to spent', async () => {
  const b = await books()
  const { po, service, vendor } = await budgeted(b, true)
  const first = await po('8000')
  await submitOrder(b.admin, { orderId: first.id })
  const before = (await row(b)) as { actualPaise: number; committedPaise: number; availablePaise: number }
  assert.deepEqual([before.actualPaise, before.committedPaise, before.availablePaise], [0, 800_000, 200_000])
  const [line] = await withTenant(b.id, (tx) => tx.select().from(orderLines).where(eq(orderLines.orderId, first.id)))
  const bill = (await saveInvoice(b.clerk, {
    kind: 'purchase', partyId: vendor, postingDate: '2026-10-02', billNo: 'PO-1',
    lines: [{ itemId: service.id, qty: '1', rate: '8000', orderLineId: line!.id, costCenter: 'ADMIN-CC' }],
  })) as { id: string }
  await submitInvoice(b.admin, { invoiceId: bill.id })
  const after = (await row(b)) as { actualPaise: number; committedPaise: number }
  assert.deepEqual([after.actualPaise, after.committedPaise], [800_000, 0])
})

test('a soft budget only reports', async () => {
  const b = await books()
  const { po } = await budgeted(b, false)
  await submitOrder(b.admin, { orderId: (await po('8000')).id })
  await submitOrder(b.admin, { orderId: (await po('3000')).id })
  assert.equal(((await row(b)) as { availablePaise: number }).availablePaise, -100_000)
})
