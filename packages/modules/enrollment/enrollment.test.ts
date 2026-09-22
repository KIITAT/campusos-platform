import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import {
  addPrerequisite,
  createCourse,
  createDepartment,
  createOffering,
  createProgram,
  createSection,
  createTerm,
  recordCompletion,
  setTermCalendar,
  waivePrerequisite,
  type Actor as Academic,
} from '@campusos/module-academic/api'
import {
  creditLoad,
  drop,
  listRegistrationEvents,
  listRegistrations,
  listRoster,
  register,
  setOfferingLimit,
  type Actor,
} from './api'
import { registrationEvents } from './schema'

/**
 * Registration, which is where the calendar, the prerequisite chain and the
 * seat count all meet. A fresh institution per test: every one of these is
 * about a date or a count, and a shared fixture would make each failure a
 * question about which test ran first.
 */

let n = 0
const SLUG = 'enrol-'

const day = (offset: number) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

interface Campus {
  id: string
  admin: Actor
  faculty: Actor
  a: Actor
  b: Actor
  c: Actor
  deptId: string
  programId: string
  sectionId: string
}

const academic = (a: Actor): Academic => ({
  id: a.id,
  role: a.role,
  institutionId: a.institutionId,
})

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Registration College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `fac@${tag}.test`, institutionId: id, role: 'faculty', name: 'Lecturer' },
      { email: `a@${tag}.test`, institutionId: id, role: 'student', name: 'Aiyla Student' },
      { email: `b@${tag}.test`, institutionId: id, role: 'student', name: 'Bran Student' },
      { email: `c@${tag}.test`, institutionId: id, role: 'student', name: 'Cira Student' },
    ])
    .returning({ id: users.id })

  const admin: Actor = { id: people[0]!.id, role: 'institution_admin', institutionId: id }
  const dept = await createDepartment(academic(admin), { code: 'CSE', name: 'Computing' })
  const program = await createProgram(academic(admin), {
    departmentId: dept.id,
    code: 'BTCS',
    name: 'B.Tech Computing',
    level: 'undergraduate',
    durationTerms: 8,
  })
  const section = await createSection(academic(admin), {
    programId: program.id,
    label: 'A',
    admissionYear: 2025,
  })

  return {
    id,
    admin,
    faculty: { id: people[1]!.id, role: 'faculty', institutionId: id },
    a: { id: people[2]!.id, role: 'student', institutionId: id },
    b: { id: people[3]!.id, role: 'student', institutionId: id },
    c: { id: people[4]!.id, role: 'student', institutionId: id },
    deptId: dept.id,
    programId: program.id,
    sectionId: section.id,
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

/** A term whose calendar is open today, unless the caller says otherwise. */
async function term(
  c: Campus,
  calendar: {
    registrationOpensOn?: string | null
    registrationClosesOn?: string | null
    addDropEndsOn?: string | null
    withdrawEndsOn?: string | null
  } = {
    registrationOpensOn: day(-10),
    registrationClosesOn: day(10),
    addDropEndsOn: day(5),
    withdrawEndsOn: day(30),
  },
) {
  const t = await createTerm(academic(c.admin), {
    code: `T${++n}`,
    name: 'Autumn',
    startsOn: day(-30),
    endsOn: day(60),
  })
  if (Object.values(calendar).some((v) => v)) {
    await setTermCalendar(academic(c.admin), { termId: t.id, ...calendar })
  }
  return t
}

async function offering(c: Campus, termId: string, title = 'Algorithms', credits = 4) {
  const course = await createCourse(academic(c.admin), {
    departmentId: c.deptId,
    code: `C${++n}`,
    title,
    credits,
  })
  const o = await createOffering(academic(c.admin), {
    termId,
    courseId: course.id,
    sectionId: c.sectionId,
  })
  return { ...o, courseId: course.id, credits }
}

const errorCode = (e: unknown) => (e as { code?: string }).code

// --- the window ------------------------------------------------------------

test('a student registers while the window is open, and the credits show up', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)

  const r = await register(c.a, { offeringId: o.id })
  assert.equal(r.status, 'registered')
  assert.equal(r.credits, 4)

  const load = await creditLoad(c.a, { termId: t.id })
  assert.equal(load.credits, 4)
  assert.equal(load.courses, 1)
})

test('a window nobody set is closed, not open', async () => {
  const c = await campus()
  const t = await term(c, {})
  const o = await offering(c, t.id)

  await assert.rejects(
    () => register(c.a, { offeringId: o.id }),
    (e: unknown) => errorCode(e) === 'registration_closed',
  )

  // Staff can still act, and the event says why it was allowed.
  const r = await register(c.admin, { studentId: c.a.id, offeringId: o.id })
  assert.equal(r.status, 'registered')

  const events = await listRegistrationEvents(c.admin, { termId: t.id })
  assert.equal(events.length, 1)
  assert.match(String(events[0]!.reason), /outside the registration window/)
})

