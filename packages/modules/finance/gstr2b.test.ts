import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { ADMIN, OFFICE } from '@campusos/module-framework'
import { taxTemplates } from './schema'
import { routeRoles } from './route-roles'
import {
  FinanceError,
  createParty,
  docKey,
  import2b,
  list2bReturns,
  loadIndiaPreset,
  match2b,
  saveInvoice,
  submitInvoice,
  updateSettings,
  type Actor,
} from './api'

/** GSTR-2B import and matching against purchase bills (P1-05a, ACC-03). */

let n = 0
const SLUG = 'fin-2b-'
const OUR_GSTIN = '29ABCDE1234F1Z5'
const SUPPLIER_GSTIN = '27ABCDE1234F1Z5'

interface Books {
  id: string
  admin: Actor
  clerk: Actor
  teacher: Actor
  supplier: string
  gst18: string
}

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: '2B College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
      { email: `tch@${tag}.test`, institutionId: id, role: 'student', name: 'Stu' },
    ])
    .returning({ id: users.id })
  const who = (at: number, role: Role): Actor => ({ id: people[at]!.id, email: `${at}@${tag}.test`, role, institutionId: id })
  const admin = who(0, 'institution_admin')
  const clerk = who(1, 'accounts_staff')
  await loadIndiaPreset(admin)
  await updateSettings(admin, { gstin: OUR_GSTIN, stateCode: '29' })
  const supplier = (await createParty(clerk, { code: `S${++n}`, name: 'Paper Mart', isSupplier: true, stateCode: '27', gstin: SUPPLIER_GSTIN })).id
  const gst18 = await withTenant(id, async (tx) => (await tx.select().from(taxTemplates).where(eq(taxTemplates.name, 'GST 18%')))[0]!.id)
  return { id, admin, clerk, teacher: who(2, 'student'), supplier, gst18 }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

async function refused(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof FinanceError, `expected a FinanceError, got ${String(e)}`)
    assert.equal(e.code, code)
    if (status) assert.equal(e.status, status)
    return true
  })
}

/** A purchase bill of 10,000 plus 18% IGST, from the fixture supplier. */
async function bill(b: Books, billNo: string, postingDate: string) {
  const inv = (await saveInvoice(b.clerk, {
    kind: 'purchase',
    partyId: b.supplier,
    postingDate,
    billNo,
    lines: [{ description: 'Paper', qty: '1', rate: '10000', taxTemplateId: b.gst18 }],
  })) as { id: string; number: string }
  await submitInvoice(b.admin, { invoiceId: inv.id })
  return inv
}

interface TwoBDoc {
  num: string
  txval?: number
  igst?: number
  date?: string
}
/** A GSTR-2B JSON file as the portal sends it, with only the keys the reader uses. */
function twoB(period: string, docs: TwoBDoc[], extra: { credits?: TwoBDoc[]; impg?: number; gstin?: string } = {}) {
  const item = (d: TwoBDoc) => ({ txval: d.txval ?? 10000, igst: d.igst ?? 1800, cgst: 0, sgst: 0, cess: 0 })
  const data = {
    gstin: extra.gstin ?? OUR_GSTIN,
    rtnprd: period,
    docdata: {
      b2b: [
        {
          ctin: SUPPLIER_GSTIN,
          trdnm: 'Paper Mart',
          inv: docs.map((d) => ({ inum: d.num, dt: d.date ?? '05-04-2026', val: 11800, rev: 'N', itcavl: 'Y', items: [item(d)] })),
        },
      ],
      ...(extra.credits
        ? { cdnr: [{ ctin: SUPPLIER_GSTIN, trdnm: 'Paper Mart', nt: extra.credits.map((d) => ({ ntnum: d.num, typ: 'C', dt: d.date ?? '20-04-2026', val: 5900, rev: 'N', itcavl: 'Y', items: [item(d)] })) }] }
        : {}),
      ...(extra.impg ? { impg: Array.from({ length: extra.impg }, (_, k) => ({ boenum: `B${k}` })) } : {}),
    },
  }
  return upload({ data }, `gstr2b-${period}.json`)
}
const upload = (json: unknown, name = 'gstr2b.json') => {
  const text = JSON.stringify(json)
  return { name, type: 'application/json', size: text.length, base64: Buffer.from(text).toString('base64') }
}

test('docKey ignores punctuation, case and leading zeros', () => {
  assert.equal(docKey('INV/001'), 'INV1')
  assert.equal(docKey('inv-1'), 'INV1')
  assert.equal(docKey('0000'), '')
})

