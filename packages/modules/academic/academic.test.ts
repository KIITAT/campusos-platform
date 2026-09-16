import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
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
  setCurrentTerm,
  type Actor,
} from './api'
import { departments, sectionMembers } from './schema'

const SLUGS = ['acad-a', 'acad-b']
let instA: string
let instB: string

const admin = (institutionId = instA): Actor => ({
  id: 'admin-user',
  role: 'institution_admin',
  institutionId,
})

// ids created in before(), reused across tests
const ids = {
  dept: '',
  program: '',
  course: '',
  course2: '',
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
    ])
    .returning({ id: users.id, email: users.email })
  ids.student = people[0]!.id
  ids.otherStudent = people[3]!.id
  ids.faculty = people[2]!.id
  const secondStudent = people[1]!.id

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
