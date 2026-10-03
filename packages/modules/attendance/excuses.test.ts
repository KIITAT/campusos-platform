import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  AttendanceError,
  attendanceSummary,
  classAbsentees,
  classesNeeded,
  closeSession,
  grantExcuse,
  listExcuses,
  openSession,
  override,
  revokeExcuse,
  setAttendanceRules,
  type Actor,
} from './api'
import { excuses } from './schema'

/**
 * KIIT's attendance view -- present, absent, excused, total, percentage -- by
 * the institution's own rule; the absentees in a teacher's class; and a class
 * cancelled or handed to a substitute on the timetable, which the session
 * honours.
 */

const SLUG = 'att-excuse-'
let n = 0
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
const isoDow = () => {
  const d = new Date(Date.now() + 330 * 60_000).getUTCDay()
  return d === 0 ? 7 : d
}

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Excuse College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Office' },
      { email: `rao@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Rao' },
      { email: `sen@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Sen' },
      { email: `a@${tag}.test`, institutionId: id, role: 'student', name: 'Asha' },
      { email: `b@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal' },
      { email: `c@${tag}.test`, institutionId: id, role: 'student', name: 'Chen' },
    ])
    .returning({ id: users.id })
  const [adm, rao, sen, asha, bilal, chen] = people.map((p) => p.id) as [string, string, string, string, string, string]
  const admin: Actor = { id: adm, role: 'institution_admin', institutionId: id }
  const a = admin as unknown as academic.Actor
  const dept = await academic.createDepartment(a, { code: 'CSE', name: 'Computing' })
  const prog = await academic.createProgram(a, { departmentId: dept.id, code: 'BT', name: 'B.Tech', level: 'undergraduate', durationTerms: 8 })
  const t = new Date()
  const term = await academic.createTerm(a, {
    code: `E${n}`,
    name: 'Autumn',
    startsOn: new Date(t.getTime() - 40 * 86_400_000).toISOString().slice(0, 10),
    endsOn: new Date(t.getTime() + 60 * 86_400_000).toISOString().slice(0, 10),
  })
  await academic.setCurrentTerm(a, { termId: term.id })
  const room = await academic.createRoom(a, { code: `R-${n}`, capacity: 60 })
  const ds = await academic.createCourse(a, { departmentId: dept.id, code: `DS${n}`, title: 'Data Structures', credits: 4 })
  const ps = await academic.createCourse(a, { departmentId: dept.id, code: `PS${n}`, title: 'Probability', credits: 3 })
  const secA = await academic.createSection(a, { programId: prog.id, label: 'A', admissionYear: 2025 })
  const secB = await academic.createSection(a, { programId: prog.id, label: 'B', admissionYear: 2025 })
  for (const s of [asha, bilal]) await academic.addSectionMember(a, { sectionId: secA.id, userId: s })
  await academic.addSectionMember(a, { sectionId: secB.id, userId: chen })
  const off = await academic.createOffering(a, { termId: term.id, courseId: ds.id, sectionId: secA.id, facultyUserId: rao })
  const offB = await academic.createOffering(a, { termId: term.id, courseId: ps.id, sectionId: secB.id, facultyUserId: sen })
  // Today's weekday, so today's meeting is the one a change applies to.
  const slot = await academic.createSlot(a, { offeringId: off.id, roomId: room.id, dayOfWeek: isoDow(), startsAt: '00:00', endsAt: '00:30' })
  return {
    id,
    admin,
    rao: { id: rao, role: 'faculty', institutionId: id } as Actor,
    sen: { id: sen, role: 'faculty', institutionId: id } as Actor,
    asha: { id: asha, role: 'student', institutionId: id } as Actor,
    bilal: { id: bilal, role: 'student', institutionId: id } as Actor,
    senId: sen,
    chenId: chen,
    offeringId: off.id,
    offeringB: offB.id,
    slotId: slot.id,
  }
}

const code = (e: unknown) => (e as AttendanceError).code

/** A class held: opened, Asha marked present where asked, closed. */
async function held(c: Awaited<ReturnType<typeof campus>>, ashaThere: boolean) {
  const s = await openSession(c.rao, { slotId: c.slotId })
  if (ashaThere) await override(c.rao, { sessionId: s.id, studentId: c.asha.id, reason: 'marked present in class' })
  await closeSession(c.rao, { sessionId: s.id })
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('classes needed to recover', () => {
  assert.equal(classesNeeded(2, 4, 75), 4)
  assert.equal(classesNeeded(3, 4, 75), 0)
  assert.equal(classesNeeded(0, 4, 75), 12)
  assert.equal(classesNeeded(0, 0, 75), 0)
})

test('present, excused and absent, by the institution’s rule for what counts', async () => {
  const c = await campus()
  for (const there of [true, true, false, false]) await held(c, there)

  let [asha] = await attendanceSummary(c.asha, c.asha.id)
  assert.deepEqual([asha!.held, asha!.present, asha!.excused, asha!.absent, asha!.percent], [4, 2, 0, 2, 50])
  assert.equal(asha!.short, true)
  assert.equal(asha!.needed, 4)

  // Asha was ill today: the two classes she missed are excused.
  await grantExcuse(c.rao, { studentId: c.asha.id, offeringId: c.offeringId, fromOn: today(), toOn: today(), kind: 'medical', reason: 'fever, doctor’s note seen' })
  ;[asha] = await attendanceSummary(c.asha, c.asha.id)
  assert.deepEqual([asha!.present, asha!.excused, asha!.absent, asha!.percent, asha!.short], [2, 2, 0, 100, false])
  assert.equal((await listExcuses(c.asha))[0]!.by, 'Dr Rao', 'who excused it, by name')

  // An institution where only attendance counts.
  await setAttendanceRules(c.admin, { minimumPercent: 75, excusedCounts: 'false' })
  ;[asha] = await attendanceSummary(c.asha, c.asha.id)
  assert.deepEqual([asha!.percent, asha!.short, asha!.needed], [50, true, 4])
  await setAttendanceRules(c.admin, { minimumPercent: 75, excusedCounts: 'true' })

  const [bilal] = await attendanceSummary(c.admin, c.bilal.id)
  assert.deepEqual([bilal!.present, bilal!.absent, bilal!.percent, bilal!.needed], [0, 4, 0, 12])
})

test('who may excuse what, and an excuse is only revoked', async () => {
  const c = await campus()
  await assert.rejects(
    grantExcuse(c.sen, { studentId: c.asha.id, offeringId: c.offeringId, fromOn: today(), toOn: today(), kind: 'medical', reason: 'not my class' }),
    (e) => code(e) === 'not_your_class',
  )
  await assert.rejects(
    grantExcuse(c.rao, { studentId: c.asha.id, fromOn: today(), toOn: today(), kind: 'on_duty', reason: 'every class, by a teacher' }),
    (e) => code(e) === 'forbidden',
  )
  await assert.rejects(
    grantExcuse(c.admin, { studentId: c.chenId, offeringId: c.offeringId, fromOn: today(), toOn: today(), kind: 'other', reason: 'not his class' }),
    (e) => code(e) === 'attendance_excuse_class',
  )
  const x = await grantExcuse(c.admin, { studentId: c.asha.id, fromOn: today(), toOn: today(), kind: 'on_duty', reason: 'represented the college at the hackathon' })
  assert.equal((await listExcuses(c.asha))[0]!.course, 'every class')
  assert.equal((await listExcuses(c.sen)).length, 0, 'not his classes')
  await revokeExcuse(c.admin, { excuseId: x.id, reason: 'she did not go after all' })
  await assert.rejects(
    withTenant(c.id, (tx) => tx.delete(excuses).where(eq(excuses.id, x.id))),
    (e) => String((e as { cause?: { constraint?: string } }).cause?.constraint) === 'attendance_excuse_kept',
  )
})

test('the absentees in a class, those short first, and who missed the last session', async () => {
  const c = await campus()
  await held(c, true)
  await held(c, false)
  const v = await classAbsentees(c.rao, c.offeringId)
  assert.deepEqual(v.students.map((s) => [s.name, s.percent]), [['Bilal', 0], ['Asha', 50]])
  assert.equal(v.short, 2)
  assert.deepEqual(v.lastSession!.missing, ['Asha', 'Bilal'])
  await assert.rejects(classAbsentees(c.sen, c.offeringId), (e) => code(e) === 'not_your_class')
})

test('a cancelled class cannot be opened; a substitute may open the one they take', async () => {
  const c = await campus()
  const a = c.admin as unknown as academic.Actor
  const cancel = await academic.changeClass(a, { slotId: c.slotId, onDate: today(), kind: 'cancelled', reason: 'Dr Rao at a conference' })
  await assert.rejects(openSession(c.rao, { slotId: c.slotId }), (e) => code(e) === 'class_cancelled')
  await academic.withdrawChange(a, { changeId: cancel.id, reason: 'came back early' })

  await assert.rejects(openSession(c.sen, { slotId: c.slotId }), (e) => code(e) === 'not_your_class')
  await academic.changeClass(a, { slotId: c.slotId, onDate: today(), kind: 'substitute', substituteId: c.senId, reason: 'Dr Rao on medical leave' })
  const s = await openSession(c.sen, { slotId: c.slotId })
  assert.ok(s.id, 'the substitute opens it')
})
