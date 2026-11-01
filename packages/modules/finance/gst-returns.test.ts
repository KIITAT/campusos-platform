import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { printedText } from '@campusos/module-framework/pdf'
import { taxTemplates } from './schema'
import {
  FinanceError,
  cmp08,
  createParty,
  getSettings,
  invoicePdf,
  invoiceDetail,
  loadIndiaPreset,
  makeReturn,
  refusal,
  saveInvoice,
  submitInvoice,
  trialBalance,
  updateSettings,
  type Actor,
} from './api'

/**
 * The GST returns pack (P1-05a, ACC-03 Part A): the institution's scheme and
 * filing frequency, QRMP and composition, GSTR-1 and IFF files, GSTR-2B import
 * and matching.
 */

let n = 0
const SLUG = 'fin-gstr-'

interface Books {
  id: string
  admin: Actor
  clerk: Actor
}

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'GST Returns College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
    ])
    .returning({ id: users.id })
  const who = (at: number, role: Role): Actor => ({ id: people[at]!.id, email: `${at}@${tag}.test`, role, institutionId: id })
  const b = { id, admin: who(0, 'institution_admin'), clerk: who(1, 'accounts_staff') }
  await loadIndiaPreset(b.admin)
  await updateSettings(b.admin, { gstin: '29ABCDE1234F1Z5', stateCode: '29' })
  return b
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

/** The refusal a database rule raises, named the way a caller sees it. */
async function dbRefuses(p: Promise<unknown>, constraint: string) {
  await assert.rejects(p, (e: unknown) => {
    const r = refusal(e)
    assert.ok(r instanceof FinanceError && r.code === constraint, `expected ${constraint}, got ${String(r)}`)
    return true
  })
}

test('2B returns and lines are isolated by institution', async () => {
  const a = await books()
  const other = await books()
  await withTenant(a.id, async (tx) => {
    const r = await tx.execute(sql`
      insert into finance_gstr2b_returns (institution_id, period, gstin, file_name, documents)
      values (${a.id}, '2026-04', '29ABCDE1234F1Z5', 'april.json', 1) returning id`)
    const returnId = (r.rows[0] as { id: string }).id
    await tx.execute(sql`
      insert into finance_gstr2b_lines (institution_id, return_id, supplier_gstin, supplier_gstin_raw, doc_type, doc_number, doc_key, doc_date, value_paise, taxable_paise, itc_available, reverse_charge)
      values (${a.id}, ${returnId}, '27ABCDE1234F1Z5', '27ABCDE1234F1Z5', 'invoice', 'INV/1', 'INV1', '2026-04-02', 11800, 10000, true, false)`)
  })
  const count = (table: 'finance_gstr2b_returns' | 'finance_gstr2b_lines') => (id: string) =>
    withTenant(id, async (tx) => Number(((await tx.execute(sql.raw(`select count(*)::int as c from ${table}`))).rows[0] as { c: number }).c))
  assert.equal(await count('finance_gstr2b_returns')(other.id), 0)
  assert.equal(await count('finance_gstr2b_lines')(other.id), 0)
  assert.equal(await count('finance_gstr2b_returns')(a.id), 1)
  assert.equal(await count('finance_gstr2b_lines')(a.id), 1)
})

test('a composition dealer must file quarterly', async () => {
  const b = await books()
  const set = (filing: string) =>
    withTenant(b.id, (tx) =>
      tx.execute(sql`update finance_settings set gst_scheme = 'composition', composition_rate_bp = 100, gst_filing = ${filing} where institution_id = ${b.id}`),
    )
  await dbRefuses(set('monthly'), 'finance_settings_composition')
  await set('quarterly')
})

test('an IFF filing locks a B2B invoice', async () => {
  const b = await books()
  const sale = async (gstin: string | undefined) => {
    const c = await createParty(b.clerk, { code: `C${++n}`, name: `Customer ${n}`, isCustomer: true, stateCode: '27', gstin })
    return (await saveInvoice(b.clerk, {
      kind: 'sales',
      partyId: c.id,
      postingDate: '2026-04-10',
      lines: [{ description: 'Hire', qty: '1', rate: '100' }],
      submit: true,
    })) as { id: string }
  }
  const registered = await sale('27ABCDE1234F1Z5')
  const unregistered = await sale(undefined)
  await withTenant(b.id, (tx) =>
    tx.execute(sql`insert into finance_gst_filings (institution_id, return_type, period_from, period_to, filed_on) values (${b.id}, 'iff', '2026-04-01', '2026-04-30', '2026-05-13')`),
  )
  const cancel = (id: string) =>
    withTenant(b.id, (tx) => tx.execute(sql`update finance_invoices set docstatus = 'cancelled', cancelled_at = now(), cancel_reason = 'test' where id = ${id}`))
  await dbRefuses(cancel(registered.id), 'finance_invoice_in_filed_return')
  await cancel(unregistered.id)
})

const audited = (b: Books, action: string) =>
  withTenant(b.id, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.institutionId, b.id), eq(auditLog.action, action))))

async function refused(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof FinanceError, `expected a FinanceError, got ${String(e)}`)
    assert.equal(e.code, code)
    if (status) assert.equal(e.status, status)
    return true
  })
}

