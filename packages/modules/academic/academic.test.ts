import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, gte, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant, withTenantBatch } from '@campusos/db'
import {
  AcademicError,
  addSectionMember,
  createCourse,
  createDepartment,
  createOffering,
  createProgram,
  createRoom,
  createSection,
  createSlot,
  createTerm,
  getTimetable,
  listStructure,
  setClassTeacher,
  setCurrentTerm,
  setDepartmentHead,
  setTermCalendar,
  type Actor,
} from './api'
import { departments, offerings, rooms, sectionMembers } from './schema'

const SLUGS = ['acad-a', 'acad-b']
let instA: string
let instB: string

// Real rows: the audit trail's actor is a foreign key to users.
let adminA = ''
let adminB = ''
const admin = (institutionId = instA): Actor => ({
  id: institutionId === instA ? adminA : adminB,
  email: institutionId === instA ? 'adm@acad-a.test' : 'adm@acad-b.test',
  role: 'institution_admin',
  institutionId,
})

// ids created in before(), reused across tests
const ids = {
  dept: '',
  program: '',
  course: '',
  course2: '',
  course3: '',
  room: '',
  room2: '',
  term: '',
  section: '',
  offering: '',
  student: '',
  otherStudent: '',
  faculty: '',
}

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: 'acad-a', name: 'Acad A', allowedEmailDomains: ['acad-a.test'] },
      { slug: 'acad-b', name: 'Acad B', allowedEmailDomains: ['acad-b.test'] },
    ])
    .returning({ id: institutions.id })
  instA = rows[0]!.id
  instB = rows[1]!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 's1@acad-a.test', institutionId: instA, role: 'student' },
      { email: 's2@acad-a.test', institutionId: instA, role: 'student' },
      { email: 'f1@acad-a.test', institutionId: instA, role: 'faculty' },
      { email: 's9@acad-b.test', institutionId: instB, role: 'student' },
      { email: 'adm@acad-a.test', institutionId: instA, role: 'institution_admin' },
      { email: 'adm@acad-b.test', institutionId: instB, role: 'institution_admin' },
      { email: 'hod@acad-a.test', institutionId: instA, role: 'hod' },
    ])
    .returning({ id: users.id, email: users.email })
  ids.student = people[0]!.id
  ids.otherStudent = people[3]!.id
  ids.faculty = people[2]!.id
  const secondStudent = people[1]!.id
  adminA = people[4]!.id
  adminB = people[5]!.id

  ids.dept = (await createDepartment(admin(), { code: 'cse', name: 'Computer Science' })).id
  ids.program = (
    await createProgram(admin(), {
      departmentId: ids.dept,
      code: 'btech-cse',
      name: 'BTech CSE',
      level: 'undergraduate',
      durationTerms: 8,
    })
  ).id
  ids.course = (
    await createCourse(admin(), {
      departmentId: ids.dept,
      code: 'cs301',
      title: 'Operating Systems',
      credits: 4,
    })
  ).id
  ids.course2 = (
    await createCourse(admin(), {
      departmentId: ids.dept,
      code: 'cs302',
      title: 'Databases',
      credits: 3,
    })
  ).id
  ids.course3 = (
    await createCourse(admin(), {
      departmentId: ids.dept,
      code: 'cs303',
      title: 'Networks',
      credits: 3,
    })
  ).id
  ids.room = (await createRoom(admin(), { code: 'lt-1' })).id
  ids.room2 = (await createRoom(admin(), { code: 'lt-2' })).id
  ids.term = (
    await createTerm(admin(), {
      code: '2026-odd',
      name: 'Odd 2026',
      startsOn: '2026-07-01',
      endsOn: '2026-12-15',
    })
  ).id
  ids.section = (
    await createSection(admin(), { programId: ids.program, label: 'a', admissionYear: 2026 })
  ).id
  ids.offering = (
    await createOffering(admin(), {
      termId: ids.term,
      courseId: ids.course,
      sectionId: ids.section,
      facultyUserId: ids.faculty,
    })
  ).id

  await addSectionMember(admin(), { sectionId: ids.section, userId: ids.student })
  await addSectionMember(admin(), { sectionId: ids.section, userId: secondStudent })
  await setCurrentTerm(admin(), { termId: ids.term })
})

