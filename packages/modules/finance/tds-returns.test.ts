import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import {
  FinanceError,
  accountFor,
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