test('import stores B2B and CDNR and counts the rest', async () => {
  const b = await books()
  const first = await import2b(b.clerk, { file: twoB('042026', [{ num: 'INV-1' }, { num: 'INV-2' }, { num: 'INV-3' }], { credits: [{ num: 'CN-1' }], impg: 2 }) })
  assert.equal(first.documents, 4)
  assert.deepEqual(first.skipped, { impg: 2 })
  assert.equal(first.replaced, false)
  const again = await import2b(b.clerk, { file: twoB('042026', [{ num: 'INV-1' }, { num: 'INV-2' }, { num: 'INV-3' }], { credits: [{ num: 'CN-1' }], impg: 2 }) })
  assert.equal(again.replaced, true)
  assert.equal(again.documents, 4)
  const listed = await list2bReturns(b.clerk)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.documents, 4)
})

test('matching lists what matches, what differs and what is missing on either side', async () => {
  const b = await books()
  await bill(b, 'INV/001', '2026-04-05')
  await bill(b, 'INV/002', '2026-04-06')
  await bill(b, 'INV/009', '2026-04-07')
  await import2b(b.clerk, { file: twoB('042026', [{ num: 'INV-1' }, { num: 'INV-2', igst: 2300 }, { num: 'INV-3' }]) })
  const r = await match2b(b.clerk, { period: '2026-04' })
  assert.deepEqual(r.summary, { matched: 1, differs: 1, notInBooks: 1, notIn2b: 1 })
  assert.deepEqual(r.rows.map((x) => x.status), ['differs', 'not_in_books', 'not_in_2b', 'matched'])
  const matched = r.rows.find((x) => x.status === 'matched')!
  assert.equal(matched.docNumber, 'INV-1')
  assert.equal(matched.books!.igstPaise, 180_000)
  assert.equal(matched.gstr2b!.igstPaise, 180_000)
  assert.equal(matched.itcAvailable, true)
})

test('the tolerance is one rupee a component, inclusive', async () => {
  const b = await books()
  await bill(b, 'T-100', '2026-04-05')
  await bill(b, 'T-101', '2026-04-06')
  await import2b(b.clerk, { file: twoB('042026', [{ num: 'T-100', igst: 1801 }, { num: 'T-101', igst: 1801.01 }]) })
  const r = await match2b(b.clerk, { period: '2026-04' })
  assert.equal(r.rows.find((x) => x.docNumber === 'T-100')!.status, 'matched', 'exactly 100 paise')
  assert.equal(r.rows.find((x) => x.docNumber === 'T-101')!.status, 'differs', '101 paise')
})

test('a bill booked in an earlier month matches a later 2B', async () => {
  const b = await books()
  await bill(b, 'EARLY-1', '2026-04-02')
  await import2b(b.clerk, { file: twoB('042026', [{ num: 'OTHER-1' }]) })
  await import2b(b.clerk, { file: twoB('052026', [{ num: 'EARLY-1', date: '02-05-2026' }]) })
  const may = await match2b(b.clerk, { period: '2026-05' })
  const early = may.rows.find((x) => x.docNumber === 'EARLY-1')!
  assert.equal(early.status, 'matched')
  assert.equal(early.bookedOn, '2026-04-02')
  const april = await match2b(b.clerk, { period: '2026-04' })
  assert.equal(april.rows.some((x) => x.status === 'not_in_2b'), false, 'May’s 2B accounts for the April bill')
})

test('refusals', async () => {
  const b = await books()
  await refused(import2b(b.clerk, { file: twoB('042026', [{ num: 'X-1' }], { gstin: '27ABCDE1234F1Z5' }) }), 'wrong_gstin', 409)
  await refused(import2b(b.clerk, { file: upload({ x: 1 }) }), 'bad_2b_file', 400)
  await refused(match2b(b.clerk, { period: '2026-07' }), 'no_2b', 404)
})

test('a clerk imports; a student cannot', async () => {
  assert.deepEqual(routeRoles['POST /gst/2b'], OFFICE)
  assert.deepEqual(routeRoles['GET /gst/2b'], OFFICE)
  assert.deepEqual(routeRoles['GET /gst/2b/returns'], OFFICE)
  assert.ok(!OFFICE.includes('student'))
  void ADMIN
  const b = await books()
  await refused(import2b(b.teacher, { file: twoB('042026', [{ num: 'X-1' }]) }), 'forbidden', 403)
})
