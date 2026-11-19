import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { authDb, institutionModules, withTenant } from '@campusos/db'
import { createDepartment, createProgram, createSection, createTerm, setStudentProfile } from '@campusos/module-academic/api'
import { createFeeItem, reconciliation } from '@campusos/module-fees/api'
import { college } from './test-support.test'
import { acceptApplication, addEnquiry, apply, decide, listApplications, type Actor } from './api'

/**
 * P1-12a: an accepted applicant becomes an enrolled, invoiced student
 * (FUNC-04, FUNC-02 admission half, FUNC-09). Acceptance creates or reuses
 * the student's account, invites a new one to sign in, issues a roll number,
 * seats the student in a section and, when Fees is on, invoices the term,
 * all in one transaction.
 */

type Accepted = { id: string; status: string; studentId: string; rollNo: string; invoiceId: string | null; link: string | null; notice: string }
type Row = Record<string, unknown>

async function setup() {
  const actors = await college()
  const department = await createDepartment(actors.admin, { code: 'SCI', name: 'Science' })
  const bsc = await createProgram(actors.admin, { departmentId: department.id, code: 'BSC', name: 'Science', level: 'undergraduate', durationTerms: 6 })
  const msc = await createProgram(actors.admin, { departmentId: department.id, code: 'MSC', name: 'Science (PG)', level: 'postgraduate', durationTerms: 4 })
  const term = await createTerm(actors.admin, { code: '2026', name: '2026 intake', startsOn: '2026-07-01', endsOn: '2027-06-30' })
  const section = await createSection(actors.admin, { programId: bsc.id, label: 'A', admissionYear: 2026 })
  const mscSection = await createSection(actors.admin, { programId: msc.id, label: 'B', admissionYear: 2026 })
  return { ...actors, bsc, msc, term, section, mscSection }
}
type Setup = Awaited<ReturnType<typeof setup>>

async function offered(actors: Setup, extra: Record<string, unknown> = {}) {
  const enquiry = await addEnquiry(actors.admin, { name: 'Asha Rao', email: `asha.${randomUUID().slice(0, 8)}@example.test` })
  const application = await apply(actors.admin, { enquiryId: enquiry.id, programId: actors.bsc.id, termId: actors.term.id, ...extra })
  await decide(actors.admin, { applicationId: application.id, decision: 'offer', reason: 'Entry requirements met' })
  return { application, enquiry }
}

const accept = async (actor: Actor, input: Record<string, unknown>) => (await acceptApplication(actor, input)) as unknown as Accepted
const rows = (institutionId: string, query: ReturnType<typeof sql>) => withTenant(institutionId, async (tx) => (await tx.execute(query)).rows as Row[])
const enableFees = (institutionId: string) =>
  authDb
    .insert(institutionModules)
    .values({ institutionId, moduleId: 'fees', enabled: true })
    .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled: true } })
const code = (e: unknown) => (e as { code?: string }).code

test('acceptance creates the student account, a sign-in invitation, a roll number, the section seat and the profile (FUNC-04, FUNC-02)', async () => {
  const actors = await setup()
  const { application } = await offered(actors, { applicantName: 'Asha Rao', applicantEmail: 'asha.own@example.test', dateOfBirth: '2007-03-14', category: 'sc' })
  const result = await accept(actors.admin, { applicationId: application.id, sectionId: actors.section.id })

  const [user] = await rows(actors.id, sql`select id, role, institution_id, name, date_of_birth::text as dob from users where email = 'asha.own@example.test'`)
  assert.ok(user)
  assert.equal(user.role, 'student')
  assert.equal(user.institution_id, actors.id)
  assert.equal(user.name, 'Asha Rao')
  assert.equal(user.dob, '2007-03-14')
  assert.equal(result.studentId, user.id)
  assert.equal(result.rollNo, '2026BSC0001')

  const seat = await rows(actors.id, sql`select 1 from academic_section_members where section_id = ${actors.section.id} and user_id = ${result.studentId}`)
  assert.equal(seat.length, 1)
  const [profile] = await rows(actors.id, sql`select roll_no, category from academic_student_profiles where student_id = ${result.studentId}`)
  assert.deepEqual(profile, { roll_no: '2026BSC0001', category: 'sc' })

  const [invitation] = await rows(actors.id, sql`select role, accepted_at, revoked_at, extract(epoch from expires_at - now())::int as left from invitations where email = 'asha.own@example.test'`)
  assert.ok(invitation)
  assert.equal(invitation.role, 'student')
  assert.equal(invitation.accepted_at, null)
  assert.equal(invitation.revoked_at, null)
  assert.ok(Math.abs(Number(invitation.left) - 30 * 86_400) < 60)
  assert.match(result.link ?? '', /^\/invite\/[A-Za-z0-9_-]{43}$/)
  assert.equal(
    result.notice,
    'Asha Rao is enrolled as 2026BSC0001 in BSC section A. Send the student this sign-in invitation link, valid for 30 days. It is shown only now.',
  )

  const trail = await rows(actors.id, sql`select action, entity, entity_id, detail::text as detail from audit_log where module_id = 'admissions'`)
  const created = trail.find((r) => r.action === 'application.account_created')
  assert.ok(created)
  assert.equal(created.entity, 'users')
  assert.equal(created.entity_id, result.studentId)
  const invited = trail.find((r) => r.action === 'application.student_invited')
  assert.ok(invited)
  for (const r of [created, invited]) assert.ok(!String(r.detail ?? '').includes('asha.own@example.test'))
})