after(async () => {
  for (const s of SLUGS) {
    await authDb.delete(institutions).where(eq(institutions.slug, s))
  }
})

// --- authorisation ---------------------------------------------------------

test('structural writes are refused to everyone below institution_admin', async () => {
  for (const role of ['hod', 'faculty', 'student', 'accounts_staff', 'pending'] as const) {
    await assert.rejects(
      () => createDepartment({ id: 'x', role, institutionId: instA }, { code: 'x', name: 'X' }),
      (e: unknown) => e instanceof AcademicError && e.status === 403,
      role,
    )
  }
})

test('an HOD can read the structure but not write it', async () => {
  const s = await listStructure({ id: 'h', role: 'hod', institutionId: instA })
  assert.ok(s.departments.length > 0)
})

test('a session with no institution cannot read or write', async () => {
  await assert.rejects(
    () => listStructure({ id: 'x', role: 'institution_admin', institutionId: null }),
    (e: unknown) => e instanceof AcademicError && e.code === 'no_institution',
  )
})

// --- tenant isolation ------------------------------------------------------

test('another institution cannot see these departments', async () => {
  const s = await listStructure(admin(instB))
  assert.deepEqual(s.departments, [])
  assert.deepEqual(s.courses, [])
})

test('a department is invisible outside its tenant even by direct query', async () => {
  const rows = await withTenant(instB, (tx) =>
    tx.select().from(departments).where(eq(departments.id, ids.dept)),
  )
  assert.deepEqual(rows, [])
})

test('a student from another institution cannot be enrolled', async () => {
  // RLS makes the other tenant's user non-existent inside this transaction, so
  // the id resolves to nothing rather than to a cross-tenant enrolment.
  await assert.rejects(
    () => addSectionMember(admin(), { sectionId: ids.section, userId: ids.otherStudent }),
    (e: unknown) => e instanceof AcademicError && e.code === 'no_such_user',
  )
  const rows = await withTenant(instA, (tx) =>
    tx.select().from(sectionMembers).where(eq(sectionMembers.userId, ids.otherStudent)),
  )
  assert.deepEqual(rows, [])
})

test('only students join a cohort', async () => {
  await assert.rejects(
    () => addSectionMember(admin(), { sectionId: ids.section, userId: ids.faculty }),
    (e: unknown) => e instanceof AcademicError && e.code === 'not_a_student',
  )
})

// --- constraints -----------------------------------------------------------

test('a duplicate code is refused', async () => {
  await assert.rejects(
    () => createDepartment(admin(), { code: 'CSE', name: 'Again' }),
    (e: unknown) => e instanceof AcademicError && e.status === 409,
  )
})

test('the same code is free in another institution', async () => {
  const row = await createDepartment(admin(instB), { code: 'cse', name: 'Their CSE' })
  assert.equal(row.code, 'CSE')
})

test('a term ending before it starts is refused', async () => {
  await assert.rejects(() =>
    createTerm(admin(), {
      code: 'bad',
      name: 'Bad',
      startsOn: '2026-12-01',
      endsOn: '2026-07-01',
    }),
  )
})

test('at most one term is current per institution', async () => {
  const second = await createTerm(admin(), {
    code: '2027-even',
    name: 'Even 2027',
    startsOn: '2027-01-05',
    endsOn: '2027-05-30',
  })
  await setCurrentTerm(admin(), { termId: second.id })

  const s = await listStructure(admin())
  assert.deepEqual(
    s.terms.filter((t) => t.isCurrent).map((t) => t.code),
    ['2027-EVEN'],
  )

  await setCurrentTerm(admin(), { termId: ids.term }) // restore
})

test('the same course cannot be offered twice to one cohort in one term', async () => {
  await assert.rejects(
    () =>
      createOffering(admin(), {
        termId: ids.term,
        courseId: ids.course,
        sectionId: ids.section,
      }),
    (e: unknown) => e instanceof AcademicError && e.status === 409,
  )
})

// --- timetable clashes -----------------------------------------------------

