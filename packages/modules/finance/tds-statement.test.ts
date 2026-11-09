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
  recordChallan,
  saveInvoice,
  submitInvoice,
  tdsStatementFile,
  saveTdsDeductor,
  setReturnCodes,
  tdsDeductor,
  updateParty,
  updateSettings,
  type Actor,
} from './api'

/** The Form 140 and 144 statement files (P1-05d, ACC-31). */

let n = 0
const SLUG = 'fin-tdss-'

interface Books {
  id: string
  admin: Actor
  clerk: Actor
}

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Statement College', allowedEmailDomains: [`${tag}.test`] })
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
  await updateSettings(b.admin, { stateCode: '29', tan: 'AAAA12345A', pan: 'AAAAA1234A', legalName: 'Statement College' })
  return b
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

const DEDUCTOR = {
  deductorType: 'K',
  address1: '12 College Road',
  address4: 'Indiranagar',
  address5: 'Bengaluru',
  stateCode: '15',
  pincode: '560038',
  email: 'accounts@college.example',
  phone: '8012345678',
  responsibleName: 'Meera Rao',
  responsibleDesignation: 'Finance Officer',
  responsiblePan: 'ABCPR1234K',
  responsibleAddress1: '12 College Road',
  responsibleStateCode: '15',
  responsiblePincode: '560038',
  responsibleEmail: 'meera@college.example',
  responsiblePhone: '9812345678',
}

const sectionId = (b: Books, code: string) =>
  withTenant(b.id, async (tx) => {
    const r = await tx.execute(sql`select id, return_code, nr_return_code from finance_tds_sections where code = ${code}`)
    return r.rows[0] as { id: string; return_code: string | null; nr_return_code: string | null }
  })

test("the deductor's details are stored and read back (ACC-31)", async () => {
  const b = await books()
  await saveTdsDeductor(b.admin, DEDUCTOR)
  const got = await tdsDeductor(b.clerk)
  assert.equal(got?.deductorType, 'K')
  assert.equal(got?.stateCode, '15')
  assert.equal(got?.responsiblePan, 'ABCPR1234K')
  assert.equal(got?.phoneCountry, '91')
  await assert.rejects(saveTdsDeductor(b.clerk, DEDUCTOR), (e: unknown) => e instanceof FinanceError && e.status === 403)
  await refused(saveTdsDeductor(b.admin, { ...DEDUCTOR, stateCode: '99' }), 'bad_deductor', 400)
})

test('a return code must be a code of the form (ACC-31)', async () => {
  const b = await books()
  const s = await sectionId(b, 'CONTRACT')
  await setReturnCodes(b.admin, { sectionId: s.id, returnCode: '1023' })
  assert.equal((await sectionId(b, 'CONTRACT')).return_code, '1023')
  await refused(setReturnCodes(b.admin, { sectionId: s.id, returnCode: '1099' }), 'bad_return_code', 400)
  await setReturnCodes(b.admin, { sectionId: s.id, nrReturnCode: '1057' })
  assert.equal((await sectionId(b, 'CONTRACT')).nr_return_code, '1057')
  await refused(setReturnCodes(b.admin, { sectionId: s.id, nrReturnCode: '1023' }), 'bad_return_code', 400)
  await setReturnCodes(b.admin, { sectionId: s.id, returnCode: '' })
  assert.equal((await sectionId(b, 'CONTRACT')).return_code, null)
  await assert.rejects(setReturnCodes(b.clerk, { sectionId: s.id, returnCode: '1024' }), (e: unknown) => e instanceof FinanceError && e.status === 403)
})

test('the starters carry the codes the annexure states (ACC-31)', async () => {
  const b = await books()
  assert.equal((await sectionId(b, 'CONTRACT-IND')).return_code, '1023')
  assert.equal((await sectionId(b, 'CONTRACT')).return_code, '1024')
  assert.equal((await sectionId(b, 'PROF')).return_code, '1027')
  assert.equal((await sectionId(b, 'TECH')).return_code, '1026')
  assert.equal((await sectionId(b, 'COMM')).return_code, '1006')
  assert.equal((await sectionId(b, 'RENT-LB')).return_code, null)
  assert.equal((await sectionId(b, 'RENT-PM')).return_code, null)
})