test('without an applicant address the enquiry\'s address and name are used', async () => {
  const actors = await setup()
  const { application, enquiry } = await offered(actors)
  const result = await accept(actors.admin, { applicationId: application.id, sectionId: actors.section.id })
  const [user] = await rows(actors.id, sql`select id, name from users where email = ${enquiry.email}`)
  assert.ok(user)
  assert.equal(user.id, result.studentId)
  assert.equal(user.name, 'Asha Rao')
})

test('an applicant who is already a student here is reused, keeps an existing roll and gains the seat', async () => {
  const actors = await setup()
  await setStudentProfile(actors.admin, { studentId: actors.student.id, rollNo: 'OLD-1' })
  const { application } = await offered(actors, { applicantEmail: actors.student.email })
  const result = await accept(actors.admin, { applicationId: application.id, sectionId: actors.section.id })
  assert.equal(result.studentId, actors.student.id)
  assert.equal(result.rollNo, 'OLD-1')
  assert.equal(result.link, null)
  const users = await rows(actors.id, sql`select id from users where lower(email) = lower(${actors.student.email})`)
  assert.equal(users.length, 1)
  const seat = await rows(actors.id, sql`select 1 from academic_section_members where section_id = ${actors.section.id} and user_id = ${actors.student.id}`)
  assert.equal(seat.length, 1)
})

test('acceptance refuses a section of another programme, an address of another role or institution', async () => {
  const actors = await setup()
  const elsewhere = await college()
  const before = await rows(actors.id, sql`select count(*)::int as n from users`)
  const cases: [Record<string, unknown>, string, string][] = [
    [{}, actors.mscSection.id, 'section_not_in_programme'],
    [{ applicantEmail: actors.faculty.email }, actors.section.id, 'member_address'],
    [{ applicantEmail: elsewhere.student.email }, actors.section.id, 'address_taken'],
  ]
  for (const [extra, sectionId, expected] of cases) {
    const { application } = await offered(actors, extra)
    await assert.rejects(accept(actors.admin, { applicationId: application.id, sectionId }), (e) => code(e) === expected)
    const [row] = await rows(actors.id, sql`select status from admissions_applications where id = ${application.id}`)
    assert.equal(row!.status, 'offered')
  }
  assert.deepEqual(await rows(actors.id, sql`select count(*)::int as n from users`), before)
})

test('two acceptances in one programme and year take consecutive roll numbers (forced interleaving)', async () => {
  const actors = await setup()
  const first = await offered(actors)
  assert.equal((await accept(actors.admin, { applicationId: first.application.id, sectionId: actors.section.id })).rollNo, '2026BSC0001')
  const a = await offered(actors, { applicantEmail: `a.${randomUUID().slice(0, 8)}@example.test` })
  const b = await offered(actors, { applicantEmail: `b.${randomUUID().slice(0, 8)}@example.test` })

  let release!: () => void
  const released = new Promise<void>((r) => (release = r))
  let locked!: () => void
  const holding = new Promise<void>((r) => (locked = r))
  const holder = authDb.transaction(async (tx) => {
    await tx.execute(sql`select last_value from admissions_roll_counters where institution_id = ${actors.id} for update`)
    locked()
    await released
  })
  await holding
  const both = Promise.all([a, b].map((x) => accept(actors.admin, { applicationId: x.application.id, sectionId: actors.section.id })))
  both.catch(() => {})
  try {
    const deadline = Date.now() + 10_000
    for (;;) {
      const r = await authDb.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%admissions_roll_counters%'`,
      )
      if (r.rows[0]!.n >= 2) break
      if (Date.now() > deadline) throw new Error('the two acceptances never waited on the counter row')
      await new Promise((r) => setTimeout(r, 50))
    }
  } finally {
    release()
    await holder
  }
  const results = await both
  assert.deepEqual(results.map((r) => r.rollNo).sort(), ['2026BSC0002', '2026BSC0003'])
})

