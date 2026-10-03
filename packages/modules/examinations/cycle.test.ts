import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import * as feedback from '@campusos/module-feedback/api'
import { listStudentCharges, type Actor as FeeActor } from '@campusos/module-fees/api'
import {
  admitCard,
  admitCardPdf,
  bookBacklog,
  cancelBacklog,
  cancelEnrolment,
  createExam,
  downloadPaper,
  enrol,
  enrolmentList,
  ExamError,
  examStats,
  gradeReport,
  gradeReportPdf,
  myExamCycle,
  papersFor,
  setExamCycleSettings,
  setWindow,
  studentPerformance,
  uploadPaper,
  type Actor,
} from './api'
import { backlogBookings, enrolments, questionPapers } from './schema'

/**
 * The examination cycle as KIIT's portal runs it: enrol in the window with
 * your details confirmed, download the admit card, book a failed paper to sit
 * again, and download the semester grade report once your feedback is in --
 * with the question paper sealed until shortly before the exam.
 */

const SLUG = 'exam-cycle-'
let n = 0
const H = 3600_000
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Cycle University', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Exam Cell' },
      { email: `t@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Rao' },
      { email: `t2@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Sen' },
      { email: `asha@${tag}.test`, institutionId: id, role: 'student', name: 'Asha Roy' },
      { email: `bilal@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal Khan' },
    ])
    .returning({ id: users.id })
  const [adm, t, t2, asha, bilal] = people.map((p) => p.id) as [string, string, string, string, string]
  const admin: Actor = { id: adm, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const a = admin as unknown as academic.Actor
  const dept = await academic.createDepartment(a, { code: 'CSE', name: 'Computing' })
  const prog = await academic.createProgram(a, { departmentId: dept.id, code: 'BTCS', name: 'B.Tech CSE', level: 'undergraduate', durationTerms: 8 })
  const past = await academic.createTerm(a, { code: `S${n}`, name: 'Spring', startsOn: '2026-01-05', endsOn: '2026-05-30' })
  const term = await academic.createTerm(a, { code: `A${n}`, name: 'Autumn', startsOn: '2026-07-01', endsOn: '2026-11-30' })
  await academic.setCurrentTerm(a, { termId: term.id })
  const ds = await academic.createCourse(a, { departmentId: dept.id, code: `DS${n}`, title: 'Data Structures', credits: 4 })
  const ps = await academic.createCourse(a, { departmentId: dept.id, code: `PS${n}`, title: 'Probability', credits: 3 })
  const ma = await academic.createCourse(a, { departmentId: dept.id, code: `MA${n}`, title: 'Linear Algebra', credits: 4 })
  const room = await academic.createRoom(a, { code: `LH-${n}`, building: 'Campus 14', capacity: 80 })
  const sec = await academic.createSection(a, { programId: prog.id, label: 'A', admissionYear: 2025 })
  for (const s of [asha, bilal]) await academic.addSectionMember(a, { sectionId: sec.id, userId: s })
  const offDs = await academic.createOffering(a, { termId: term.id, courseId: ds.id, sectionId: sec.id, facultyUserId: t })
  const offPs = await academic.createOffering(a, { termId: term.id, courseId: ps.id, sectionId: sec.id, facultyUserId: t2 })
  // Last term: Asha failed Linear Algebra and passed nothing else of it; Bilal passed it.
  await academic.recordCompletion(a, { studentId: asha, courseId: ma.id, termId: past.id, gradeLabel: 'F', gradePoints: 0, passed: false })
  await academic.recordCompletion(a, { studentId: bilal, courseId: ma.id, termId: past.id, gradeLabel: 'B', gradePoints: 8, passed: true })
  await academic.setStudentProfile(a, {
    studentId: asha,
    rollNo: `R${n}001`,
    registrationNo: `REG${n}001`,
    phone: '+91 98765 43210',
    addressLine: '12 Patia Road',
    city: 'Bhubaneswar',
    state: 'Odisha',
    postalCode: '751024',
  })
  const finalDs = await createExam(admin, {
    offeringId: offDs.id,
    name: 'End semester',
    kind: 'final',
    maxMarks: 100,
    weightPercent: 50,
    scheduledAt: iso(72 * H),
    roomId: room.id,
  })
  return {
    id,
    admin,
    teacher: { id: t, role: 'faculty', institutionId: id } as Actor,
    otherTeacher: { id: t2, role: 'faculty', institutionId: id } as Actor,
    asha: { id: asha, role: 'student', institutionId: id } as Actor,
    bilal: { id: bilal, role: 'student', institutionId: id } as Actor,
    termId: term.id,
    pastTermId: past.id,
    maId: ma.id,
    dsId: ds.id,
    offDs: offDs.id,
    offPs: offPs.id,
    finalDs: finalDs.id,
  }
}

const code = (e: unknown) => (e as ExamError).code
const enable = (institutionId: string, ...ids: string[]) =>
  authDb
    .insert(institutionModules)
    .values(ids.map((moduleId) => ({ institutionId, moduleId, enabled: true })))
    .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled: true } })

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('enrolment happens in its window, with the details the student confirmed, and gives an admit card', async () => {
  const c = await campus()
  await assert.rejects(enrol(c.asha, { termId: c.termId, confirm: 'true' }), (e) => code(e) === 'exam_enrolment_window')
  await setWindow(c.admin, {
    termId: c.termId,
    kind: 'enrolment',
    opensAt: iso(-H),
    closesAt: iso(24 * H),
    instructions: 'Report thirty minutes before the start.\nNo phones in the hall.',
  })
  await assert.rejects(enrol(c.asha, { termId: c.termId }), (e) => code(e) === 'not_confirmed')
  await assert.rejects(enrol(c.teacher, { termId: c.termId, confirm: true }), (e) => code(e) === 'forbidden')

  const e = await enrol(c.asha, { termId: c.termId, confirm: 'true' })
  assert.match(e.notice, /2 papers/)
  assert.equal(e.confirmed.rollNo, `R${n}001`)
  assert.equal(e.confirmed.address, '12 Patia Road, Bhubaneswar, Odisha, 751024')
  await assert.rejects(enrol(c.asha, { termId: c.termId, confirm: true }), (e2) => code(e2) === 'exam_enrolments_once')

  // A later correction to the profile does not rewrite what was confirmed.
  await academic.setStudentProfile(c.admin as unknown as academic.Actor, { studentId: c.asha.id, rollNo: 'CHANGED', phone: '1234567' })
  const card = await admitCard(c.asha, c.asha.id, c.termId)
  assert.equal(card.student.rollNo, `R${n}001`)
  assert.equal(card.ticketNo, `A${n}/R${n}001`)
  assert.deepEqual(card.papers.map((p) => p.code), [`DS${n}`, `PS${n}`])
  assert.equal(card.papers[0]!.room, `LH-${n}`)
  assert.ok(card.papers[0]!.when, 'the scheduled final is on the card')
  assert.equal(card.papers[1]!.when, null, 'Probability has no final yet: to be announced')
  const pdf = Buffer.from(await admitCardPdf(card))
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')

  await assert.rejects(admitCard(c.bilal, c.asha.id, c.termId), (e2) => code(e2) === 'forbidden')
  await assert.rejects(admitCard(c.bilal, c.bilal.id, c.termId), (e2) => code(e2) === 'not_enrolled')

  const list = await enrolmentList(c.admin, c.termId)
  assert.deepEqual(list.map((r) => [r.name, r.state]), [['Bilal Khan', 'not_enrolled'], ['Asha Roy', 'enrolled']])

  // The office cancels with a reason; never deleted, never edited.
  await cancelEnrolment(c.admin, { enrolmentId: e.id, reason: 'enrolled against the wrong programme' })
  await assert.rejects(
    withTenant(c.id, (tx) => tx.delete(enrolments).where(eq(enrolments.id, e.id))),
    (x) => String((x as { cause?: { constraint?: string } }).cause?.constraint) === 'exam_enrolment_kept',
  )
  await enrol(c.asha, { termId: c.termId, confirm: true })
})

test('a backlog is a course the record shows failed, booked in its window at its fee, charged through fees', async () => {
  const c = await campus()
  await enable(c.id, 'finance', 'fees')
  await setWindow(c.admin, { termId: c.termId, kind: 'backlog', opensAt: iso(-H), closesAt: iso(24 * H), internalFee: '500', examFee: '1,500' })

  const cycle = await myExamCycle(c.asha)
  assert.deepEqual(cycle!.backlogs.map((b) => b.code), [`MA${n}`])
  assert.deepEqual((await myExamCycle(c.bilal))!.backlogs, [], 'Bilal passed it')

  await assert.rejects(
    bookBacklog(c.bilal, { termId: c.termId, courseId: c.maId, bookingType: 'university' }),
    (e) => code(e) === 'exam_backlog_not_failed',
  )
  await assert.rejects(
    bookBacklog(c.asha, { termId: c.termId, courseId: c.dsId, bookingType: 'university' }),
    (e) => code(e) === 'exam_backlog_not_failed',
  )
  const b = await bookBacklog(c.asha, { termId: c.termId, courseId: c.maId, bookingType: 'both' })
  assert.equal(b.feePaise, 200_000, 'the database adds the two fees; the caller cannot set it')
  assert.match(b.notice, /2,000\.00, added to your fees/)
  await assert.rejects(
    bookBacklog(c.asha, { termId: c.termId, courseId: c.maId, bookingType: 'internal' }),
    (e) => code(e) === 'exam_backlog_bookings_once',
  )
  const charges = await listStudentCharges(c.admin as unknown as FeeActor, c.termId)
  assert.equal(charges.length, 1)
  assert.equal(charges[0]!.amountPaise, 200_000)
  assert.equal(charges[0]!.sourceId, b.id)

  // Cancelling takes the fee with it.
  await assert.rejects(cancelBacklog(c.bilal, { bookingId: b.id, reason: 'not mine to cancel' }), (e) => code(e) === 'forbidden')
  await cancelBacklog(c.asha, { bookingId: b.id, reason: 'I will sit it next year' })
  assert.equal((await listStudentCharges(c.admin as unknown as FeeActor, c.termId))[0]!.state, 'cancelled')
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(backlogBookings).set({ bookingType: 'internal' }).where(eq(backlogBookings.id, b.id))),
    (x) => String((x as { cause?: { constraint?: string } }).cause?.constraint) === 'exam_backlog_fixed',
  )

  // Without fees on, the booking still stands; the fee is paid at the office.
  const d = await campus()
  await setWindow(d.admin, { termId: d.termId, kind: 'backlog', opensAt: iso(-H), closesAt: iso(H), examFee: '1000' })
  const nb = await bookBacklog(d.asha, { termId: d.termId, courseId: d.maId, bookingType: 'university' })
  assert.match(nb.notice, /payable at the office/)

  // A closed window refuses.
  await setWindow(d.admin, { termId: d.termId, kind: 'backlog', opensAt: iso(-3 * H), closesAt: iso(-H) })
  await assert.rejects(
    cancelBacklog(d.asha, { bookingId: nb.id, reason: 'changed my mind' }),
    (e) => code(e) === 'exam_backlog_window',
  )
  await cancelBacklog(d.admin, { bookingId: nb.id, reason: 'withdrawn by the office on request' })
})

test('the semester grade report is the official record for the term, held for feedback where the institution says so', async () => {
  const c = await campus()
  const a = c.admin as unknown as academic.Actor
  // This term's results, finalised.
  await academic.recordCompletion(a, { studentId: c.asha.id, courseId: c.dsId, termId: c.termId, gradeLabel: 'A', gradePoints: 9, credits: 4 })
  const g = await gradeReport(c.asha, c.asha.id, c.termId)
  assert.deepEqual(g.courses.map((x) => [x.code, x.grade]), [[`DS${n}`, 'A']])
  assert.equal(g.sgpa, 9)
  // A failed paper is left out of the averages, as the transcript already does;
  // whether an F counts is the university's rule, and this is the product's existing one.
  assert.equal(g.cgpa, 9)
  assert.equal(g.creditsEarnedTotal, 4, 'and earns no credit')
  assert.equal(Buffer.from(await gradeReportPdf(g)).subarray(0, 5).toString(), '%PDF-')

  // The institution holds it for feedback, and takes feedback.
  await enable(c.id, 'feedback')
  await setExamCycleSettings(c.admin, { gradeReportNeedsFeedback: 'true', paperReleaseMinutes: 60 })
  const fa = c.admin as unknown as feedback.Actor
  const form = await feedback.createForm(fa, { name: 'Teaching', audience: 'teaching' })
  await feedback.addScaleQuestions(fa, { formId: form.id, prompts: 'Explains clearly' })
  await feedback.publishForm(fa, { formId: form.id })
  const w = await feedback.createWindow(fa, { formId: form.id, termId: c.termId, title: 'End-semester', opensAt: iso(-H), closesAt: iso(H) })
  await feedback.publishWindow(fa, { windowId: w.id })

  await assert.rejects(gradeReport(c.asha, c.asha.id, c.termId), (e) => code(e) === 'feedback_first')
  // Staff are not held: the office can always print it.
  assert.equal((await gradeReport(c.admin, c.asha.id, c.termId)).sgpa, 9)
  const q = (await feedback.formView(fa, form.id)).questions[0]!.id
  const sa = c.asha as unknown as feedback.Actor
  for (const off of [c.offDs, c.offPs]) await feedback.give(sa, { windowId: w.id, offeringId: off, [`q_${q}`]: '4' })
  assert.equal((await gradeReport(c.asha, c.asha.id, c.termId)).sgpa, 9)
  const cycle = await myExamCycle(c.asha)
  assert.equal(cycle!.feedback!.complete, true)
  assert.deepEqual(cycle!.reports.map((r) => r.held), [false, false])
})

test('a question paper is sealed: uploaded before the lead time, opened only by the cell, only from then, on the record', async () => {
  const c = await campus()
  const pdf = (s: string) => {
    const b = Buffer.from(`%PDF-1.7\n${s}\n`)
    return { name: 'ds-final.pdf', type: 'application/pdf', size: b.length, base64: b.toString('base64') }
  }
  await assert.rejects(uploadPaper(c.otherTeacher, { examId: c.finalDs, paper: pdf('not mine') }), (e) => code(e) === 'not_your_offering')
  await assert.rejects(
    uploadPaper(c.teacher, { examId: c.finalDs, paper: { name: 'x.pdf', type: 'application/pdf', size: 3, base64: Buffer.from('MZx').toString('base64') } }),
    (e) => code(e) === 'wrong_type',
  )
  const v1 = await uploadPaper(c.teacher, { examId: c.finalDs, paper: pdf('first draft') })
  const v2 = await uploadPaper(c.teacher, { examId: c.finalDs, paper: pdf('corrected question 4') })
  assert.deepEqual([v1.version, v2.version], [1, 2])
  const seen = await papersFor(c.teacher, c.finalDs)
  assert.deepEqual(seen.papers.map((p) => p.state), ['sealed', 'superseded'])
  assert.ok(!JSON.stringify(seen).includes('corrected question 4'), 'the contents are never in the listing')

  await assert.rejects(downloadPaper(c.admin, v2.id), (e) => code(e) === 'sealed')
  await assert.rejects(downloadPaper(c.teacher as Actor, v2.id), (e) => code(e) === 'forbidden')
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(questionPapers).set({ fileName: 'other.pdf' }).where(eq(questionPapers.id, v2.id))),
    (x) => String((x as { cause?: { constraint?: string } }).cause?.constraint) === 'exam_paper_fixed',
  )

  // The exam draws near: the seal closes to the setter and opens to the cell.
  await authDb.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`)
    await tx.execute(sql`update exams set scheduled_at = now() + interval '30 minutes' where id = ${c.finalDs}`)
  })
  await assert.rejects(uploadPaper(c.teacher, { examId: c.finalDs, paper: pdf('too late') }), (e) => code(e) === 'exam_paper_locked')
  const got = await downloadPaper(c.admin, v2.id)
  assert.match(Buffer.from(got.content).toString(), /corrected question 4/)
  const trail = await withTenant(c.id, (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, v2.id)))
  assert.deepEqual(trail.map((t) => t.action).sort(), ['download', 'upload'])
})

