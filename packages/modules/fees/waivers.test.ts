import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, inArray, sql } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { createFeeItem, grantWaiver, issueInvoices, revokeWaiver, type Actor } from './api'

/**
 * ACC-22: a waiver names a charge the student actually has.
 *
 * A waiver used to accept any fee item and, once the student had any invoice
 * for the term, post waiver expense and a receivable credit for a charge they
 * were never billed. It must name an item of a programme the student is
 * enrolled in for that term (decision 190).
 */

const SLUG = 'fees-waivers'
let inst = ''
const ids = { adm: '', s1: '', s2: '' }
const item = { bt: '', mt: '' }
let termId = ''

const adm = (): Actor => ({ id: ids.adm, role: 'institution_admin', institutionId: inst, email: null })
const code = (e: unknown) => (e as { code?: string }).code

async function trail() {
  const r = await authDb.execute<{ waivers: number; entries: number; audits: number }>(sql`
    select
      (select count(*)::int from fee_waivers where institution_id = ${inst}) as waivers,
      (select count(*)::int from finance_journal_entries
        where institution_id = ${inst} and source_module = 'fees' and source_ref like 'waiver:%') as entries,
      (select count(*)::int from audit_log
        where institution_id = ${inst} and action in ('fee.waiver_granted', 'fee.waiver_revised')) as audits`)
  return r.rows[0]!
}

before(async () => {
  await authDb.delete(institutions).where(inArray(institutions.slug, [SLUG]))
  const [row] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Waiver College', allowedEmailDomains: ['waivers.test'] })
    .returning({ id: institutions.id })
  inst = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@waivers.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 's1@waivers.test', institutionId: inst, role: 'student', name: 'One' },
      { email: 's2@waivers.test', institutionId: inst, role: 'student', name: 'Two' },
    ])
    .returning({ id: users.id })
  ids.adm = people[0]!.id
  ids.s1 = people[1]!.id
  ids.s2 = people[2]!.id

  const dept = await academic.createDepartment(adm(), { code: 'gen', name: 'General' })
  const bt = await academic.createProgram(adm(), { departmentId: dept.id, code: 'BT', name: 'BTech', level: 'undergraduate', durationTerms: 8 })
  const mt = await academic.createProgram(adm(), { departmentId: dept.id, code: 'MT', name: 'MTech', level: 'postgraduate', durationTerms: 4 })
  termId = (await academic.createTerm(adm(), { code: 'AUT26', name: 'Autumn', startsOn: '2026-07-01', endsOn: '2026-12-01' })).id
  const section = await academic.createSection(adm(), { programId: bt.id, label: 'a', admissionYear: 2025 })
  for (const s of [ids.s1, ids.s2]) await academic.addSectionMember(adm(), { sectionId: section.id, userId: s })
  await academic.declareProgram(adm(), { studentId: ids.s1, programId: bt.id, declaredOn: '2025-07-01' })
  const left = await academic.declareProgram(adm(), { studentId: ids.s2, programId: bt.id, declaredOn: '2025-07-01' })
  await academic.endStudentProgram(adm(), { studentProgramId: left.id, status: 'withdrawn', endedOn: '2026-03-01' })

  item.bt = (await createFeeItem(adm(), { programId: bt.id, termId, label: 'Tuition', amount: '45000' })).id
  item.mt = (await createFeeItem(adm(), { programId: mt.id, termId, label: 'Tuition', amount: '60000' })).id
  await issueInvoices(adm(), { termId })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('a waiver on another programme’s charge is refused, and nothing is posted or audited', async () => {
  const before = await trail()
  await assert.rejects(
    () => grantWaiver(adm(), { studentId: ids.s1, feeItemId: item.mt, amount: '5000', reason: 'not their charge' }),
    (e: unknown) => code(e) === 'item_not_charged' && (e as { status: number }).status === 400,
  )
  assert.deepEqual(await trail(), before)
})

test('a waiver on a student not enrolled that term is refused', async () => {
  await assert.rejects(
    () => grantWaiver(adm(), { studentId: ids.s2, feeItemId: item.bt, amount: '5000', reason: 'left in March' }),
    (e: unknown) => code(e) === 'item_not_charged',
  )
})

test('a waiver on the student’s own programme’s charge is granted and posted', async () => {
  const before = await trail()
  const w = await grantWaiver(adm(), { studentId: ids.s1, feeItemId: item.bt, amount: '5000', reason: 'merit concession' })
  assert.ok(w.id)
  const now = await trail()
  assert.equal(now.waivers - before.waivers, 1)
  assert.equal(now.entries - before.entries, 1)
  assert.equal(now.audits - before.audits, 1)
})

test('a waiver already on file for a foreign charge can still be revoked', async () => {
  // As the old code allowed: written past the check, as the owner.
  const r = await authDb.execute<{ id: string }>(sql`
    insert into fee_waivers (institution_id, student_id, fee_item_id, amount_paise, reason, granted_by)
    values (${inst}, ${ids.s2}, ${item.mt}, 100000, 'granted before the check', ${ids.adm}) returning id`)
  await revokeWaiver(adm(), { waiverId: r.rows[0]!.id, reason: 'never their charge (ACC-22)' })
  const left = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from fee_waivers where id = ${r.rows[0]!.id}`)
  assert.equal(left.rows[0]!.n, 0)
})