test('a roll number already typed by hand is skipped', async () => {
  const actors = await setup()
  await setStudentProfile(actors.admin, { studentId: actors.other.id, rollNo: '2026BSC0001' })
  const { application } = await offered(actors)
  assert.equal((await accept(actors.admin, { applicationId: application.id, sectionId: actors.section.id })).rollNo, '2026BSC0002')
})

test('roll counters are kept per institution (RLS)', async () => {
  const actors = await setup()
  const other = await college()
  const { application } = await offered(actors)
  await accept(actors.admin, { applicationId: application.id, sectionId: actors.section.id })
  assert.equal((await rows(actors.id, sql`select * from admissions_roll_counters`)).length, 1)
  assert.deepEqual(await rows(other.id, sql`select * from admissions_roll_counters`), [])
  await assert.rejects(
    withTenant(other.id, (tx) =>
      tx.execute(sql`insert into admissions_roll_counters (institution_id, program_id, intake_year, last_value) values (${actors.id}, ${actors.bsc.id}, 2027, 1)`),
    ),
  )
})

test('with fees on, acceptance issues the term\'s invoice in the same transaction and the books agree (FUNC-04)', async () => {
  const actors = await setup()
  await enableFees(actors.id)
  await createFeeItem(actors.admin, { programId: actors.bsc.id, termId: actors.term.id, label: 'Tuition', amount: '50000' })
  const { application } = await offered(actors)
  const result = await accept(actors.admin, { applicationId: application.id, sectionId: actors.section.id })
  assert.ok(result.invoiceId)
  const [invoice] = await rows(actors.id, sql`select student_id, term_id, charged_paise::bigint as charged from fee_invoices where id = ${result.invoiceId}`)
  assert.ok(invoice)
  assert.equal(invoice.student_id, result.studentId)
  assert.equal(invoice.term_id, actors.term.id)
  assert.equal(Number(invoice.charged), 5_000_000)
  const posted = await rows(actors.id, sql`select 1 from finance_journal_entries where source_module = 'fees' and source_ref = ${'invoice:' + result.invoiceId + ':v1'}`)
  assert.equal(posted.length, 1)
  assert.equal((await reconciliation(actors.admin as never)).differencePaise, 0)
  assert.match(result.notice, /2026 fees of .*50,000.* invoiced\./)
})

test('with fees off, nothing is invoiced', async () => {
  const actors = await setup()
  await createFeeItem(actors.admin, { programId: actors.bsc.id, termId: actors.term.id, label: 'Tuition', amount: '50000' })
  const { application } = await offered(actors)
  const result = await accept(actors.admin, { applicationId: application.id, sectionId: actors.section.id })
  assert.ok(result.studentId)
  assert.equal(result.invoiceId, null)
  assert.deepEqual(await rows(actors.id, sql`select 1 from fee_invoices where student_id = ${result.studentId}`), [])
  assert.doesNotMatch(result.notice, /fees|invoice/i)
})

test('the application keeps the applicant\'s details, and a future date of birth is refused', async () => {
  const actors = await setup()
  const enquiry = await addEnquiry(actors.admin, { name: 'Parent Rao', email: `parent.${randomUUID().slice(0, 8)}@example.test` })
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const base = { enquiryId: enquiry.id, programId: actors.bsc.id, termId: actors.term.id }
  await assert.rejects(apply(actors.admin, { ...base, dateOfBirth: tomorrow }))
  await assert.rejects(apply(actors.admin, { ...base, category: 'other' }))
  await apply(actors.admin, { ...base, applicantName: 'Asha Rao', applicantEmail: 'Asha.Applicant@Example.test' })
  const [row] = await listApplications(actors.admin)
  assert.equal(row!.name, 'Asha Rao')
  assert.equal(row!.email, 'asha.applicant@example.test')
})