// --- the Form 140 file -------------------------------------------------------------

const fields = (line: string) => line.split('^')

/** A section with no thresholds, its return code set. */
async function section(b: Books, code: string, rate: string, noPan: string, returnCode?: string, nrReturnCode?: string) {
  const s = (await createTdsSection(b.admin, { code, name: code, ratePercent: rate, rateNoPanPercent: noPan, thresholdSingle: '0', thresholdAnnual: '0' })) as { id: string }
  await setReturnCodes(b.admin, { sectionId: s.id, ...(returnCode && { returnCode }), ...(nrReturnCode && { nrReturnCode }) })
  return s.id
}

async function billOf(b: Books, partyId: string, date: string, rupees: string) {
  const bill = (await saveInvoice(b.clerk, { kind: 'purchase', partyId, postingDate: date, billNo: `ST-${++n}`, lines: [{ description: 'Work', qty: '1', rate: rupees }] })) as { id: string }
  await submitInvoice(b.admin, { invoiceId: bill.id })
  return bill.id
}

/** Two residents' bills in July 2026 and one challan for both. */
async function quarterTwo() {
  const b = await books()
  await saveTdsDeductor(b.admin, DEDUCTOR)
  const contract = await section(b, 'C1', '1', '20', '1023')
  const prof = await section(b, 'P1', '10', '20', '1027')
  const ravi = (await createParty(b.clerk, { code: `R${++n}`, name: 'Ravi Kumar', isSupplier: true, stateCode: '29', pan: 'ABCPK1234D', tdsSectionId: contract })).id
  const asha = (await createParty(b.clerk, { code: `A${++n}`, name: 'Asha Works', isSupplier: true, stateCode: '29', tdsSectionId: prof })).id
  await billOf(b, ravi, '2026-07-10', '100000')
  await billOf(b, asha, '2026-07-20', '50000')
  const bank = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))
  await recordChallan(b.admin, { form: '26Q', month: '2026-07', depositedOn: '2026-08-05', bsrCode: '0510308', challanSerial: '00042', accountId: bank })
  return { b, prof, ravi, bank }
}

test('the Form 140 file follows the published layout (ACC-31)', async () => {
  const { b } = await quarterTwo()
  const f = await tdsStatementFile(b.admin, { fy: 2026, quarter: 2, form: '26Q' })
  assert.equal(f.fileName, 'AAAA12345A_140_Q2_202627.txt')
  assert.ok(f.bytes.endsWith('\r\n'))
  assert.ok(!/[^\r]\n/.test(f.bytes), 'every line ends CR LF')
  assert.ok([...f.bytes].every((c) => c.charCodeAt(0) < 128), 'ASCII only')
  const lines = f.bytes.split('\r\n').slice(0, -1)
  assert.deepEqual(lines.map((l) => fields(l)[1]), ['FH', 'BH', 'CD', 'DD', 'DD'])
  assert.deepEqual(lines.map((l) => fields(l).length), [18, 72, 30, 45, 45])
  const [fh, bh, cd, dd1, dd2] = lines.map(fields) as string[][]
  assert.deepEqual([fh![0], fh![1], fh![2], fh![3], fh![5], fh![6], fh![7], fh![8], fh![9]], ['1', 'FH', 'NS1', 'R', '1', 'D', 'AAAA12345A', '1', 'CampusOS'])
  assert.ok(fh!.slice(10).every((v) => v === ''))
  assert.deepEqual([bh![1], bh![2], bh![3], bh![4], bh![12], bh![14], bh![15], bh![16], bh![17], bh![46], bh![51]], ['BH', '1', '1', '140', 'AAAA12345A', 'AAAAA1234A', '202728', '202627', 'Q2', '11000.00', 'N'])
  assert.deepEqual(
    [cd![1], cd![3], cd![4], cd![5], cd![7], cd![8], cd![9], cd![10], cd![11], cd![12], cd![14], cd![16], cd![18], cd![20], cd![21], cd![22], cd![23], cd![24]],
    ['CD', '1', '2', 'N', '11000.00', '0.00', '0.00', '0.00', '11000.00', 'C', '0510308', '00042', '05082026', '11000.00', '11000.00', '200', '0.00', '0.00'],
  )
  assert.deepEqual(
    [dd1![1], dd1![3], dd1![4], dd1![5], dd1![7], dd1![8], dd1![14], dd1![17], dd1![18], dd1![19], dd1![23], dd1![24], dd1![26], dd1![27]],
    ['DD', '1', '1', 'O', 'ABCPK1234D', 'Ravi Kumar', '1023', 'Y', '10072026', '100000.00', '1000.00', '1000.00', '10072026', '1.0000'],
  )
  assert.deepEqual([dd2![7], dd2![8], dd2![14], dd2![23], dd2![27]], ['PANNOTAVBL', 'Asha Works', '1027', '10000.00', '20.0000'])
})

