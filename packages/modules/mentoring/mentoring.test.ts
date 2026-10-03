import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import * as hostel from '@campusos/module-hostel/api'
import { leaves as hostelLeaves } from '@campusos/module-hostel/schema'
import {
  MentorError,
  addLeaveType,
  addNote,
  applyLeave,
  assignMentor,
  assignmentList,
  cancelLeave,
  decideLeave,
  leaveDocument,
  menteeView,
  myMentees,
  myMentoring,
  pendingLeave,
  sendMessage,
  type Actor,
} from './api'
import { assignments, leaveApplications, messages, notes } from './schema'

/**
 * Mentoring as KIIT's portal and its faculty self-service have it: a mentor
 * and co-mentor per student, who sees the whole student, keeps notes, talks
 * with them, and decides their leave -- which reaches the hostel roll call.
 */

const SLUG = 'mentor-test-'
let n = 0
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const at = (offset: number, hhmm: string) => `${day(offset)}T${hhmm}`

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Mentor University', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Office' },
      { email: `rout@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Rout' },
      { email: `das@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Das' },
      { email: `sen@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Sen' },
      { email: `asha@${tag}.test`, institutionId: id, role: 'student', name: 'Asha Roy' },
      { email: `bilal@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal Khan' },
    ])
    .returning({ id: users.id })
  const [adm, rout, das, sen, asha, bilal] = people.map((p) => p.id) as [string, string, string, string, string, string]
  const admin: Actor = { id: adm, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const a = admin as unknown as academic.Actor
  const dept = await academic.createDepartment(a, { code: 'CSE', name: 'Computing' })
  const prog = await academic.createProgram(a, { departmentId: dept.id, code: 'BTCS', name: 'B.Tech', level: 'undergraduate', durationTerms: 8 })
  const sec = await academic.createSection(a, { programId: prog.id, label: 'A', admissionYear: 2025 })
  for (const s of [asha, bilal]) await academic.addSectionMember(a, { sectionId: sec.id, userId: s })
  await academic.setStudentProfile(a, { studentId: asha, rollNo: `R${n}1`, phone: '+91 98765 43210' })
  const home = await addLeaveType(admin, { name: 'Home visit', maxDays: 7 })
  const medical = await addLeaveType(admin, { name: 'Medical', needsDocument: 'true' })
  return {
    id,
    admin,
    rout: { id: rout, role: 'faculty', institutionId: id } as Actor,
    das: { id: das, role: 'faculty', institutionId: id } as Actor,
    sen: { id: sen, role: 'faculty', institutionId: id } as Actor,
    asha: { id: asha, role: 'student', institutionId: id } as Actor,
    bilal: { id: bilal, role: 'student', institutionId: id } as Actor,
    sectionId: sec.id,
    home: home.id,
    medical: medical.id,
  }
}

const code = (e: unknown) => (e as MentorError).code
const enable = (institutionId: string, ...ids: string[]) =>
  authDb
    .insert(institutionModules)
    .values(ids.map((moduleId) => ({ institutionId, moduleId, enabled: true })))
    .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled: true } })
const leaveFor = (c: Awaited<ReturnType<typeof campus>>, over: Record<string, unknown> = {}) =>
  applyLeave(c.asha, {
    leaveTypeId: c.home,
    startsOn: day(3),
    endsOn: day(5),
    purpose: 'Sister’s wedding at home',
    placeOfVisit: 'Cuttack',
    leavingAt: at(3, '07:30'),
    arrivingAt: at(5, '20:00'),
    contactPhone: '+91 98765 43210',
    ...over,
  })

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('the office gives a section a mentor and co-mentor; changing one keeps the history', async () => {
  const c = await campus()
  await assert.rejects(assignMentor(c.rout, { sectionId: c.sectionId, mentorId: c.rout.id }), (e) => code(e) === 'forbidden')
  await assert.rejects(assignMentor(c.admin, { sectionId: c.sectionId, mentorId: c.bilal.id }), (e) => code(e) === 'mentor_staff')
  await assert.rejects(
    assignMentor(c.admin, { sectionId: c.sectionId, mentorId: c.rout.id, coMentorId: c.rout.id }),
    (e) => code(e) === 'mentor_assignments_two',
  )
  const r = await assignMentor(c.admin, { sectionId: c.sectionId, mentorId: c.rout.id, coMentorId: c.das.id })
  assert.equal(r.assigned, 2)
  const list = await assignmentList(c.admin)
  assert.deepEqual(list.map((x) => [x.student, x.mentor, x.coMentor]), [['Asha Roy', 'Dr Rout', 'Dr Das'], ['Bilal Khan', 'Dr Rout', 'Dr Das']])

  // Bilal changes mentor: the old row ends, a new one begins.
  await assignMentor(c.admin, { studentIds: [c.bilal.id], mentorId: c.sen.id, reason: 'Dr Rout is on sabbatical' })
  const rows = await withTenant(c.id, (tx) => tx.select().from(assignments).where(eq(assignments.studentId, c.bilal.id)))
  assert.equal(rows.length, 2)
  assert.equal(rows.filter((x) => x.toOn === null).length, 1)
  await assert.rejects(
    withTenant(c.id, (tx) => tx.delete(assignments).where(eq(assignments.studentId, c.bilal.id))),
    (e) => String((e as { cause?: { constraint?: string } }).cause?.constraint) === 'mentor_assignment_kept',
  )
})

