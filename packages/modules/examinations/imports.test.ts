import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor } from '@campusos/module-framework'
import {
  addSectionMember,
  createCourse,
  createDepartment,
  createOffering,
  createProgram,
  createSection,
  createTerm,
} from '@campusos/module-academic/api'
import { plugin } from './plugin'
import { createExam, publishExam } from './api'
import { examMarks } from './schema'

const SLUG = 'exam-import'
let tenant: string
let admin: PluginActor
let lecturer: PluginActor
let other: PluginActor
let examId: string

const run = (actor: PluginActor, csv: string, apply = true) =>
  plugin.routes
    .find((r) => r.path === '/imports/run')!
    .handler(actor, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId: 'marks', csv, apply }) })) as Promise<{ created: number; updated: number }>

before(async () => {
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Exam Import', allowedEmailDomains: [] }).returning()
  tenant = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { institutionId: tenant, email: 'office@exam-import.test', role: 'institution_admin' },
      { institutionId: tenant, email: 'rao@exam-import.test', role: 'faculty' },
      { institutionId: tenant, email: 'kumar@exam-import.test', role: 'faculty' },
      { institutionId: tenant, email: 'asha@exam-import.test', role: 'student' },
      { institutionId: tenant, email: 'ravi@exam-import.test', role: 'student' },
    ])
    .returning()
  admin = { id: people[0]!.id, role: 'institution_admin', institutionId: tenant }
  lecturer = { id: people[1]!.id, role: 'faculty', institutionId: tenant }
  other = { id: people[2]!.id, role: 'faculty', institutionId: tenant }
  const dept = (await createDepartment(admin, { code: 'CSE', name: 'CS' })) as { id: string }
  const program = (await createProgram(admin, { departmentId: dept.id, code: 'BTCS', name: 'BTech', level: 'undergraduate', durationTerms: 8 })) as { id: string }
  const course = (await createCourse(admin, { departmentId: dept.id, code: 'CS101', title: 'Programming', credits: 4 })) as { id: string }
  const term = (await createTerm(admin, { code: 'AUT2026', name: 'Autumn', startsOn: '2026-07-20', endsOn: '2026-12-05' })) as { id: string }
  const section = (await createSection(admin, { programId: program.id, label: 'A', admissionYear: 2025 })) as { id: string }
  await addSectionMember(admin, { sectionId: section.id, userId: people[3]!.id })
  await addSectionMember(admin, { sectionId: section.id, userId: people[4]!.id })
  const offering = (await createOffering(admin, { termId: term.id, courseId: course.id, sectionId: section.id, facultyUserId: lecturer.id })) as { id: string }
  examId = ((await createExam(lecturer, { offeringId: offering.id, name: 'Mid-semester', kind: 'midterm', maxMarks: 50, weightPercent: 30 })) as { id: string }).id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

const SHEET = 'term,course,exam,email,marks,absent\nAUT2026,CS101,mid-semester,asha@exam-import.test,42.5,\nAUT2026,CS101,Mid-semester,ravi@exam-import.test,,yes\n'

test('a lecturer imports their class’s marks, and a second file updates them', async () => {
  assert.equal((await run(lecturer, SHEET)).created, 2)
  const again = await run(lecturer, SHEET.replace('42.5', '44'))
  assert.equal(again.updated, 2)
  const marks = await withTenant(tenant, (tx) => tx.select().from(examMarks).where(eq(examMarks.examId, examId)))
  assert.deepEqual(marks.map((m) => [m.obtained === null ? null : Number(m.obtained), m.absent]).sort(), [[null, true], [44, false]])
})

test('the marks screen’s rules hold: someone else’s class, too many marks, a stranger, published results', async () => {
  await assert.rejects(run(other, SHEET), /nothing was imported/)
  await assert.rejects(run(lecturer, SHEET.replace('42.5', '51')), /exceeds the maximum of 50/)
  await assert.rejects(run(lecturer, 'term,course,exam,email,marks\nAUT2026,CS101,Mid-semester,office@exam-import.test,10\n'), /not in this cohort/)
  await assert.rejects(run(lecturer, 'term,course,exam,email,marks\nAUT2026,CS101,Final,asha@exam-import.test,10\n'), /no exam "Final"/)
  await publishExam(lecturer, { examId })
  await assert.rejects(run(lecturer, SHEET), /published/)
})