test('statistics: an exam’s spread and pass rate, and a student beside their class', async () => {
  const c = await campus()
  const { enterMarks, publishExam } = await import('./api')
  const quiz = await createExam(c.teacher, { offeringId: c.offDs, name: 'Quiz', kind: 'quiz', maxMarks: 20, weightPercent: 10 })
  await enterMarks(c.teacher, {
    examId: quiz.id,
    marks: [
      { studentId: c.asha.id, obtained: 18 },
      { studentId: c.bilal.id, obtained: 6 },
    ],
  })
  await publishExam(c.teacher, { examId: quiz.id })
  const s = await examStats(c.teacher, quiz.id)
  assert.deepEqual([s.sat, s.mean, s.median, s.highest, s.lowest], [2, 60, 60, 90, 30])
  assert.equal(s.passRate, 50, 'one of two at or above the pass floor')
  assert.equal(s.bands.reduce((n2, b) => n2 + b.students, 0), 2)
  await assert.rejects(examStats(c.otherTeacher, quiz.id), (e) => code(e) === 'not_your_offering')

  const mine = await studentPerformance(c.asha, c.asha.id)
  assert.deepEqual(mine.map((r) => [r.exam, r.percent, r.classMean, r.versus]), [['Quiz', 90, 60, 30]])
  await assert.rejects(studentPerformance(c.asha, c.bilal.id), (e) => code(e) === 'forbidden')
})
