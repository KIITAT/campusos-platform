import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { courseCompletions, courses, departments, programs, studentPrograms } from '@campusos/module-academic/schema'
import * as placement from './api'
import { companies, applications, offers, officers } from './schema'
import { pages } from './pages'
import { routes } from './routes'
import type { Actor } from './api/core'

const tenants: string[] = []
after(async () => {
  for (const institutionId of tenants) await authDb.delete(institutions).where(eq(institutions.id, institutionId))
})

async function campus() {
  const slug = `placement-${randomUUID()}`
  const [institution] = await authDb.insert(institutions).values({ slug, name: 'Placement College', allowedEmailDomains: [`${slug}.test`] }).returning()
  const institutionId = institution!.id
  tenants.push(institutionId)
  const actors = await authDb.insert(users).values(['institution_admin', 'faculty', 'student', 'student'].map((role, position) => ({
    institutionId, role: role as Actor['role'], email: `${position}@${slug}.test`, name: `Person ${position}`,
  }))).returning()
  const [admin, teacher, student, other] = actors.map((actor) => ({ id: actor.id, institutionId, role: actor.role, email: actor.email })) as [Actor, Actor, Actor, Actor]
  const program = await withTenant(institutionId, async (tx) => {
    const [department] = await tx.insert(departments).values({ institutionId, code: 'CS', name: 'Computing' }).returning()
    const [program] = await tx.insert(programs).values({ institutionId, departmentId: department!.id, code: 'BTECH', name: 'Engineering', level: 'undergraduate', durationTerms: 8 }).returning()
    await tx.insert(studentPrograms).values([student, other].map((actor) => ({ institutionId, studentId: actor.id, programId: program!.id })))
    return program!
  })
  const company = await placement.createCompany(admin, { name: 'Campus Employer', website: 'https://employer.test' })
  const drive = await placement.createDrive(admin, { companyId: company.id, programId: program.id, title: 'Graduate Engineer', closesAt: '2099-01-01T00:00:00Z', minCgpa: 0, maxBacklogs: 0 })
  return { institutionId, admin, teacher, student, other, program, company, drive }
}

test('company to drive, application, selection rounds and student offer acceptance', async () => {
  const campusData = await campus()
  await placement.changeDrive(campusData.admin, { driveId: campusData.drive.id, status: 'open' })
  const application = await placement.apply(campusData.student, { driveId: campusData.drive.id })
  const round = await placement.createRound(campusData.admin, { driveId: campusData.drive.id, name: 'Interview' })
  await placement.recordResult(campusData.admin, { applicationId: application.id, roundId: round.id, outcome: 'passed', note: 'Panel approved.' })
  const offer = await placement.issueOffer(campusData.admin, { applicationId: application.id, annualPaise: 120000000 })
  await placement.respondOffer(campusData.student, { offerId: offer.id, decision: 'accepted' })
  assert.equal((await placement.workspace(campusData.student)).offers[0]!.status, 'accepted')
  const statistics = await placement.statistics(campusData.admin)
  assert.equal(statistics.accepted, 1)
  assert.equal(statistics.applications, 1)
})

test('faculty require appointment, students cannot administer and officers can be revoked', async () => {
  const campusData = await campus()
  await assert.rejects(placement.createCompany(campusData.teacher, { name: 'Denied' }), (error: unknown) => (error as { code: string }).code === 'forbidden')
  await placement.setOfficer(campusData.admin, { userId: campusData.teacher.id, active: true })
  await placement.createCompany(campusData.teacher, { name: 'Appointed' })
  await placement.setOfficer(campusData.admin, { userId: campusData.teacher.id, active: false })
  await assert.rejects(placement.statistics(campusData.teacher), /officer/i)
  await assert.rejects(placement.createDrive(campusData.student, {}), /role|officer/i)
})