test('a valid slot is accepted', async () => {
  const slot = await createSlot(admin(), {
    offeringId: ids.offering,
    roomId: ids.room,
    dayOfWeek: 1,
    startsAt: '09:00',
    endsAt: '10:00',
  })
  assert.equal(slot.dayOfWeek, 1)
})

test('an adjacent slot in the same room is fine -- ranges are half-open', async () => {
  const slot = await createSlot(admin(), {
    offeringId: ids.offering,
    roomId: ids.room,
    dayOfWeek: 1,
    startsAt: '10:00',
    endsAt: '11:00',
  })
  assert.ok(slot.id)
})

test('an overlapping slot in the same room is refused by the database', async () => {
  await assert.rejects(
    () =>
      createSlot(admin(), {
        offeringId: ids.offering,
        roomId: ids.room,
        dayOfWeek: 1,
        startsAt: '09:30',
        endsAt: '10:30',
      }),
    (e: unknown) => e instanceof AcademicError && e.code === 'clash',
  )
})

test('the same room is free on a different weekday', async () => {
  const slot = await createSlot(admin(), {
    offeringId: ids.offering,
    roomId: ids.room,
    dayOfWeek: 2,
    startsAt: '09:00',
    endsAt: '10:00',
  })
  assert.equal(slot.dayOfWeek, 2)
})

test('a lecturer cannot be booked into two rooms at once', async () => {
  // Different room, so the exclusion constraint does not fire -- this is the
  // faculty trigger's job.
  const other = await createOffering(admin(), {
    termId: ids.term,
    courseId: ids.course2,
    sectionId: ids.section,
    facultyUserId: ids.faculty,
  })
  await assert.rejects(
    () =>
      createSlot(admin(), {
        offeringId: other.id,
        roomId: ids.room2,
        dayOfWeek: 1,
        startsAt: '09:15',
        endsAt: '10:15',
      }),
    (e: unknown) => e instanceof AcademicError && e.code === 'clash',
  )
})

test('next term, the same room and lecturer at the same hour are free again', async () => {
  // Monday 09:00 in this room, taught by this lecturer, is taken in 2026-ODD.
  // The even term does not overlap it, so the same hour is not a clash.
  const s = await listStructure(admin())
  const even = s.terms.find((t) => t.code === '2027-EVEN')!
  const next = await createOffering(admin(), {
    termId: even.id,
    courseId: ids.course,
    sectionId: ids.section,
    facultyUserId: ids.faculty,
  })
  const slot = await createSlot(admin(), {
    offeringId: next.id,
    roomId: ids.room,
    dayOfWeek: 1,
    startsAt: '09:00',
    endsAt: '10:00',
  })
  assert.equal(slot.dayOfWeek, 1)
})

test('handing a class to a lecturer who is teaching at that hour is refused', async () => {
  // An unstaffed class on Monday at 09:30 in the second room: no clash yet.
  const spare = await createOffering(admin(), { termId: ids.term, courseId: ids.course3, sectionId: ids.section })
  await createSlot(admin(), { offeringId: spare.id, roomId: ids.room2, dayOfWeek: 1, startsAt: '09:30', endsAt: '10:30' })
  // The lecturer already teaches Monday 09:00-10:00: they cannot take it.
  await assert.rejects(
    () =>
      withTenant(instA, (tx) =>
        tx.update(offerings).set({ facultyUserId: ids.faculty }).where(eq(offerings.id, spare.id)),
      ),
    (e: unknown) => /already booked when this class meets/.test(String((e as { cause?: Error }).cause?.message)),
  )
})

test('a backwards slot is refused', async () => {
  await assert.rejects(() =>
    createSlot(admin(), {
      offeringId: ids.offering,
      roomId: ids.room2,
      dayOfWeek: 3,
      startsAt: '11:00',
      endsAt: '10:00',
    }),
  )
})

// --- timetable scoping -----------------------------------------------------

test('an admin sees the whole institution timetable for the current term', async () => {
  const t = await getTimetable(admin())
  assert.equal(t.termCode, '2026-ODD')
  assert.ok(t.entries.length >= 3)
  assert.ok(t.entries.every((e) => e.courseCode.startsWith('CS')))
})