test('a window that has closed refuses a student and lets the registrar in', async () => {
  const c = await campus()
  const t = await term(c, {
    registrationOpensOn: day(-20),
    registrationClosesOn: day(-2),
    addDropEndsOn: day(5),
    withdrawEndsOn: day(30),
  })
  const o = await offering(c, t.id)

  await assert.rejects(
    () => register(c.a, { offeringId: o.id }),
    (e: unknown) => errorCode(e) === 'registration_closed',
  )
  await register(c.admin, { studentId: c.a.id, offeringId: o.id, reason: 'late admission' })
  assert.equal((await listRegistrations(c.a, {})).length, 1)
})

// --- the chain -------------------------------------------------------------

test('the prerequisite chain is asked, and it answers with what is missing', async () => {
  const c = await campus()
  const t = await term(c)
  const intro = await offering(c, t.id, 'Introduction to Computing')
  const algo = await offering(c, t.id, 'Algorithms')
  await addPrerequisite(academic(c.admin), {
    courseId: algo.courseId,
    requiresCourseId: intro.courseId,
  })

  await assert.rejects(
    () => register(c.a, { offeringId: algo.id }),
    (e: unknown) => errorCode(e) === 'prerequisites_unmet',
  )

  // Nobody gets past the chain here, registrar included: the way through is a
  // waiver in the academic core, which carries an approver and a reason.
  await assert.rejects(
    () => register(c.admin, { studentId: c.a.id, offeringId: algo.id }),
    (e: unknown) => errorCode(e) === 'prerequisites_unmet',
  )

  await waivePrerequisite(academic(c.admin), {
    studentId: c.a.id,
    courseId: algo.courseId,
    reason: 'passed the equivalent paper elsewhere',
  })
  const r = await register(c.a, { offeringId: algo.id })
  assert.equal(r.status, 'registered')
})

test('a pass on the record is what the chain actually wants', async () => {
  const c = await campus()
  const t = await term(c)
  const intro = await offering(c, t.id, 'Introduction to Computing')
  const algo = await offering(c, t.id, 'Algorithms')
  await addPrerequisite(academic(c.admin), {
    courseId: algo.courseId,
    requiresCourseId: intro.courseId,
  })
  await recordCompletion(academic(c.admin), {
    studentId: c.a.id,
    courseId: intro.courseId,
    termId: t.id,
    gradePoints: 7,
  })

  assert.equal((await register(c.a, { offeringId: algo.id })).status, 'registered')
})

// --- seats and the queue ---------------------------------------------------

test('the last seat goes once, and the next student joins the queue', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await setOfferingLimit(c.admin, { offeringId: o.id, capacity: 1, waitlistCapacity: 1 })

  assert.equal((await register(c.a, { offeringId: o.id })).status, 'registered')
  assert.equal((await register(c.b, { offeringId: o.id })).status, 'waitlisted')

  // One seat, one place in the queue, and the third student is told so.
  await assert.rejects(
    () => register(c.c, { offeringId: o.id }),
    (e: unknown) => errorCode(e) === 'full',
  )
})

test('no queue means full is full', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await setOfferingLimit(c.admin, { offeringId: o.id, capacity: 1 })

  await register(c.a, { offeringId: o.id })
  await assert.rejects(
    () => register(c.b, { offeringId: o.id }),
    (e: unknown) => errorCode(e) === 'full',
  )
})

test('an offering nobody capped takes everyone', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)

  for (const s of [c.a, c.b, c.c]) await register(s, { offeringId: o.id })
  const roster = await listRoster(c.admin, { offeringId: o.id })
  assert.equal(roster.filter((r) => r.status === 'registered').length, 3)
})

test('a seat that comes free goes to the longest wait', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await setOfferingLimit(c.admin, { offeringId: o.id, capacity: 1, waitlistCapacity: 5 })

  await register(c.a, { offeringId: o.id })
  await register(c.b, { offeringId: o.id })
  await register(c.c, { offeringId: o.id })

  const queue = await listRoster(c.admin, { offeringId: o.id })
  const waiting = queue.filter((r) => r.status === 'waitlisted')
  assert.deepEqual(
    waiting.map((r) => r.place),
    [1, 2],
  )
  assert.equal(waiting[0]!.studentId, c.b.id)

  const gone = await drop(c.a, { offeringId: o.id })
  assert.equal(gone.promoted, c.b.id)

  const after = await listRoster(c.admin, { offeringId: o.id })
  assert.equal(after.find((r) => r.studentId === c.b.id)!.status, 'registered')
  assert.equal(after.find((r) => r.studentId === c.c.id)!.place, 1)
})

