import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { FinanceError, accountFor, createParty, loadIndiaPreset, refusal, saveInvoice, submitInvoice, updateSettings, type Actor } from './api'

/** The TDS returns pack (P1-05b, ACC-31 and the second half of ACC-06). */

let n = 0
const SLUG = 'fin-tds-'

interface Books {
  id: string
  admin: Actor
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
    ])
    .returning({ id: users.id })
  const who = (at: number, role: Role): Actor => ({ id: people[at]!.id, email: `${at}@${tag}.test`, role, institutionId: id })
  const b = { id, admin: who(0, 'institution_admin'), clerk: who(1, 'accounts_staff') }
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
