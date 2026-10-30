import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like } from 'drizzle-orm'
import { authDb, institutionModules, institutions, users } from '@campusos/db'
import {
  addSectionMember,
  createCourse,
  createDepartment,
  createOffering,
  createProgram,
  createRoom,
  createSection,
  createTerm,
  type Actor as Academic,
} from '@campusos/module-academic/api'
import { printedText } from '@campusos/module-framework/pdf'
import { addEligibility, defaultNeeds, generatePeriods, generateRun, runPdf, solveSettled, type Actor } from './api'

const SLUG = 'tt-pdf-'

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('a timetable prints a Kannada teacher’s name (UX-01)', async () => {
  const tag = `${SLUG}${Date.now()}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Timetable PDF College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  // A finished solve is re-checked as a job's actor is, which wants the module on.
  await authDb.insert(institutionModules).values({ institutionId: id, moduleId: 'timetable', enabled: true })
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `abhi@${tag}.test`, institutionId: id, role: 'faculty', name: 'ಅಭಿಷೇಕ್' },
      { email: `stu@${tag}.test`, institutionId: id, role: 'student', name: 'Stu' },
    ])
    .returning({ id: users.id })
  const admin: Actor & Academic = { id: people[0]!.id, role: 'institution_admin', institutionId: id }

  const dept = await createDepartment(admin, { code: 'CSE', name: 'Computing' })
  const program = await createProgram(admin, { departmentId: dept.id, code: 'BT', name: 'B.Tech', level: 'undergraduate', durationTerms: 8 })
  const term = await createTerm(admin, { code: 'T1', name: 'Autumn', startsOn: '2026-01-05', endsOn: '2026-12-15' })
  const room = await createRoom(admin, { code: 'R1', capacity: 70 })
  const course = await createCourse(admin, { departmentId: dept.id, code: 'DS1', title: 'Data Structures', credits: 3 })
  const section = await createSection(admin, { programId: program.id, label: 'A', admissionYear: 2025 })
  await addSectionMember(admin, { sectionId: section.id, userId: people[2]!.id })
  await createOffering(admin, { termId: term.id, courseId: course.id, sectionId: section.id })
  await generatePeriods(admin, { days: ['1', '2', '3', '4', '5'], startsAt: '09:00', minutes: '50', count: '7', breaks: '2:10, 4:40' })
  await addEligibility(admin, { userId: people[1]!.id, courseId: course.id, preference: '5' })
  await defaultNeeds(admin, { termId: term.id })
  void room

  const draft = await generateRun(admin, { termId: term.id, seed: '5', iterations: '3000' })
  await solveSettled(draft.id)
  const paper = await runPdf(admin, { runId: draft.id, all: 'teachers' })
  assert.ok((await printedText(paper.bytes)).includes('ಅಭಿಷೇಕ್'))
})