test('the Form 140 file is refused when it cannot be complete (ACC-31)', async () => {
  const { b, prof, ravi } = await quarterTwo()
  await refused(tdsStatementFile(b.admin, { fy: 2025, quarter: 2, form: '26Q' }), 'old_form_statement', 400)
  await assert.rejects(tdsStatementFile(b.clerk, { fy: 2026, quarter: 2, form: '26Q' }), (e: unknown) => e instanceof FinanceError && e.status === 403)
  await setReturnCodes(b.admin, { sectionId: prof, returnCode: '' })
  await refused(tdsStatementFile(b.admin, { fy: 2026, quarter: 2, form: '26Q' }), 'no_return_code', 409)
  await setReturnCodes(b.admin, { sectionId: prof, returnCode: '1027' })
  await billOf(b, ravi, '2026-08-10', '20000')
  await refused(tdsStatementFile(b.admin, { fy: 2026, quarter: 2, form: '26Q' }), 'undeposited', 409)
  const empty = await books()
  await refused(tdsStatementFile(empty.admin, { fy: 2026, quarter: 2, form: '26Q' }), 'deductor_incomplete', 409)
})

// --- the Form 144 file -------------------------------------------------------------

test('the Form 144 file carries the non-resident fields (ACC-31)', async () => {
  const b = await books()
  await saveTdsDeductor(b.admin, DEDUCTOR)
  const nr = await section(b, 'NRTECH', '20', '20', undefined, '1057')
  await setReturnCodes(b.admin, { sectionId: nr, nrRemittance: '21' })
  const globex = (await createParty(b.clerk, { code: `G${++n}`, name: 'Globex Ltd', isSupplier: true, gstCategory: 'overseas', pan: 'AABCG1234Q', tdsSectionId: nr, email: 'ap@globex.example' })).id
  await billOf(b, globex, '2026-08-12', '200000')
  const bank = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))
  await recordChallan(b.admin, { form: '27Q', month: '2026-08', depositedOn: '2026-09-04', bsrCode: '0510308', challanSerial: '00077', accountId: bank })

  await refused(tdsStatementFile(b.admin, { fy: 2026, quarter: 2, form: '27Q' }), 'party_incomplete', 409)
  await updateParty(b.clerk, { partyId: globex, isSupplier: true, tdsStatus: '1', countryCode: '267', foreignTaxId: '12-3456789', foreignAddress: '1 Main Street, Springfield' })

  const f = await tdsStatementFile(b.admin, { fy: 2026, quarter: 2, form: '27Q' })
  assert.equal(f.fileName, 'AAAA12345A_144_Q2_202627.txt')
  const lines = f.bytes.split('\r\n').slice(0, -1).map(fields)
  assert.deepEqual(lines.map((l) => l.length), [18, 72, 30, 45])
  const [, bh, cd, dd] = lines as string[][]
  assert.equal(bh![4], '144')
  assert.deepEqual([cd![7], cd![11]], ['40000.00', '40000.00'])
  assert.deepEqual(
    [dd![7], dd![11], dd![13], dd![14], dd![15], dd![16], dd![19], dd![20], dd![23], dd![27], dd![29], dd![36], dd![37], dd![40]],
    ['AABCG1234Q', '1', 'N', '1057', '21', '267', '200000.00', 'N', '40000.00', '20.0000', 'A', '1 Main Street, Springfield', 'ap@globex.example', '12-3456789'],
  )
  await refused(setReturnCodes(b.admin, { sectionId: nr, nrRemittance: '71' }), 'bad_remittance', 400)
})