test('administrators can revoke demoted or erased officers without granting them access', async () => {
  for (const change of [{ role: 'student' as const }, { erasedAt: new Date() }]) {
    const campusData = await campus()
    await placement.setOfficer(campusData.admin, { userId: campusData.teacher.id, active: true })
    await authDb.update(users).set(change).where(eq(users.id, campusData.teacher.id))
    await assert.rejects(placement.createCompany(campusData.teacher, { name: 'Stale officer' }), /officer|person/i)
    await placement.setOfficer(campusData.admin, { userId: campusData.teacher.id, active: false })
    const [appointment] = await withTenant(campusData.institutionId, (tx) => tx.select().from(officers).where(eq(officers.userId, campusData.teacher.id)))
    assert.equal(appointment!.active, false)
    await assert.rejects(placement.setOfficer(campusData.admin, { userId: campusData.teacher.id, active: true }), /staff|person/i)
  }
})

test('unpublished, closed, missing-grade and wrong-programme drives refuse applications', async () => {
  const campusData = await campus()
  await assert.rejects(placement.apply(campusData.student, { driveId: campusData.drive.id }), /open/i)
  await placement.changeDrive(campusData.admin, { driveId: campusData.drive.id, status: 'open' })
  await placement.changeDrive(campusData.admin, { driveId: campusData.drive.id, status: 'closed' })
  await assert.rejects(placement.apply(campusData.student, { driveId: campusData.drive.id }), /open/i)
  const graded = await placement.createDrive(campusData.admin, { companyId: campusData.company.id, programId: campusData.program.id, title: 'High grades', closesAt: '2099-01-01T00:00:00Z', minCgpa: 8 })
  await placement.changeDrive(campusData.admin, { driveId: graded.id, status: 'open' })
  await assert.rejects(placement.apply(campusData.student, { driveId: graded.id }), /grade/i)
  await withTenant(campusData.institutionId, (tx) => tx.update(studentPrograms).set({ status: 'withdrawn', endedOn: '2026-10-05' }).where(eq(studentPrograms.studentId, campusData.other.id)))
  await assert.rejects(placement.apply(campusData.other, { driveId: graded.id }), /programme/i)
})

test('tenant isolation holds for company references, applications and direct reads', async () => {
  const first = await campus()
  const second = await campus()
  await assert.rejects(placement.createDrive(first.admin, { companyId: second.company.id, title: 'Wrong tenant', closesAt: '2099-01-01T00:00:00Z' }), /company/i)
  await assert.rejects(placement.apply(first.student, { driveId: second.drive.id }), /drive/i)
  const rows = await withTenant(first.institutionId, (tx) => tx.select().from(companies).where(eq(companies.id, second.company.id)))
  assert.equal(rows.length, 0)
})

test('duplicate applications are idempotent and withdrawal is only by the applicant', async () => {
  const campusData = await campus()
  await placement.changeDrive(campusData.admin, { driveId: campusData.drive.id, status: 'open' })
  const results = await Promise.all(Array.from({ length: 3 }, () => placement.apply(campusData.student, { driveId: campusData.drive.id })))
  assert.equal(new Set(results.map((result) => result.id)).size, 1)
  await assert.rejects(placement.withdraw(campusData.other, { applicationId: results[0]!.id }), /application/i)
  await placement.withdraw(campusData.student, { applicationId: results[0]!.id })
  const rows = await withTenant(campusData.institutionId, (tx) => tx.select().from(applications))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, 'withdrawn')
  assert.equal((await placement.workspace(campusData.other)).applications.length, 0)
})

test('rounds enforce progression and rejected candidates cannot receive offers', async () => {
  const campusData = await campus()
  await placement.changeDrive(campusData.admin, { driveId: campusData.drive.id, status: 'open' })
  const application = await placement.apply(campusData.student, { driveId: campusData.drive.id })
  const first = await placement.createRound(campusData.admin, { driveId: campusData.drive.id, name: 'Written' })
  const second = await placement.createRound(campusData.admin, { driveId: campusData.drive.id, name: 'Interview' })
  await assert.rejects(placement.recordResult(campusData.admin, { applicationId: application.id, roundId: second.id, outcome: 'passed', note: 'Skip written' }), /earlier/i)
  await assert.rejects(placement.issueOffer(campusData.admin, { applicationId: application.id, annualPaise: 90000000 }), /round/i)
  await placement.recordResult(campusData.admin, { applicationId: application.id, roundId: first.id, outcome: 'failed', note: 'Below threshold' })
  await assert.rejects(placement.issueOffer(campusData.admin, { applicationId: application.id, annualPaise: 90000000 }), /active/i)
})