test('the GST scheme is set and audited', async () => {
  const b = await books()
  await updateSettings(b.admin, { gstScheme: 'composition', gstFiling: 'quarterly', compositionRate: '1' })
  const s = await getSettings(b.admin)
  assert.equal(s.gstScheme, 'composition')
  assert.equal(s.gstFiling, 'quarterly')
  assert.equal(s.compositionRateBp, 100)
  const rows = await audited(b, 'settings.gst_registration')
  assert.equal(rows.length, 1)
  assert.equal((rows[0]!.detail as { after: { rateBp: number } }).after.rateBp, 100)
})

test('composition without a rate is refused', async () => {
  const b = await books()
  await refused(updateSettings(b.admin, { gstScheme: 'composition', gstFiling: 'quarterly' }), 'composition_rate', 400)
})

test('saving an unrelated setting writes no GST registration audit row', async () => {
  const b = await books()
  await updateSettings(b.admin, { legalName: 'Some College' })
  assert.equal((await audited(b, 'settings.gst_registration')).length, 0)
})

// --- composition -------------------------------------------------------------

async function compositionBooks() {
  const b = await books()
  await updateSettings(b.admin, { gstScheme: 'composition', gstFiling: 'quarterly', compositionRate: '1' })
  const gst18 = await withTenant(b.id, async (tx) => (await tx.select().from(taxTemplates).where(eq(taxTemplates.name, 'GST 18%')))[0]!.id)
  return { b, gst18 }
}

const buyer = (b: Books) => createParty(b.clerk, { code: `C${++n}`, name: `Customer ${n}`, isCustomer: true, stateCode: '29' }).then((r) => r.id)

test('a composition dealer cannot charge GST', async () => {
  const { b, gst18 } = await compositionBooks()
  const c = await buyer(b)
  await refused(
    saveInvoice(b.clerk, { kind: 'sales', partyId: c, postingDate: '2026-04-10', lines: [{ description: 'Hire', qty: '1', rate: '100', taxTemplateId: gst18 }], submit: true }),
    'composition_no_tax',
    400,
  )
  await saveInvoice(b.clerk, { kind: 'sales', partyId: c, postingDate: '2026-04-10', lines: [{ description: 'Hire', qty: '1', rate: '100' }], submit: true })
})

test("a composition dealer's purchases claim no credit", async () => {
  const { b, gst18 } = await compositionBooks()
  const s = await createParty(b.clerk, { code: `S${++n}`, name: 'Supplier', isSupplier: true, stateCode: '29' })
  const bill = (await saveInvoice(b.clerk, {
    kind: 'purchase',
    partyId: s.id,
    postingDate: '2026-04-10',
    billNo: 'B-1',
    lines: [{ description: 'Chairs', qty: '1', rate: '10000', taxTemplateId: gst18 }],
  })) as { id: string }
  await submitInvoice(b.admin, { invoiceId: bill.id })
  const d = await invoiceDetail(b.admin, bill.id)
  assert.ok(d.taxes.length > 0)
  for (const t of d.taxes) assert.equal(t.ineligiblePaise, t.taxPaise)
  const credit = (await trialBalance(b.admin)).rows.find((r) => r.code === '1400')?.balancePaise ?? 0
  assert.equal(credit, 0, 'nothing on the input credit account')
})

test('the bill of supply prints as one', async () => {
  const { b } = await compositionBooks()
  const c = await buyer(b)
  const inv = (await saveInvoice(b.clerk, { kind: 'sales', partyId: c, postingDate: '2026-04-10', lines: [{ description: 'Hire', qty: '1', rate: '100' }], submit: true })) as { id: string }
  const text = (await printedText((await invoicePdf(b.admin, inv.id)).bytes)).join('|')
  assert.ok(text.includes('BILL OF SUPPLY'), text)
  assert.ok(text.includes('Composition taxable person, not eligible to collect tax on supplies.'), text)
})

test('CMP-08 adds up the quarter', async () => {
  const { b } = await compositionBooks()
  const c = await buyer(b)
  const a = (await saveInvoice(b.clerk, { kind: 'sales', partyId: c, postingDate: '2026-04-05', lines: [{ description: 'Hire', qty: '10', rate: '10000' }], submit: true })) as { id: string }
  await saveInvoice(b.clerk, { kind: 'sales', partyId: c, postingDate: '2026-04-20', lines: [{ description: 'Hire', qty: '1', rate: '50000' }], submit: true })
  const lineId = (await invoiceDetail(b.admin, a.id)).lines[0]!.id
  await makeReturn(b.clerk, { invoiceId: a.id, postingDate: '2026-05-10', lines: [{ lineId, qty: '2' }], submit: true })
  const r = await cmp08(b.clerk, { from: '2026-04-01', to: '2026-06-30' })
  assert.equal(r.turnoverPaise, 13_000_000)
  assert.equal(r.cgstPaise, 65_000)
  assert.equal(r.sgstPaise, 65_000)
  assert.equal(r.totalPaise, 130_000)
  await refused(cmp08(b.clerk, { from: '2026-04-01', to: '2026-04-30' }), 'bad_return_period', 400)
  const regular = await books()
  await refused(cmp08(regular.clerk, { from: '2026-04-01', to: '2026-06-30' }), 'not_composition', 409)
})