test('a student sees only the cohorts they belong to', async () => {
  const mine = await getTimetable({ id: ids.student, role: 'student', institutionId: instA })
  assert.ok(mine.entries.length >= 3)

  const stranger = await getTimetable({
    id: 'not-enrolled',
    role: 'student',
    institutionId: instA,
  })
  assert.deepEqual(stranger.entries, [])
})

test('a lecturer sees what they teach', async () => {
  const theirs = await getTimetable({
    id: ids.faculty,
    role: 'faculty',
    institutionId: instA,
  })
  assert.ok(theirs.entries.length >= 3)

  const other = await getTimetable({ id: 'no-classes', role: 'faculty', institutionId: instA })
  assert.deepEqual(other.entries, [])
})

test('entries are ordered by day then time', async () => {
  const t = await getTimetable(admin())
  const keys = t.entries.map((e) => `${e.dayOfWeek}${e.startsAt}`)
  assert.deepEqual(keys, [...keys].sort())
})

test('no current term yields an empty timetable rather than an error', async () => {
  const t = await getTimetable(admin(instB))
  assert.deepEqual(t, { termCode: null, entries: [] })
})

// --- structural audit (AUD-06) ----------------------------------------------

const watermark = async () =>
  new Date(Math.floor(Number((await authDb.execute<{ ms: string }>(sql`select extract(epoch from clock_timestamp()) * 1000 as ms`)).rows[0]!.ms)))
const trailOf = (inst: string, since: Date) =>
  withTenant(inst, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.moduleId, 'academic'), gte(auditLog.at, since)))
      .orderBy(auditLog.at),
  )
const only = (rows: Awaited<ReturnType<typeof trailOf>>, action: string) => {
  const hit = rows.filter((r) => r.action === action)
  assert.equal(hit.length, 1, `${action} x${hit.length}`)
  return hit[0]!
}

