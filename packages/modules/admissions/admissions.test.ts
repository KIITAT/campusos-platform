import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { auditLog, authDb, users, withTenant } from '@campusos/db'
import { createDepartment, createProgram, createTerm } from '@campusos/module-academic/api'
import { studentPrograms } from '@campusos/module-academic/schema'
import { college } from './test-support.test'
import { acceptApplication, addEnquiry, apply, decide, listApplications, listEnquiries } from './api'
import { applications, enquiries } from './schema'

test('admissions RLS and tenant composites protect stored links and successful writes are audited', async () => {
  const actors = await setup()
  const other = await setup()
  const enquiry = await addEnquiry(actors.admin, { name: 'Applicant', email: 'applicant@example.test' })
  assert.deepEqual(await withTenant(other.id, transaction => transaction.select().from(enquiries)), [])
  await assert.rejects(() => withTenant(other.id, transaction => transaction.insert(enquiries).values({ institutionId: actors.id, name: 'Wrong tenant', email: 'wrong@example.test' })))
  await assert.rejects(() => withTenant(other.id, transaction => transaction.insert(applications).values({ institutionId: other.id, enquiryId: enquiry.id, programId: other.program.id, termId: other.term.id })))
  const application = await apply(actors.admin, { enquiryId: enquiry.id, programId: actors.program.id, termId: actors.term.id })
  await decide(actors.admin, { applicationId: application.id, decision: 'offer', reason: 'Eligible applicant' })
  await authDb.update(users).set({ erasedAt: new Date() }).where(eq(users.id, actors.other.id))
  await assert.rejects(() => acceptApplication(actors.admin, { applicationId: application.id, studentId: actors.other.id }))
  await acceptApplication(actors.admin, { applicationId: application.id, studentId: actors.student.id })
  const trail = await withTenant(actors.id, transaction => transaction.select().from(auditLog).where(eq(auditLog.moduleId, 'admissions')))
  assert.deepEqual(trail.map(row => row.action).sort(), ['enquiry.created', 'application.submitted', 'application.offered', 'application.accepted'].sort())
})

async function setup() {
  const actors = await college()
  const department = await createDepartment(actors.admin, { code: 'SCI', name: 'Science' })
  const program = await createProgram(actors.admin, { departmentId: department.id, code: 'BSC', name: 'Science', level: 'undergraduate', durationTerms: 6 })
  const term = await createTerm(actors.admin, { code: '2026', name: '2026 intake', startsOn: '2026-07-01', endsOn: '2027-06-30' })
  return { ...actors, program, term }
}

test('enquiry converts to an application, offer and atomic academic acceptance', async () => {
  const actors = await setup()
  const enquiry = await addEnquiry(actors.admin, { name: 'Asha', email: 'asha@example.test', note: 'Science enquiry' })
  const application = await apply(actors.admin, { enquiryId: enquiry.id, programId: actors.program.id, termId: actors.term.id })
  await assert.rejects(() => acceptApplication(actors.admin, { applicationId: application.id, studentId: actors.student.id }))
  await decide(actors.admin, { applicationId: application.id, decision: 'offer', reason: 'Entry requirements met' })
  const results = await Promise.allSettled([1, 2].map(() => acceptApplication(actors.admin, { applicationId: application.id, studentId: actors.student.id })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const enrollment = await withTenant(actors.id, transaction => transaction.select().from(studentPrograms).where(eq(studentPrograms.studentId, actors.student.id)))
  assert.equal(enrollment.length, 1)
  assert.equal(enrollment[0]!.programId, actors.program.id)
  assert.equal((await listApplications(actors.admin))[0]!.status, 'accepted')
  await assert.rejects(() => decide(actors.admin, { applicationId: application.id, decision: 'reject', reason: 'Too late' }))
})

test('admissions require office authority and reject cross-institution identity links', async () => {
  const actors = await setup()
  const other = await setup()
  await assert.rejects(() => addEnquiry(actors.student, { name: 'Unauthorized', email: 'bad@example.test' }))
  const enquiry = await addEnquiry(actors.admin, { name: 'Applicant', email: 'applicant@example.test' })
  await assert.rejects(() => apply(actors.admin, { enquiryId: enquiry.id, programId: other.program.id, termId: actors.term.id }))
  assert.deepEqual(await listEnquiries(other.admin), [])
  const application = await apply(actors.admin, { enquiryId: enquiry.id, programId: actors.program.id, termId: actors.term.id })
  await decide(actors.admin, { applicationId: application.id, decision: 'offer', reason: 'Eligible' })
  await assert.rejects(() => acceptApplication(actors.admin, { applicationId: application.id, studentId: other.student.id }))
  await decide(actors.admin, { applicationId: application.id, decision: 'withdraw', reason: 'Applicant withdrew' })
  assert.equal((await listApplications(actors.admin))[0]!.status, 'withdrawn')
})
