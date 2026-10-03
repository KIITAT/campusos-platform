import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { trialBalance, type Actor as Books } from '@campusos/module-finance/api'
import {
  FeeError,
  cancelChargeForSourceWithin,
  cancelStudentCharge,
  chargeStudent,
  chargeStudentWithin,
  createFeeItem,
  issueInvoices,
  listStudentCharges,
  studentLedger,
  type Actor,
} from './api'

/**
 * A charge on one student -- a backlog paper -- billed with everything else,
 * and cancellable only until the books have it.
 */

let n = 0
const SLUG = 'fees-charge-'

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Charge College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'One Student' },
      { email: `f@${tag}.test`, institutionId: id, role: 'faculty', name: 'Fac' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const clerk: Actor = { id: people[1]!.id, email: `clerk@${tag}.test`, role: 'accounts_staff', institutionId: id }
  const faculty: Actor = { id: people[3]!.id, role: 'faculty', institutionId: id }
  const dept = await academic.createDepartment(admin, { code: 'cse', name: 'CSE' })
  const program = await academic.createProgram(admin, {
    departmentId: dept.id, code: 'btech', name: 'BTech', level: 'undergraduate', durationTerms: 8,
  })
  const term = await academic.createTerm(admin, { code: 't1', name: 'Sem 1', startsOn: '2026-01-05', endsOn: '2026-05-30' })
  const section = await academic.createSection(admin, { programId: program.id, label: 'a', admissionYear: 2026 })
  await academic.addSectionMember(admin, { sectionId: section.id, userId: people[2]!.id })
  await createFeeItem(admin, { programId: program.id, termId: term.id, label: 'Tuition', amount: '45000' })
  return { id, admin, clerk, faculty, studentId: people[2]!.id, facultyId: people[3]!.id, termId: term.id }
}

const code = (e: unknown) => (e as FeeError).code

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('a charge on one student is billed with the rest, and fixed once it is', async () => {
  const c = await campus()
  const ch = await chargeStudent(c.clerk, { studentId: c.studentId, termId: c.termId, label: 'Backlog paper: CS101', amount: '1,500' })

  const l = await studentLedger(c.clerk, c.studentId, c.termId)
  assert.deepEqual(l.lines.map((x) => [x.label, x.chargedPaise]), [['Tuition', 4_500_000], ['Backlog paper: CS101', 150_000]])
  assert.equal(l.outstandingPaise, 4_650_000)
  assert.equal(l.lines[1]!.feeItemId, null)

  await issueInvoices(c.admin, { termId: c.termId })
  const tb = await trialBalance(c.admin as unknown as Books)
  assert.equal(tb.rows.find((r) => r.code === '1100')?.balancePaise, 4_650_000, 'the books have both')
  assert.equal((await listStudentCharges(c.clerk, c.termId))[0]!.state, 'invoiced')

  await assert.rejects(
    cancelStudentCharge(c.clerk, { chargeId: ch.id, reason: 'booked in error' }),
    (e) => code(e) === 'fee_student_charge_invoiced',
  )

  // One raised after the invoice is billed on the next run, as a supplementary.
  await chargeStudent(c.clerk, { studentId: c.studentId, termId: c.termId, label: 'Duplicate admit card', amount: '200' })
  const again = await issueInvoices(c.admin, { termId: c.termId })
  assert.equal(again.issued[0]!.chargedPaise, 20_000)
})

test('until it is invoiced a charge can be cancelled, with a reason; only by the module that raised it', async () => {
  const c = await campus()
  const ch = await chargeStudent(c.clerk, { studentId: c.studentId, termId: c.termId, label: 'Duplicate ID card', amount: '300' })
  await assert.rejects(cancelStudentCharge(c.clerk, { chargeId: ch.id, reason: 'no' }), /too_small|>=5/)
  await cancelStudentCharge(c.clerk, { chargeId: ch.id, reason: 'the card was found' })
  const l = await studentLedger(c.clerk, c.studentId, c.termId)
  assert.equal(l.lines.length, 1, 'only tuition is left')

  // Another module raises one inside its own transaction, once per record.
  await withTenant(c.id, (tx) =>
    chargeStudentWithin(tx, c.id, c.admin.id, {
      studentId: c.studentId, termId: c.termId, label: 'Backlog: MA101', amountPaise: 100_000,
      sourceModule: 'examinations', sourceId: 'booking-1',
    }),
  )
  await assert.rejects(
    withTenant(c.id, (tx) =>
      chargeStudentWithin(tx, c.id, c.admin.id, {
        studentId: c.studentId, termId: c.termId, label: 'Backlog: MA101', amountPaise: 100_000,
        sourceModule: 'examinations', sourceId: 'booking-1',
      }),
    ),
    (e) => code(e) === 'fee_student_charges_source',
  )
  const theirs = (await listStudentCharges(c.clerk)).find((x) => x.sourceModule === 'examinations')!
  await assert.rejects(cancelStudentCharge(c.clerk, { chargeId: theirs.id, reason: 'not ours to cancel' }), (e) => code(e) === 'not_ours')
  assert.equal(await withTenant(c.id, (tx) => cancelChargeForSourceWithin(tx, 'examinations', 'booking-1', 'booking withdrawn')), 1)

  // Who may charge, and whom.
  await assert.rejects(
    chargeStudent(c.faculty, { studentId: c.studentId, termId: c.termId, label: 'A fine', amount: '10' }),
    (e) => code(e) === 'forbidden',
  )
  await assert.rejects(
    chargeStudent(c.clerk, { studentId: c.facultyId, termId: c.termId, label: 'Staff canteen', amount: '10' }),
    (e) => code(e) === 'fee_student_charge_student',
  )
})
