import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { printedText } from '@campusos/module-framework/pdf'
import {
  FinanceError,
  accountFor,
  cancelInvoice,
  dueDateOf,
  monthsLate,
  recordChallan,
  tdsCertificatePdf,
  tdsInterest,
  tdsQuarterFile,
  trialBalance,
  voidChallan,
  createParty,
  createTdsSection,
  loadIndiaPreset,
  refusal,
  savePayment,
  saveInvoice,
  submitInvoice,
  submitPayment,
  updateSettings,
  type Actor,
} from './api'

/** The TDS returns pack (P1-05b, ACC-31 and the second half of ACC-06). */

let n = 0
const SLUG = 'fin-tds-'

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
    .values({ slug: tag, name: 'TDS College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
      { email: `adm2@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm Two' },
    ])
    .returning({ id: users.id })
  const who = (at: number, role: Role): Actor => ({ id: people[at]!.id, email: `${at}@${tag}.test`, role, institutionId: id })
  const b = { id, admin: who(0, 'institution_admin'), clerk: who(1, 'accounts_staff'), admin2: who(2, 'institution_admin') }
  await loadIndiaPreset(b.admin)
  await updateSettings(b.admin, { gstin: '29ABCDE1234F1Z5', stateCode: '29', tan: 'BLRA12345B', pan: 'ABCDE1234F', legalName: 'TDS College' })
  return b
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

async function dbRefuses(p: Promise<unknown>, constraint: string) {
  await assert.rejects(p, (e: unknown) => {
    const r = refusal(e)
    assert.ok(r instanceof FinanceError && r.code === constraint, `expected ${constraint}, got ${String(r)}`)
    return true
  })
}

/** A submitted purchase bill, the one thing a challan link can point at. */
async function aBill(b: Books) {
  const s = await createParty(b.clerk, { code: `S${++n}`, name: 'Consultant', isSupplier: true, stateCode: '29', pan: 'ABCDE1234F' })
  const bill = (await saveInvoice(b.clerk, { kind: 'purchase', partyId: s.id, postingDate: '2026-04-10', billNo: `B-${n}`, lines: [{ description: 'Advice', qty: '1', rate: '100' }] })) as { id: string }
  await submitInvoice(b.admin, { invoiceId: bill.id })
  return bill.id
}

/** A live challan row for the institution; returns its id. */
async function aChallan(b: Books, serial = '00012') {
  const bank = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))
  return withTenant(b.id, async (tx) => {
    const r = await tx.execute(sql`
      insert into finance_tds_challans (institution_id, form, month, deposited_on, bsr_code, challan_serial, tds_paise, account_id)
      values (${b.id}, '26Q', '2026-04-01', '2026-05-06', '0510308', ${serial}, 1000, ${bank}) returning id`)
    return (r.rows[0] as { id: string }).id
  })
}

test('challans and links are isolated by institution', async () => {
  const a = await books()
  const other = await books()
  const bill = await aBill(a)
  const challan = await aChallan(a)
  await withTenant(a.id, (tx) =>
    tx.execute(sql`insert into finance_tds_challan_links (institution_id, challan_id, invoice_id, tds_paise) values (${a.id}, ${challan}, ${bill}, 1000)`),
  )
  const count = (table: string, id: string) =>
    withTenant(id, async (tx) => Number(((await tx.execute(sql.raw(`select count(*)::int as c from ${table}`))).rows[0] as { c: number }).c))
  assert.equal(await count('finance_tds_challans', other.id), 0)
  assert.equal(await count('finance_tds_challan_links', other.id), 0)
  assert.equal(await count('finance_tds_challans', a.id), 1)
  assert.equal(await count('finance_tds_challan_links', a.id), 1)
})

test('a document links to one challan only', async () => {
  const b = await books()
  const bill = await aBill(b)
  const first = await aChallan(b, '00001')
  const second = await aChallan(b, '00002')
  const link = (challan: string) =>
    withTenant(b.id, (tx) =>
      tx.execute(sql`insert into finance_tds_challan_links (institution_id, challan_id, invoice_id, tds_paise) values (${b.id}, ${challan}, ${bill}, 1000)`),
    )
  await link(first)
  await dbRefuses(link(second), 'finance_tds_challan_links_invoice')
})

test('a link names one document', async () => {
  const b = await books()
  const bill = await aBill(b)
  const challan = await aChallan(b)
  await dbRefuses(
    withTenant(b.id, (tx) =>
      tx.execute(sql`insert into finance_tds_challan_links (institution_id, challan_id, invoice_id, payment_id, tds_paise)
        values (${b.id}, ${challan}, ${bill}, ${bill}, 1000)`),
    ),
    'finance_tds_challan_links_one',
  )
})

async function refused(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof FinanceError, `expected a FinanceError, got ${String(e)}`)
    assert.equal(e.code, code)
    if (status) assert.equal(e.status, status)
    return true
  })
}

// --- sections on payments; advances absorbed at billing ----------------------

/** A professional-fees section that always deducts 10%, and a supplier on it. */
async function deducting(b: Books) {
  const section = (await createTdsSection(b.admin, { code: 'PROFX', name: 'Professional fees', ratePercent: '10', rateNoPanPercent: '20', thresholdSingle: '0', thresholdAnnual: '0' })) as { id: string }
  const payee = (await createParty(b.clerk, { code: `P${++n}`, name: 'Consultant', isSupplier: true, stateCode: '29', pan: 'ABCDE1234F', tdsSectionId: section.id })).id
  const cash = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'cash'))
  return { section: section.id, payee, cash }
}

const advance = (b: Books, d: { payee: string; cash: string; section: string }, amount = '9000', tds = '1000', date = '2026-04-05') =>
  savePayment(b.clerk, { kind: 'pay', partyId: d.payee, postingDate: date, accountId: d.cash, amount, tds, tdsSectionId: d.section }) as Promise<{ id: string }>

const bill = async (b: Books, payee: string, billNo: string, date = '2026-04-20') =>
  ((await saveInvoice(b.clerk, { kind: 'purchase', partyId: payee, postingDate: date, billNo, lines: [{ description: 'Advice', qty: '1', rate: '10000' }] })) as { id: string }).id

const tdsOf = (b: Books, id: string) =>
  withTenant(b.id, async (tx) => {
    const r = await tx.execute(sql`select tds_paise::int as tds, tds_advance_paise::int as adv from finance_invoices where id = ${id}`)
    return r.rows[0] as { tds: number; adv: number }
  })

test("a payment's TDS names its section", async () => {
  const b = await books()
  const d = await deducting(b)
  await refused(savePayment(b.clerk, { kind: 'pay', partyId: d.payee, accountId: d.cash, amount: '900', tds: '100' }), 'tds_section_required', 400)
})

test("an advance's TDS is not deducted again on the bill", async () => {
  const b = await books()
  const d = await deducting(b)
  const pay = await advance(b, d)
  await submitPayment(b.admin, { paymentId: pay.id })
  const first = await bill(b, d.payee, 'A-1')
  await submitInvoice(b.admin, { invoiceId: first })
  assert.deepEqual(await tdsOf(b, first), { tds: 0, adv: 100_000 })
  const second = await bill(b, d.payee, 'A-2')
  await submitInvoice(b.admin, { invoiceId: second })
  assert.deepEqual(await tdsOf(b, second), { tds: 100_000, adv: 0 })
})

test('an advance and a bill submitted together deduct the tax once', async () => {
  const b = await books()
  const d = await deducting(b)
  const other = (await createParty(b.clerk, { code: `O${++n}`, name: 'Other', isSupplier: true, stateCode: '29' })).id
  // The numbering row for payments must exist, so the barrier below can hold it.
  const prior = (await savePayment(b.clerk, { kind: 'pay', partyId: other, accountId: d.cash, amount: '100', postingDate: '2026-04-01' })) as { id: string }
  await submitPayment(b.admin, { paymentId: prior.id })
  const pay = await advance(b, d)
  const billId = await bill(b, d.payee, 'C-1')

  let release!: () => void
  const barrier = new Promise<void>((resolve) => (release = resolve))
  let held!: () => void
  const holding = new Promise<void>((resolve) => (held = resolve))
  const hold = withTenant(b.id, async (tx) => {
    await tx.execute(sql`select 1 from finance_series_counters where doc_type = 'payment_pay' for update`)
    held()
    await barrier
  })
  await holding
  const paying = submitPayment(b.admin, { paymentId: pay.id })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const billing = submitInvoice(b.admin2, { invoiceId: billId })
  await new Promise((resolve) => setTimeout(resolve, 300))
  release()
  await Promise.all([hold, paying, billing])

  const total = await withTenant(b.id, async (tx) => {
    const r = await tx.execute(sql`
      select (select coalesce(sum(tds_paise), 0) from finance_payments where id = ${pay.id})::int
           + (select coalesce(sum(tds_paise), 0) from finance_invoices where id = ${billId})::int as total`)
    return (r.rows[0] as { total: number }).total
  })
  assert.equal(total, 100_000)
})

test("an advance's tax is counted as deducted when the annual threshold is crossed (review finding 1)", async () => {
  const b = await books()
  const section = (await createTdsSection(b.admin, { code: 'ANNX', name: 'Annual only', ratePercent: '10', rateNoPanPercent: '20', thresholdSingle: '0', thresholdAnnual: '50000' })) as { id: string }
  const payee = (await createParty(b.clerk, { code: `Q${++n}`, name: 'Consultant', isSupplier: true, stateCode: '29', pan: 'ABCDE1234F', tdsSectionId: section.id })).id
  const cash = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'cash'))
  const pay = await advance(b, { payee, cash, section: section.id })
  await submitPayment(b.admin, { paymentId: pay.id })
  const big = (await saveInvoice(b.clerk, { kind: 'purchase', partyId: payee, postingDate: '2026-04-20', billNo: 'Y-1', lines: [{ description: 'Advice', qty: '1', rate: '60000' }] })) as { id: string }
  await submitInvoice(b.admin, { invoiceId: big.id })
  assert.deepEqual(await tdsOf(b, big.id), { tds: 500_000, adv: 100_000 })
  const next = await bill(b, payee, 'Y-2', '2026-04-25')
  await submitInvoice(b.admin, { invoiceId: next })
  // 10% of 70,000 is 7,000 in all: 1,000 on the advance, 5,000 on the first bill, 1,000 on this one.
  assert.deepEqual(await tdsOf(b, next), { tds: 100_000, adv: 0 })
})

// --- the challan register ----------------------------------------------------

const CHALLAN = { form: '26Q', month: '2026-04', depositedOn: '2026-05-06', bsrCode: '0510308', challanSerial: '00012' }

/** April's deductions: three bills under two sections and one advance, 2,200 of tax. */
async function april(b: Books) {
  const d = await deducting(b)
  const contractors = (await createTdsSection(b.admin, { code: 'CONTX', name: 'Contractors', ratePercent: '1', rateNoPanPercent: '20', thresholdSingle: '0', thresholdAnnual: '0' })) as { id: string }
  const builder = (await createParty(b.clerk, { code: `B${++n}`, name: 'Builder', isSupplier: true, stateCode: '29', pan: 'BBBBB1234B', tdsSectionId: contractors.id })).id
  const advancee = (await createParty(b.clerk, { code: `V${++n}`, name: 'Visiting expert', isSupplier: true, stateCode: '29', pan: 'CCCCC1234C', tdsSectionId: d.section })).id
  const advanceId = (await savePayment(b.clerk, { kind: 'pay', partyId: advancee, postingDate: '2026-04-08', accountId: d.cash, amount: '4500', tds: '500', tdsSectionId: d.section })) as { id: string }
  await submitPayment(b.admin, { paymentId: advanceId.id })
  const make = async (partyId: string, no: string, rate: string) => {
    const id = ((await saveInvoice(b.clerk, { kind: 'purchase', partyId, postingDate: '2026-04-15', billNo: no, lines: [{ description: 'Work', qty: '1', rate }] })) as { id: string }).id
    await submitInvoice(b.admin, { invoiceId: id })
    return id
  }
  const bills = [await make(d.payee, 'K-1', '10000'), await make(d.payee, 'K-2', '5000'), await make(builder, 'K-3', '20000')]
  const bank = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))
  return { ...d, builder, bills, advanceId: advanceId.id, bank }
}

const linkCount = (b: Books, challanId: string) =>
  withTenant(b.id, async (tx) => Number(((await tx.execute(sql`select count(*)::int as c from finance_tds_challan_links where challan_id = ${challanId}`)).rows[0] as { c: number }).c))
const balance = async (b: Books, code: string) => (await trialBalance(b.admin)).rows.find((r) => r.code === code)?.balancePaise ?? 0

test('a challan deposits the month and ties every deduction', async () => {
  const b = await books()
  const f = await april(b)
  assert.equal(await balance(b, '2410'), 220_000, 'the tax deducted in April is payable')
  const c = (await recordChallan(b.admin, { ...CHALLAN, accountId: f.bank })) as { id: string; tdsPaise: number; links: number }
  assert.equal(c.links, 4)
  assert.equal(c.tdsPaise, 220_000)
  assert.equal(await linkCount(b, c.id), 4)
  assert.equal(await balance(b, '2410'), 0)
  const tb = await trialBalance(b.admin)
  assert.equal(tb.differencePaise, 0, 'the books balance')
})

test('nothing left to deposit, and the same challan twice, are refused', async () => {
  const b = await books()
  const f = await april(b)
  await recordChallan(b.admin, { ...CHALLAN, accountId: f.bank })
  await refused(recordChallan(b.admin, { ...CHALLAN, challanSerial: '00013', accountId: f.bank }), 'nothing_due', 409)
  // May has a deduction of its own, so only the repeated challan details are wrong.
  const may = ((await saveInvoice(b.clerk, { kind: 'purchase', partyId: f.payee, postingDate: '2026-05-12', billNo: 'M-1', lines: [{ description: 'Work', qty: '1', rate: '1000' }] })) as { id: string }).id
  await submitInvoice(b.admin, { invoiceId: may })
  await refused(recordChallan(b.admin, { ...CHALLAN, month: '2026-05', accountId: f.bank }), 'duplicate_challan', 409)
})

test('interest and fee on a challan are an expense', async () => {
  const b = await books()
  const f = await april(b)
  await recordChallan(b.admin, { ...CHALLAN, interest: '50', fee: '0', accountId: f.bank })
  assert.equal(await balance(b, '5610'), 5_000)
})

test('a deposited bill cannot be cancelled until the challan is voided', async () => {
  const b = await books()
  const f = await april(b)
  const c = (await recordChallan(b.admin, { ...CHALLAN, accountId: f.bank })) as { id: string }
  await refused(cancelInvoice(b.admin, { invoiceId: f.bills[0]!, reason: 'wrong supplier' }), 'tds_deposited', 409)
  await refused(voidChallan(b.admin, { challanId: c.id, reason: 'no' }), 'void_reason', 400)
  await voidChallan(b.admin, { challanId: c.id, reason: 'wrong serial' })
  await refused(voidChallan(b.admin, { challanId: c.id, reason: 'wrong serial' }), 'already_voided', 409)
  assert.equal(await linkCount(b, c.id), 0)
  assert.equal(await balance(b, '2410'), 220_000, 'the deposit is reversed')
  await cancelInvoice(b.admin, { invoiceId: f.bills[0]!, reason: 'wrong supplier' })
  const voided = await withTenant(b.id, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'tds.challan_voided')))
  assert.equal(voided.length, 1)
})

test('a voided challan can be recorded again', async () => {
  const b = await books()
  const f = await april(b)
  const c = (await recordChallan(b.admin, { ...CHALLAN, accountId: f.bank })) as { id: string }
  await voidChallan(b.admin, { challanId: c.id, reason: 'wrong serial' })
  const again = (await recordChallan(b.admin, { ...CHALLAN, accountId: f.bank })) as { links: number }
  assert.equal(again.links, 4)
})

test('a 27Q challan does not pick up a 26Q deduction', async () => {
  const b = await books()
  const f = await april(b)
  const abroad = (await createParty(b.clerk, { code: `X${++n}`, name: 'Foreign advisor', isSupplier: true, gstCategory: 'overseas', pan: 'DDDDD1234D', tdsSectionId: f.section })).id
  const id = ((await saveInvoice(b.clerk, { kind: 'purchase', partyId: abroad, postingDate: '2026-04-20', billNo: 'F-1', lines: [{ description: 'Advice', qty: '1', rate: '10000' }] })) as { id: string }).id
  await submitInvoice(b.admin, { invoiceId: id })
  const resident = (await recordChallan(b.admin, { ...CHALLAN, accountId: f.bank })) as { links: number }
  assert.equal(resident.links, 4, 'the overseas bill is not among them')
  const overseas = (await recordChallan(b.admin, { ...CHALLAN, form: '27Q', challanSerial: '00099', accountId: f.bank })) as { links: number; tdsPaise: number }
  assert.equal(overseas.links, 1)
  assert.equal(overseas.tdsPaise, 100_000)
})

test('only an administrator records a challan, and not for a future day', async () => {
  const b = await books()
  const f = await april(b)
  await refused(recordChallan(b.clerk, { ...CHALLAN, accountId: f.bank }), 'forbidden', 403)
  await refused(recordChallan(b.admin, { ...CHALLAN, depositedOn: '2099-01-01', accountId: f.bank }), 'future_date', 409)
})

// --- the quarterly working statement and late-deposit interest ---------------

const parseCsv = (text: string | Uint8Array) =>
  String(typeof text === 'string' ? text : Buffer.from(text).toString('utf8'))
    .split('\n')
    .map((line) => line.split(','))

test('the quarter file lists deductions, challans and what is still undeposited', async () => {
  const b = await books()
  const f = await april(b)
  await recordChallan(b.admin, { ...CHALLAN, accountId: f.bank })
  const noPan = (await createParty(b.clerk, { code: `N${++n}`, name: 'No PAN Advisor', isSupplier: true, stateCode: '29', tdsSectionId: f.section })).id
  const june = ((await saveInvoice(b.clerk, { kind: 'purchase', partyId: noPan, postingDate: '2026-06-10', billNo: 'J-1', lines: [{ description: 'Advice', qty: '1', rate: '1000' }] })) as { id: string }).id
  await submitInvoice(b.admin, { invoiceId: june })
  const out = await tdsQuarterFile(b.clerk, { fy: 2026, quarter: 1, form: '26Q' })
  assert.equal(out.fileName, 'tds-26Q-2026-Q1.csv')
  const rows = parseCsv(out.bytes)
  assert.equal(rows[0]!.join(','), 'Record,Section,Deductee,PAN,Document,Date,Amount paid,TDS,BSR code,Challan serial,Deposited on')
  assert.equal(rows.filter((r) => r[0] === 'DEDUCTEE').length, 5)
  assert.equal(rows.filter((r) => r[0] === 'CHALLAN').length, 1)
  assert.ok(rows.some((r) => r[0] === 'DEDUCTEE' && r[2] === 'No PAN Advisor' && r[3] === 'PANNOTAVBL'))
  const total = (label: string) => rows.find((r) => r[0] === 'TOTAL' && r[1] === label)![7]
  assert.equal(total('Deducted'), '2400.00')
  assert.equal(total('Deposited'), '2200.00')
  assert.equal(total('Difference'), '200.00')
})

test('quarter four runs January to March of the next year', async () => {
  const b = await books()
  const d = await deducting(b)
  const id = ((await saveInvoice(b.clerk, { kind: 'purchase', partyId: d.payee, postingDate: '2027-02-10', billNo: 'Q4-1', lines: [{ description: 'Advice', qty: '1', rate: '1000' }] })) as { id: string }).id
  await submitInvoice(b.admin, { invoiceId: id })
  const q4 = parseCsv((await tdsQuarterFile(b.clerk, { fy: 2026, quarter: 4, form: '26Q' })).bytes)
  assert.equal(q4.filter((r) => r[0] === 'DEDUCTEE').length, 1)
  const q3 = parseCsv((await tdsQuarterFile(b.clerk, { fy: 2026, quarter: 3, form: '26Q' })).bytes)
  assert.equal(q3.filter((r) => r[0] === 'DEDUCTEE').length, 0)
})

test('a quarter outside one to four is refused', async () => {
  const b = await books()
  await refused(tdsQuarterFile(b.clerk, { fy: 2026, quarter: 5, form: '26Q' }), 'bad_period', 400)
  await refused(tdsQuarterFile(b.clerk, { fy: 1999, quarter: 1, form: '26Q' }), 'bad_period', 400)
})

test('due dates and months late', () => {
  assert.equal(dueDateOf('2026-04-15'), '2026-05-07')
  assert.equal(dueDateOf('2026-12-31'), '2027-01-07')
  assert.equal(dueDateOf('2027-03-10'), '2027-04-30')
  assert.equal(monthsLate('2026-04-15', '2026-05-08'), 2)
  assert.equal(monthsLate('2026-04-15', '2026-05-06'), 2)
  assert.equal(monthsLate('2026-04-15', '2026-04-20'), 1)
})

test('late deposit interest is a month and a half percent for each month or part', async () => {
  const b = await books()
  const d = await deducting(b)
  const bank = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))
  const big = async (no: string, date: string) => {
    const id = ((await saveInvoice(b.clerk, { kind: 'purchase', partyId: d.payee, postingDate: date, billNo: no, lines: [{ description: 'Advice', qty: '1', rate: '100000' }] })) as { id: string }).id
    await submitInvoice(b.admin, { invoiceId: id })
  }
  // Deducted on 15 April, deposited on 8 May: late, two months.
  await big('L-1', '2026-04-15')
  await recordChallan(b.admin, { ...CHALLAN, depositedOn: '2026-05-08', accountId: bank })
  const late = await tdsInterest(b.clerk, { on: '2026-07-01' })
  assert.equal(late.rows.length, 1)
  assert.equal(late.rows[0]!.months, 2)
  assert.equal(late.rows[0]!.interestPaise, 30_000)
  assert.equal(late.totalPaise, 30_000)
  // Deposited on 6 May: on time, no row.
  const c = await books()
  const dc = await deducting(c)
  const bankC = await withTenant(c.id, (tx) => accountFor(tx, c.id, 'bank'))
  const idC = ((await saveInvoice(c.clerk, { kind: 'purchase', partyId: dc.payee, postingDate: '2026-04-15', billNo: 'L-2', lines: [{ description: 'Advice', qty: '1', rate: '100000' }] })) as { id: string }).id
  await submitInvoice(c.admin, { invoiceId: idC })
  await recordChallan(c.admin, { ...CHALLAN, accountId: bankC })
  assert.equal((await tdsInterest(c.clerk, { on: '2026-07-01' })).rows.length, 0)
  // Never deposited, as of 1 July: four months.
  const e = await books()
  const de = await deducting(e)
  const idE = ((await saveInvoice(e.clerk, { kind: 'purchase', partyId: de.payee, postingDate: '2026-04-15', billNo: 'L-3', lines: [{ description: 'Advice', qty: '1', rate: '100000' }] })) as { id: string }).id
  await submitInvoice(e.admin, { invoiceId: idE })
  const open = await tdsInterest(e.clerk, { on: '2026-07-01' })
  assert.equal(open.rows[0]!.months, 4)
  assert.equal(open.rows[0]!.interestPaise, 60_000)
})

// --- the certificate statement -----------------------------------------------

test('the certificate statement quotes the challan of each deduction', async () => {
  const b = await books()
  const f = await april(b)
  await recordChallan(b.admin, { ...CHALLAN, accountId: f.bank })
  const out = await tdsCertificatePdf(b.clerk, { partyId: f.payee, fy: 2026, quarter: 1 })
  assert.match(out.fileName, /^tds-statement-P\d+-2026-Q1\.pdf$/)
  const printed = await printedText(out.bytes)
  const all = printed.join('|')
  assert.ok(all.includes('BLRA12345B'), 'the TAN')
  assert.ok(all.includes('ABCDE1234F'), "the supplier's PAN")
  assert.equal(printed.filter((s) => s === '0510308').length, 2, 'the BSR code of each of the two deductions')
  assert.equal(printed.filter((s) => s === '00012').length, 2, 'and the challan serial')
  assert.ok(all.includes('1,500.00'), 'the total tax')
  assert.ok(all.includes('issued from TRACES'), all)
  assert.ok(all.includes('Form 16A or its Income-tax Act 2025 equivalent'), 'the form name from 2026')
})

test('the certificate statement for an earlier year is a Form 16A', async () => {
  const b = await books()
  const d = await deducting(b)
  const id = ((await saveInvoice(b.clerk, { kind: 'purchase', partyId: d.payee, postingDate: '2025-06-10', billNo: 'Y-1', lines: [{ description: 'Advice', qty: '1', rate: '1000' }] })) as { id: string }).id
  await submitInvoice(b.admin, { invoiceId: id })
  const all = (await printedText((await tdsCertificatePdf(b.clerk, { partyId: d.payee, fy: 2025, quarter: 1 })).bytes)).join('|')
  assert.ok(all.includes('Form 16A'))
  assert.ok(all.includes('not yet deposited'))
  assert.ok(!all.includes('Income-tax Act 2025 equivalent'))
})

test('a party with no deductions has no statement', async () => {
  const b = await books()
  const d = await deducting(b)
  await refused(tdsCertificatePdf(b.clerk, { partyId: d.payee, fy: 2026, quarter: 1 }), 'no_such_statement', 404)
})
