/**
 * FUNC-09 and P1-08b D15: admission never depends on the APAAR ID or the
 * consent to it. A student whose guardian refused APAAR is admitted like any
 * other, and so is an applicant about whom nothing was recorded.
 *
 * Lives in scripts/ so that no file under packages/modules outside academic
 * names APAAR (scripts/apaar-isolation.test.mjs).
 *
 *   node --import ./packages/db/node_modules/tsx/dist/loader.mjs --test scripts/admission-apaar.test.ts
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, sql } from '../packages/db/node_modules/drizzle-orm/index.js'
import { authDb, institutions, recordGuardianConsent, users, withTenant } from '../packages/db/src/index'
import { createDepartment, createProgram, createSection, createTerm, studentProfile } from '../packages/modules/academic/api/index'
import { acceptApplication, addEnquiry, apply, decide } from '../packages/modules/admissions/api/index'

const SLUG = `admission-apaar-${randomUUID().slice(0, 8)}`
let inst = ''

after(async () => {
  if (inst) await authDb.delete(institutions).where(eq(institutions.id, inst))
})

test('a recorded APAAR refusal does not block admission (FUNC-09, P1-08b D15)', async () => {
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Admission APAAR College', allowedEmailDomains: [`${SLUG}.test`] }).returning({ id: institutions.id })
  inst = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${SLUG}.test`, institutionId: inst, role: 'institution_admin', name: 'Office' },
      { email: `kid@${SLUG}.test`, institutionId: inst, role: 'student', name: 'Kid' },
    ])
    .returning({ id: users.id })
  const [adminId, studentId] = people.map((p) => p.id) as [string, string]
  const admin = { id: adminId, role: 'institution_admin', institutionId: inst, email: `adm@${SLUG}.test` } as never
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`update users set date_of_birth = ((now() at time zone 'Asia/Kolkata')::date - interval '15 years')::date where id = ${studentId}`)
    await recordGuardianConsent(tx, {
      institutionId: inst, studentId, purpose: 'apaar', decision: 'refused', basis: 'office_record', guardianId: null, recordedBy: adminId, note: 'parent declined',
    })
  })

  const department = await createDepartment(admin, { code: 'SCI', name: 'Science' })
  const program = await createProgram(admin, { departmentId: department.id, code: 'BSC', name: 'Science', level: 'undergraduate', durationTerms: 6 })
  const term = await createTerm(admin, { code: '2026', name: '2026 intake', startsOn: '2026-07-01', endsOn: '2027-06-30' })
  const section = await createSection(admin, { programId: program.id, label: 'A', admissionYear: 2026 })
  const admit = async (email: string, studentId?: string) => {
    const enquiry = await addEnquiry(admin, { name: 'Applicant', email })
    const application = await apply(admin, { enquiryId: enquiry.id, programId: program.id, termId: term.id })
    await decide(admin, { applicationId: application.id, decision: 'offer', reason: 'Entry requirements met' })
    return (await acceptApplication(admin, { applicationId: application.id, sectionId: section.id, studentId })) as unknown as { status: string; studentId: string; rollNo: string }
  }

  const refused = await admit(`kid@${SLUG}.test`, studentId)
  assert.equal(refused.status, 'accepted')
  assert.equal(refused.rollNo, '2026BSC0001')
  assert.equal((await studentProfile(admin, studentId)).apaarId, null)

  // An applicant with no account and nothing recorded about APAAR.
  const fresh = await admit(`fresh@${SLUG}.test`)
  assert.equal(fresh.status, 'accepted')
  assert.equal(fresh.rollNo, '2026BSC0002')
})