test('three students pressing Register on the last seat sell it once', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await setOfferingLimit(c.admin, { offeringId: o.id, capacity: 1 })

  // The count read before the insert is the same count for all three. What
  // separates them is the lock the trigger takes on the limits row.
  const tried = await Promise.allSettled(
    [c.a, c.b, c.c].map((s) => register(s, { offeringId: o.id })),
  )
  assert.equal(tried.filter((r) => r.status === 'fulfilled').length, 1)

  const roster = await listRoster(c.admin, { offeringId: o.id })
  assert.equal(roster.filter((r) => r.status === 'registered').length, 1)
})

test('a cap cannot be lowered below the students already sitting in it', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await setOfferingLimit(c.admin, { offeringId: o.id, capacity: 3 })
  await register(c.a, { offeringId: o.id })
  await register(c.b, { offeringId: o.id })

  // Two are seated; a cap of one would have to throw somebody out, so the
  // registrar is told rather than the roster quietly disagreeing with the cap.
  await assert.rejects(
    () => setOfferingLimit(c.admin, { offeringId: o.id, capacity: 1 }),
    (e: unknown) => errorCode(e) === 'invalid',
  )
  assert.equal((await setOfferingLimit(c.admin, { offeringId: o.id, capacity: 2 })).capacity, 2)
})

// --- leaving ---------------------------------------------------------------

test('inside add/drop a course leaves no mark', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await register(c.a, { offeringId: o.id })

  const gone = await drop(c.a, { offeringId: o.id, reason: 'clashes with a laboratory' })
  assert.equal(gone.status, 'dropped')
  assert.equal(gone.endedOn, day(0))
  assert.equal((await creditLoad(c.a, { termId: t.id })).credits, 0)
})

test('after add/drop the same act is a withdrawal, and the record says so', async () => {
  const c = await campus()
  const t = await term(c, {
    registrationOpensOn: day(-40),
    registrationClosesOn: day(-20),
    addDropEndsOn: day(-10),
    withdrawEndsOn: day(10),
  })
  const o = await offering(c, t.id)
  await register(c.admin, { studentId: c.a.id, offeringId: o.id })

  const gone = await drop(c.a, { offeringId: o.id })
  assert.equal(gone.status, 'withdrawn')

  const events = await listRegistrationEvents(c.admin, { termId: t.id })
  assert.deepEqual(
    events.map((e) => e.kind),
    ['withdrawn', 'registered'],
  )
})

test('after the withdrawal deadline there is no door left', async () => {
  const c = await campus()
  const t = await term(c, {
    registrationOpensOn: day(-40),
    registrationClosesOn: day(-30),
    addDropEndsOn: day(-20),
    withdrawEndsOn: day(-5),
  })
  const o = await offering(c, t.id)
  await register(c.admin, { studentId: c.a.id, offeringId: o.id })

  await assert.rejects(
    () => drop(c.a, { offeringId: o.id }),
    (e: unknown) => errorCode(e) === 'too_late',
  )
})

test('leaving a queue is never a withdrawal', async () => {
  const c = await campus()
  const t = await term(c, {
    registrationOpensOn: day(-40),
    registrationClosesOn: day(10),
    addDropEndsOn: day(-10),
    withdrawEndsOn: day(10),
  })
  const o = await offering(c, t.id)
  await setOfferingLimit(c.admin, { offeringId: o.id, capacity: 1, waitlistCapacity: 2 })
  await register(c.a, { offeringId: o.id })
  await register(c.b, { offeringId: o.id })

  // Nothing was ever attended, so there is nothing for a transcript to say.
  const gone = await drop(c.b, { offeringId: o.id })
  assert.equal(gone.status, 'dropped')
})

test('a registrar enters last week’s drop slip with last week’s date', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await register(c.a, { offeringId: o.id })

  const gone = await drop(c.admin, {
    studentId: c.a.id,
    offeringId: o.id,
    effectiveOn: day(-3),
    reason: 'paper slip dated last Friday',
  })
  assert.equal(gone.endedOn, day(-3))

  // Ordered by the date each counts from, so the backdated drop sorts behind
  // the registration it undoes -- which is exactly how a bursar reads them.
  const events = await listRegistrationEvents(c.admin, { termId: t.id })
  assert.deepEqual(
    events.map((e) => e.kind),
    ['registered', 'dropped'],
  )
  assert.equal(events.find((e) => e.kind === 'dropped')!.effectiveOn, day(-3))
})

test('a student cannot backdate their own drop', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await register(c.a, { offeringId: o.id })

  const gone = await drop(c.a, { offeringId: o.id, effectiveOn: day(-9) })
  assert.equal(gone.endedOn, day(0))
})