test('a mentor sees the whole of their mentee, and only their mentees', async () => {
  const c = await campus()
  await enable(c.id, 'attendance')
  await assignMentor(c.admin, { studentIds: [c.asha.id], mentorId: c.rout.id, coMentorId: c.das.id })
  const v = await menteeView(c.rout, c.asha.id)
  assert.equal(v.profile.rollNo, `R${n}1`)
  assert.equal(v.mentor, 'Dr Rout')
  assert.equal(v.coMentor, 'Dr Das')
  assert.deepEqual(v.attendance, [], 'attendance is on, and Asha has no classes yet')
  assert.equal(v.results, null, 'examinations is off here, so no results are shown')
  assert.equal((await menteeView(c.das, c.asha.id)).profile.name, 'Asha Roy', 'the co-mentor too')
  await assert.rejects(menteeView(c.sen, c.asha.id), (e) => code(e) === 'not_your_mentee')
  assert.equal((await menteeView(c.admin, c.asha.id)).profile.name, 'Asha Roy', 'and the office')
  assert.deepEqual((await myMentees(c.rout)).map((m) => m.student), ['Asha Roy'])
})

test('notes are private unless shared; the conversation is the student’s and their mentors’', async () => {
  const c = await campus()
  await assignMentor(c.admin, { studentIds: [c.asha.id], mentorId: c.rout.id })
  await addNote(c.rout, { studentId: c.asha.id, metOn: day(0), kind: 'concern', body: 'Seemed withdrawn; check in after the mid-terms' })
  await addNote(c.rout, { studentId: c.asha.id, metOn: day(0), kind: 'progress', body: 'Good progress in Data Structures', shared: 'true' })
  await assert.rejects(addNote(c.sen, { studentId: c.asha.id, metOn: day(0), kind: 'meeting', body: 'not my mentee' }), (e) => code(e) === 'not_your_mentee')
  assert.deepEqual((await myMentoring(c.asha)).notes.map((x) => x.body), ['Good progress in Data Structures'])
  assert.equal((await menteeView(c.rout, c.asha.id)).notes.length, 2)
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(notes).set({ body: 'rewritten' }).where(eq(notes.studentId, c.asha.id))),
    (e) => String((e as { cause?: { constraint?: string } }).cause?.constraint) === 'mentor_note_kept',
  )

  await sendMessage(c.asha, { body: 'Could we meet about the backlog paper?' })
  assert.equal((await myMentees(c.rout))[0]!.unread, 1)
  const view = await menteeView(c.rout, c.asha.id)
  assert.equal(view.thread[0]!.from, 'student')
  assert.equal((await myMentees(c.rout))[0]!.unread, 0, 'reading the mentee marks it read')
  await sendMessage(c.rout, { studentId: c.asha.id, body: 'Thursday at 3, my cabin' })
  assert.equal((await myMentoring(c.asha)).thread.length, 2)
  await assert.rejects(sendMessage(c.sen, { studentId: c.asha.id, body: 'hello' }), (e) => code(e) === 'mentor_message_sender')
  await assert.rejects(sendMessage(c.bilal, { body: 'I have no mentor' }), (e) => code(e) === 'no_mentor')
  await assert.rejects(
    withTenant(c.id, (tx) => tx.insert(messages).values({ institutionId: c.id, studentId: c.asha.id, senderId: c.bilal.id, body: 'a classmate' })),
    (e) => String((e as { cause?: { constraint?: string } }).cause?.constraint) === 'mentor_message_sender',
  )
})

