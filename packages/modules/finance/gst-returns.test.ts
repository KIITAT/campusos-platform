import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { FinanceError, createParty, getSettings, loadIndiaPreset, refusal, saveInvoice, updateSettings, type Actor } from './api'

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