test('academic structure and cohort mutations are audited', async () => {
  const since = await watermark()
  const a = admin()
  const dept = await createDepartment(a, { code: 'ev-d', name: 'Evidence' })
  const prog = await createProgram(a, { departmentId: dept.id, code: 'ev-p', name: 'EvP', level: 'undergraduate', durationTerms: 6 })
  const course = await createCourse(a, { departmentId: dept.id, code: 'ev-c', title: 'EvC', credits: 2 })
  const room = await createRoom(a, { code: 'ev-r', capacity: 30 })
  const term = await createTerm(a, { code: 'ev-t', name: 'EvT', startsOn: '2027-01-01', endsOn: '2027-06-01' })
  await setTermCalendar(a, { termId: term.id, registrationOpensOn: '2027-01-02', registrationClosesOn: '2027-01-20' })
  await setCurrentTerm(a, { termId: term.id })
  const section = await createSection(a, { programId: prog.id, label: 'ev', admissionYear: 2027 })
  await setDepartmentHead(a, { departmentId: dept.id, email: 'hod@acad-a.test' })
  await setDepartmentHead(a, { departmentId: dept.id })
  await setClassTeacher(a, { sectionId: section.id, email: 'f1@acad-a.test' })
  await setClassTeacher(a, { sectionId: section.id })
  await addSectionMember(a, { sectionId: section.id, userId: ids.student })
  await addSectionMember(a, { sectionId: section.id, userId: ids.student })
  const offering = await createOffering(a, { termId: term.id, courseId: course.id, sectionId: section.id, facultyUserId: ids.faculty })
  const slot = await createSlot(a, { offeringId: offering.id, roomId: room.id, dayOfWeek: 2, startsAt: '10:00', endsAt: '11:00' })

  const t = await trailOf(instA, since)
  assert.deepEqual(
    t.map((r) => r.action),
    [
      'department.created', 'programme.created', 'course.created', 'room.created', 'term.created', 'term.calendar_set',
      'term.current_set', 'section.created', 'department.head_set', 'department.head_set', 'section.teacher_set',
      'section.teacher_set', 'section.member_added', 'offering.created', 'slot.created',
    ],
  )
  for (const r of t) {
    assert.equal(r.actorId, adminA)
    assert.equal(r.actorEmail, 'adm@acad-a.test')
  }
  assert.deepEqual(only(t, 'department.created').detail, { code: 'EV-D' })
  assert.equal(only(t, 'department.created').entityId, dept.id)
  assert.equal(only(t, 'programme.created').entity, 'academic_programs')
  assert.deepEqual(only(t, 'programme.created').detail, { departmentId: dept.id, code: 'EV-P', level: 'undergraduate', durationTerms: 6 })
  assert.deepEqual(only(t, 'course.created').detail, { departmentId: dept.id, code: 'EV-C', credits: 2 })
  assert.deepEqual(only(t, 'room.created').detail, { code: 'EV-R', capacity: 30 })
  assert.deepEqual(only(t, 'term.created').detail, { code: 'EV-T', startsOn: '2027-01-01', endsOn: '2027-06-01' })
  assert.equal(only(t, 'term.calendar_set').reason, 'Set term registration calendar')
  assert.deepEqual(only(t, 'term.current_set').detail, { previousTermId: ids.term, currentTermId: term.id })
  assert.deepEqual(only(t, 'section.created').detail, { programId: prog.id, admissionYear: 2027, label: 'EV' })
  const heads = t.filter((r) => r.action === 'department.head_set').map((r) => (r.detail as { hodUserId: string | null }).hodUserId)
  assert.equal(heads[0], (await authDb.select({ id: users.id }).from(users).where(eq(users.email, 'hod@acad-a.test')))[0]!.id)
  assert.equal(heads[1], null)
  const teachers = t.filter((r) => r.action === 'section.teacher_set').map((r) => (r.detail as { classTeacherId: string | null }).classTeacherId)
  assert.deepEqual(teachers, [ids.faculty, null])
  const member = only(t, 'section.member_added')
  assert.equal(member.entityId, section.id)
  assert.equal(member.entity, 'academic_sections')
  assert.deepEqual(member.detail, { studentId: ids.student })
  assert.deepEqual(only(t, 'offering.created').detail, { termId: term.id, courseId: course.id, sectionId: section.id, facultyUserId: ids.faculty })
  assert.deepEqual(only(t, 'slot.created').detail, { offeringId: offering.id, roomId: room.id, dayOfWeek: 2, startsAt: '10:00:00', endsAt: '11:00:00' })
  assert.equal(only(t, 'slot.created').entityId, slot.id)

  // A student cannot create a department; nothing is written.
  const before = (await trailOf(instA, since)).length
  await assert.rejects(
    () => createDepartment({ id: ids.student, role: 'student', institutionId: instA }, { code: 'nope', name: 'No' }),
    (e: unknown) => e instanceof AcademicError && e.status === 403,
  )
  assert.equal((await trailOf(instA, since)).length, before)
  assert.deepEqual(await withTenant(instA, (tx) => tx.select().from(departments).where(eq(departments.code, 'nope'))), [])

  // B's section with A's student: refused, no row, no event.
  const bDept = await createDepartment(admin(instB), { code: 'b-d', name: 'B' })
  const bProg = await createProgram(admin(instB), { departmentId: bDept.id, code: 'b-p', name: 'BP', level: 'undergraduate', durationTerms: 4 })
  const bSection = await createSection(admin(instB), { programId: bProg.id, label: 'b', admissionYear: 2027 })
  const mark = await watermark()
  await assert.rejects(
    () => addSectionMember(admin(), { sectionId: bSection.id, userId: ids.student }),
    (e: unknown) => e instanceof AcademicError && e.code === 'no_such_section',
  )
  assert.deepEqual(await trailOf(instA, mark), [])
  assert.deepEqual(await withTenant(instB, (tx) => tx.select().from(sectionMembers).where(eq(sectionMembers.sectionId, bSection.id))), [])

  // The event rolls back with its write.
  const mark2 = await watermark()
  await assert.rejects(() =>
    withTenantBatch(instA, async (step) => {
      await step(() => createRoom(admin(), { code: 'ev-rollback' }))
      throw new Error('sentinel')
    }),
  )
  assert.deepEqual(await withTenant(instA, (tx) => tx.select().from(rooms).where(eq(rooms.code, 'ev-rollback'))), [])
  assert.deepEqual(await trailOf(instA, mark2), [])
})
