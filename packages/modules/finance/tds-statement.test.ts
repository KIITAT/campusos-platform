import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import {
  FinanceError,
  loadIndiaPreset,
  saveTdsDeductor,
  setReturnCodes,
  tdsDeductor,
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