test('dropping and coming back is one registration, with both moves on the record', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)

  const first = await register(c.a, { offeringId: o.id })
  await drop(c.a, { offeringId: o.id })
  const again = await register(c.a, { offeringId: o.id })

  assert.equal(again.id, first.id)
  assert.equal(again.status, 'registered')
  assert.equal(again.endedOn, null)

  const events = await listRegistrationEvents(c.admin, { termId: t.id })
  assert.equal(events.length, 3)
  assert.equal((await listRegistrations(c.a, {})).length, 1)
})

test('registering twice is refused', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await register(c.a, { offeringId: o.id })

  await assert.rejects(
    () => register(c.a, { offeringId: o.id }),
    (e: unknown) => errorCode(e) === 'already_registered',
  )
})

test('only a student registers for a course', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)

  await assert.rejects(
    () => register(c.admin, { studentId: c.faculty.id, offeringId: o.id }),
    (e: unknown) => errorCode(e) === 'not_a_student',
  )
})

// --- what happened stays happened ------------------------------------------

test('an add/drop event cannot be edited or deleted afterwards', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await register(c.a, { offeringId: o.id })
  const [event] = await listRegistrationEvents(c.admin, { termId: t.id })

  // A refund is prorated against that date, so a correction is a new event.
  await assert.rejects(() =>
    withTenant(c.id, (tx) =>
      tx
        .update(registrationEvents)
        .set({ effectiveOn: day(-30) })
        .where(eq(registrationEvents.id, event!.id)),
    ),
  )
  await assert.rejects(() =>
    withTenant(c.id, (tx) =>
      tx.delete(registrationEvents).where(eq(registrationEvents.id, event!.id)),
    ),
  )
})

// --- who may ask what ------------------------------------------------------

test('a student registers themselves and nobody else', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)

  await assert.rejects(
    () => register(c.a, { studentId: c.b.id, offeringId: o.id }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
  await assert.rejects(
    () => listRegistrations(c.a, { studentId: c.b.id }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
  await assert.rejects(
    () => listRoster(c.a, { offeringId: o.id }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
})

test('a lecturer reads the roster and registers nobody', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await register(c.a, { offeringId: o.id })

  assert.equal((await listRoster(c.faculty, { offeringId: o.id })).length, 1)
  await assert.rejects(
    () => register(c.faculty, { studentId: c.b.id, offeringId: o.id }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
})

test('another institution can neither see this one nor register into it', async () => {
  const one = await campus()
  const two = await campus()
  const t = await term(one)
  const o = await offering(one, t.id)
  await register(one.a, { offeringId: o.id })

  // RLS, not a WHERE clause: two's admin is inside two's transaction
  // throughout, so one's offering does not exist as far as this query is
  // concerned -- an empty roster rather than somebody else's.
  assert.equal((await listRoster(two.admin, { offeringId: o.id })).length, 0)
  await assert.rejects(
    () => register(two.admin, { studentId: one.a.id, offeringId: o.id }),
    (e: unknown) => errorCode(e) === 'no_such_user',
  )
  assert.equal((await listRegistrationEvents(two.admin, { termId: t.id })).length, 0)
})

// --- what the bursar will read ---------------------------------------------

test('the term’s events carry the dates a refund would be prorated against', async () => {
  const c = await campus()
  const t = await term(c)
  const one = await offering(c, t.id, 'Algorithms', 4)
  const two = await offering(c, t.id, 'Databases', 3)

  await register(c.a, { offeringId: one.id })
  await register(c.a, { offeringId: two.id })
  await drop(c.admin, { studentId: c.a.id, offeringId: two.id, effectiveOn: day(-1) })

  const events = await listRegistrationEvents(c.admin, { termId: t.id, studentId: c.a.id })
  assert.equal(events.length, 3)

  const dropped = events.find((e) => e.kind === 'dropped')!
  assert.equal(dropped.credits, 3)
  assert.equal(dropped.effectiveOn, day(-1))

  // And the load is what is still being carried, not what was ever registered.
  assert.equal((await creditLoad(c.admin, { studentId: c.a.id, termId: t.id })).credits, 4)
})

test('a waitlisted course is a hope, not a credit load', async () => {
  const c = await campus()
  const t = await term(c)
  const o = await offering(c, t.id)
  await setOfferingLimit(c.admin, { offeringId: o.id, capacity: 1, waitlistCapacity: 2 })
  await register(c.a, { offeringId: o.id })
  await register(c.b, { offeringId: o.id })

  assert.equal((await creditLoad(c.b, { termId: t.id })).credits, 0)
  assert.equal((await creditLoad(c.a, { termId: t.id })).credits, 4)
})