test('leave: asked for as KIIT’s form asks, decided by the mentor, and handed to the hostel', async () => {
  const c = await campus()
  await enable(c.id, 'hostel')
  await assignMentor(c.admin, { studentIds: [c.asha.id], mentorId: c.rout.id })
  const h = c.admin as unknown as hostel.Actor
  const block = await hostel.createBlock(h, { code: 'KP14', name: 'King’s Palace 14' })
  const [room] = await hostel.addRooms(h, { blockId: block.id, numbers: ['2A-30'] })
  await hostel.allocate(h, { roomId: room!.id, studentId: c.asha.id })

  await assert.rejects(leaveFor(c, { leaveTypeId: c.medical }), (e) => code(e) === 'leave_document_required')
  await assert.rejects(leaveFor(c, { endsOn: day(12), arrivingAt: at(12, '20:00') }), (e) => code(e) === 'leave_too_long')
  await assert.rejects(leaveFor(c, { arrivingAt: at(3, '06:00') }), (e) => code(e) === 'mentor_leave_applications_times')

  const pdf = Buffer.from('%PDF-1.4 medical certificate')
  const med = await leaveFor(c, {
    leaveTypeId: c.medical,
    startsOn: day(10),
    endsOn: day(11),
    leavingAt: at(10, '09:00'),
    arrivingAt: at(11, '18:00'),
    document: { name: 'certificate.pdf', type: 'application/pdf', size: pdf.length, base64: pdf.toString('base64') },
  })
  const doc = await leaveDocument(c.rout, med.id)
  assert.equal(Buffer.from(doc.content).toString(), '%PDF-1.4 medical certificate')
  await assert.rejects(leaveDocument(c.sen, med.id), (e) => code(e) === 'not_your_mentee')

  const home = await leaveFor(c)
  assert.match(home.notice, /mentor decides/)
  await assert.rejects(leaveFor(c, { startsOn: day(4), endsOn: day(4), leavingAt: at(4, '08:00'), arrivingAt: at(4, '20:00') }), (e) => code(e) === 'leave_overlap')
  assert.equal((await pendingLeave(c.rout)).length, 2)
  assert.equal((await pendingLeave(c.sen)).length, 0)

  await assert.rejects(decideLeave(c.sen, { applicationId: home.id, decision: 'approve' }), (e) => code(e) === 'not_your_mentee')
  await assert.rejects(decideLeave(c.rout, { applicationId: med.id, decision: 'reject' }), (e) => code(e) === 'leave_reason')
  await decideLeave(c.rout, { applicationId: med.id, decision: 'reject', note: 'the certificate is not signed by a doctor' })
  const ok = await decideLeave(c.rout, { applicationId: home.id, decision: 'approve', note: 'enjoy the wedding' })
  assert.match(ok.notice, /hostel roll call/)
  const housed = await withTenant(c.id, (tx) => tx.select().from(hostelLeaves).where(eq(hostelLeaves.studentId, c.asha.id)))
  assert.deepEqual(housed.map((x) => [x.fromOn, x.toOn]), [[day(3), day(5)]])
  await assert.rejects(decideLeave(c.rout, { applicationId: home.id, decision: 'reject', note: 'changed my mind' }), (e) => code(e) === 'leave_decided')
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(leaveApplications).set({ placeOfVisit: 'Goa' }).where(eq(leaveApplications.id, home.id))),
    (e) => String((e as { cause?: { constraint?: string } }).cause?.constraint) === 'leave_fixed',
  )

  // Plans change before she goes: cancelled, and the hostel no longer expects her away.
  await cancelLeave(c.asha, { applicationId: home.id, reason: 'the wedding was postponed' })
  assert.equal((await withTenant(c.id, (tx) => tx.select().from(hostelLeaves).where(eq(hostelLeaves.studentId, c.asha.id)))).length, 0)
  assert.deepEqual((await myMentoring(c.asha)).leave.map((l) => l.status).sort(), ['cancelled', 'rejected'])
  await assert.rejects(cancelLeave(c.bilal, { applicationId: med.id }), (e) => code(e) === 'no_such_leave')
})
