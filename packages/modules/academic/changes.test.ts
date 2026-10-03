import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import {
  AcademicError,
  addSectionMember,
  changeClass,
  createCourse,
  createDepartment,
  createOffering,
  createProgram,
  createRoom,
  createSection,
  createSlot,
  createTerm,
  weekView,
  withdrawChange,
  type Actor,
} from './api'
import { classChanges } from './schema'

/**
 * Adjusting one meeting of a class -- cancelled, moved, or taken by a
 * substitute -- with the database refusing a change to a day the class does
 * not meet, or one that double-books a room or a teacher.
 */

const SLUG = 'acad-change-'
let n = 0
const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: string, k: number) => iso(new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000))
/** The Monday on or after a week from now: always inside a term around today. */
function nextMonday() {
  const d = new Date(Date.now() + 7 * 86_400_000)
  const shift = (8 - d.getUTCDay()) % 7
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + shift)))
}

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Change College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Office' },
      { email: `rao@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Rao' },
      { email: `sen@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Sen' },
      { email: `das@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Das' },
      { email: `asha@${tag}.test`, institutionId: id, role: 'student', name: 'Asha' },
    ])
    .returning({ id: users.id })
  const [adm, rao, sen, das, asha] = people.map((p) => p.id) as [string, string, string, string, string]
  const admin: Actor = { id: adm, role: 'institution_admin', institutionId: id }
  const dept = await createDepartment(admin, { code: 'CSE', name: 'Computing' })
  const prog = await createProgram(admin, { departmentId: dept.id, code: 'BT', name: 'B.Tech', level: 'undergraduate', durationTerms: 8 })
  const today = iso(new Date())
  const term = await createTerm(admin, { code: `T${n}`, name: 'Autumn', startsOn: addDays(today, -30), endsOn: addDays(today, 90) })
  const r1 = await createRoom(admin, { code: `R1-${n}`, capacity: 60 })
  const r2 = await createRoom(admin, { code: `R2-${n}`, capacity: 60 })
  const ds = await createCourse(admin, { departmentId: dept.id, code: `DS${n}`, title: 'Data Structures', credits: 4 })
  const ps = await createCourse(admin, { departmentId: dept.id, code: `PS${n}`, title: 'Probability', credits: 3 })
  const ml = await createCourse(admin, { departmentId: dept.id, code: `ML${n}`, title: 'Machine Learning', credits: 4 })
  const sec = await createSection(admin, { programId: prog.id, label: 'A', admissionYear: 2025 })
  await addSectionMember(admin, { sectionId: sec.id, userId: asha })
  const offDs = await createOffering(admin, { termId: term.id, courseId: ds.id, sectionId: sec.id, facultyUserId: rao })
  const offPs = await createOffering(admin, { termId: term.id, courseId: ps.id, sectionId: sec.id, facultyUserId: sen })
  const offMl = await createOffering(admin, { termId: term.id, courseId: ml.id, sectionId: sec.id, facultyUserId: sen })
  // Data Structures, Mondays 09:00 in R1 (Dr Rao); Probability, Wednesdays 11:00 in R2 (Dr Sen);
  // Machine Learning, Mondays 14:00 in R2 (Dr Sen).
  const monDs = await createSlot(admin, { offeringId: offDs.id, roomId: r1.id, dayOfWeek: 1, startsAt: '09:00', endsAt: '10:00' })
  await createSlot(admin, { offeringId: offPs.id, roomId: r2.id, dayOfWeek: 3, startsAt: '11:00', endsAt: '12:00' })
  await createSlot(admin, { offeringId: offMl.id, roomId: r2.id, dayOfWeek: 1, startsAt: '14:00', endsAt: '15:00' })
  // And Probability again on Mondays, 09:30 in R2: Dr Sen is teaching then.
  await createSlot(admin, { offeringId: offPs.id, roomId: r2.id, dayOfWeek: 1, startsAt: '09:30', endsAt: '10:30' })
  return {
    id,
    admin,
    rao: { id: rao, role: 'faculty', institutionId: id } as Actor,
    sen: { id: sen, role: 'faculty', institutionId: id } as Actor,
    asha: { id: asha, role: 'student', institutionId: id } as Actor,
    raoId: rao,
    senId: sen,
    dasId: das,
    slot: monDs.id,
    r1: r1.id,
    r2: r2.id,
  }
}

const code = (e: unknown) => (e as AcademicError).code

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('a lecturer cancels one class; it shows on the week as cancelled, and the timetable stays', async () => {
  const c = await campus()
  const mon = nextMonday()
  await assert.rejects(changeClass(c.sen, { slotId: c.slot, onDate: mon, kind: 'cancelled', reason: 'not my class to cancel' }), (e) => code(e) === 'forbidden')
  await assert.rejects(
    changeClass(c.rao, { slotId: c.slot, onDate: addDays(mon, 1), kind: 'cancelled', reason: 'a Tuesday' }),
    (e) => code(e) === 'academic_class_change_day',
  )
  await assert.rejects(
    changeClass(c.rao, { slotId: c.slot, onDate: addDays(mon, 7 * 30), kind: 'cancelled', reason: 'next year' }),
    (e) => code(e) === 'academic_class_change_term',
  )
  const ch = await changeClass(c.rao, { slotId: c.slot, onDate: mon, kind: 'cancelled', reason: 'Dr Rao at a conference' })
  const week = await weekView(c.asha, mon)
  const ds = week.occurrences.find((o) => o.courseCode.startsWith('DS') && o.date === mon)!
  assert.equal(ds.status, 'cancelled')
  assert.match(ds.note!, /conference/)
  // The next week is as timetabled.
  const next = await weekView(c.asha, addDays(mon, 7))
  assert.equal(next.occurrences.find((o) => o.courseCode.startsWith('DS'))!.status, 'as_timetabled')

  await assert.rejects(
    changeClass(c.rao, { slotId: c.slot, onDate: mon, kind: 'cancelled', reason: 'twice over' }),
    (e) => code(e) === 'academic_class_changes_once',
  )
  await withdrawChange(c.rao, { changeId: ch.id, reason: 'the conference was postponed' })
  assert.equal((await weekView(c.asha, mon)).occurrences.find((o) => o.courseCode.startsWith('DS'))!.status, 'as_timetabled')
  await assert.rejects(
    withTenant(c.id, (tx) => tx.delete(classChanges).where(eq(classChanges.id, ch.id))),
    (e) => String((e as { cause?: { constraint?: string } }).cause?.constraint) === 'academic_class_change_kept',
  )
})

test('a moved class may not double-book a room or its teacher, and shows where it now meets', async () => {
  const c = await campus()
  const mon = nextMonday()
  const wed = addDays(mon, 2)
  // Wednesday 11:00 in R2 is Probability's.
  await assert.rejects(
    changeClass(c.rao, { slotId: c.slot, onDate: mon, kind: 'rescheduled', movedOn: wed, movedStarts: '11:30', movedEnds: '12:30', movedRoomId: c.r2, reason: 'lab clash' }),
    (e) => code(e) === 'academic_class_change_room_clash',
  )
  const moved = await changeClass(c.rao, {
    slotId: c.slot, onDate: mon, kind: 'rescheduled', movedOn: wed, movedStarts: '11:00', movedEnds: '12:00', movedRoomId: c.r1, reason: 'Monday is a holiday',
  })
  const week = await weekView(c.asha, mon)
  const ds = week.occurrences.filter((o) => o.courseCode.startsWith('DS'))
  assert.deepEqual(ds.map((o) => [o.date, o.status, o.room]), [[mon, 'moved_away', `R1-${n}`], [wed, 'moved_here', `R1-${n}`]])

  // Now R1 is taken on Wednesday 11:00 by the moved class: a second move into it is refused.
  await assert.rejects(
    changeClass(c.admin, {
      slotId: c.slot, onDate: addDays(mon, 7), kind: 'rescheduled', movedOn: wed, movedStarts: '11:15', movedEnds: '11:45', movedRoomId: c.r1, reason: 'a second move into the same hour',
    }),
    (e) => code(e) === 'academic_class_change_room_clash',
  )
  await withdrawChange(c.admin, { changeId: moved.id, reason: 'the holiday was cancelled' })
})

test('a substitute takes a class, unless they are teaching then', async () => {
  const c = await campus()
  const mon = nextMonday()
  await assert.rejects(
    changeClass(c.rao, { slotId: c.slot, onDate: mon, kind: 'substitute', substituteId: c.raoId, reason: 'myself' }),
    (e) => code(e) === 'academic_class_change_substitute',
  )
  // Dr Sen teaches Probability on Mondays at 09:30: he cannot take Data Structures at 09:00.
  await assert.rejects(
    changeClass(c.rao, { slotId: c.slot, onDate: mon, kind: 'substitute', substituteId: c.senId, reason: 'Dr Rao on medical leave' }),
    (e) => code(e) === 'academic_class_change_teacher_clash',
  )
  const sub = await changeClass(c.rao, { slotId: c.slot, onDate: mon, kind: 'substitute', substituteId: c.dasId, reason: 'Dr Rao on medical leave' })
  const das = { id: c.dasId, role: 'faculty', institutionId: c.id } as Actor
  const ds = (await weekView(das, mon)).occurrences.find((o) => o.courseCode.startsWith('DS'))!
  assert.equal(ds.status, 'substitute')
  assert.equal(ds.teacher, 'Dr Das', 'the substitute sees it on their own week')
  assert.equal((await weekView(das, addDays(mon, 7))).occurrences.length, 0, 'and only that week')
  await withdrawChange(c.rao, { changeId: sub.id, reason: 'recovered in time' })

  // Machine Learning holds R2 on Mondays from 14:00.
  await assert.rejects(
    changeClass(c.admin, {
      slotId: c.slot, onDate: addDays(mon, 14), kind: 'rescheduled', movedOn: addDays(mon, 14), movedStarts: '14:30', movedEnds: '15:30', movedRoomId: c.r2, reason: 'into Machine Learning’s room',
    }),
    (e) => code(e) === 'academic_class_change_room_clash',
  )
})