test('concurrent offer acceptance permits only one accepted placement per student', async () => {
  const campusData = await campus()
  const offerIds: string[] = []
  for (const title of ['First', 'Second']) {
    const drive = await placement.createDrive(campusData.admin, { companyId: campusData.company.id, title, closesAt: '2099-01-01T00:00:00Z' })
    await placement.changeDrive(campusData.admin, { driveId: drive.id, status: 'open' })
    const application = await placement.apply(campusData.student, { driveId: drive.id })
    const round = await placement.createRound(campusData.admin, { driveId: drive.id, name: 'Interview' })
    await placement.recordResult(campusData.admin, { applicationId: application.id, roundId: round.id, outcome: 'passed', note: 'Panel approved' })
    offerIds.push((await placement.issueOffer(campusData.admin, { applicationId: application.id, annualPaise: 90000000 })).id)
  }
  const results = await Promise.allSettled(offerIds.map((offerId) => placement.respondOffer(campusData.student, { offerId, decision: 'accepted' })))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal((await placement.statistics(campusData.admin)).accepted, 1)
})

test('eligibility uses published academic grades and uncleared distinct backlogs', async () => {
  const campusData = await campus()
  const record = await withTenant(campusData.institutionId, async (tx) => {
    const [passed, failed] = await tx.insert(courses).values(['PASS', 'FAIL'].map((code) => ({ institutionId: campusData.institutionId, departmentId: campusData.program.departmentId, code, title: code, credits: 4 }))).returning()
    await tx.insert(courseCompletions).values([
      { institutionId: campusData.institutionId, studentId: campusData.student.id, courseId: passed!.id, credits: 4, gradePoints: '9', passed: true, source: 'transfer', note: 'Verified transcript' },
      { institutionId: campusData.institutionId, studentId: campusData.student.id, courseId: failed!.id, credits: 4, gradePoints: '0', passed: false, source: 'transfer', note: 'Verified failed course' },
    ])
    return failed!
  })
  const drive = await placement.createDrive(campusData.admin, { companyId: campusData.company.id, title: 'Verified grades', closesAt: '2099-01-01T00:00:00Z', minCgpa: 8, maxBacklogs: 0 })
  await placement.changeDrive(campusData.admin, { driveId: drive.id, status: 'open' })
  await assert.rejects(placement.apply(campusData.student, { driveId: drive.id }), /backlog/i)
  await withTenant(campusData.institutionId, (tx) => tx.insert(courseCompletions).values({ institutionId: campusData.institutionId, studentId: campusData.student.id, courseId: record.id, credits: 4, gradePoints: '8', passed: true, source: 'transfer', note: 'Verified resit pass' }))
  const application = await placement.apply(campusData.student, { driveId: drive.id })
  assert.equal(application.eligibility.cgpa, 8.5)
  assert.equal(application.eligibility.backlogs, 0)
})

test('the database refuses cross-tenant references and mismatched offer owners', async () => {
  const first = await campus()
  const second = await campus()
  await assert.rejects(withTenant(first.institutionId, (tx) => tx.insert(applications).values({ institutionId: first.institutionId, driveId: first.drive.id, studentId: second.student.id, eligibility: { cgpa: null, backlogs: 0, checkedAt: new Date().toISOString() } })))
  await placement.changeDrive(first.admin, { driveId: first.drive.id, status: 'open' })
  const application = await placement.apply(first.student, { driveId: first.drive.id })
  await assert.rejects(withTenant(first.institutionId, (tx) => tx.insert(offers).values({ institutionId: first.institutionId, applicationId: application.id, studentId: first.other.id, annualPaise: '10000' })))
})

test('all seven pages load real records and every form has a declared route', async () => {
  const campusData = await campus()
  assert.equal(pages.length, 7)
  for (const page of pages) {
    const data = await page.load(campusData.admin, new Request(`https://campus.test/m/placement${page.path}`))
    const sections = page.sections(data)
    assert.ok(sections.length)
    for (const section of sections) {
      if (section.kind === 'form') assert.ok(routes.some((route) => route.path === section.path && route.method === 'POST'), section.path)
    }
  }
  const data = await pages[0]!.load(campusData.student, new Request('https://campus.test/m/placement'))
  assert.equal(data.staff, false)
  assert.deepEqual(data.people, [])
})
