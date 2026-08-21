import './env'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { institutions, users } from './schema'
import * as academic from '../../modules/academic/schema'

// Known-good local state. Idempotent, so re-running is harmless.
// Owns its own connection because it must run as the owner role: the tenant
// tables are RLS-protected and the app role cannot write without
// app.institution_id set.
const db = drizzle(new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL }))

const email = process.env.SUPER_ADMIN_EMAILS?.split(',')[0]?.trim() || 'you@example.com'
const domain = email.split('@')[1]
if (!domain) throw new Error(`SUPER_ADMIN_EMAILS: "${email}" is not an email address`)

const [demo] = await db
  .insert(institutions)
  .values({ slug: 'demo', name: 'Demo College', allowedEmailDomains: [domain] })
  .onConflictDoUpdate({
    target: institutions.slug,
    set: { name: 'Demo College', allowedEmailDomains: [domain] },
  })
  .returning()
if (!demo) throw new Error('seed: institution upsert returned no row')

await db
  .insert(users)
  .values({ institutionId: demo.id, email, role: 'super_admin' })
  .onConflictDoUpdate({
    target: users.email,
    set: { institutionId: demo.id, role: 'super_admin' },
  })

// --- academic demo data ----------------------------------------------------
// Enough for the timetable to render something on a fresh checkout. Every
// insert is keyed on its own unique index, so re-seeding is a no-op.

const tenant = { institutionId: demo.id }

const one = <T extends { id: string }>(rows: T[], what: string): T => {
  const row = rows[0]
  if (!row) throw new Error(`seed: ${what} returned no row`)
  return row
}

/**
 * Demo users are keyed on a fixed id, not on their email address. Real users
 * get an adapter-generated uuid, so `seed:` can never collide with one -- and
 * re-seeding after SUPER_ADMIN_EMAILS changes domain then updates these rows
 * instead of leaving the previous domain's pair behind.
 */
const demoUser = async (
  key: string,
  role: 'faculty' | 'student',
  name: string,
) => {
  const [row] = await db
    .insert(users)
    .values({
      id: `seed:${key}`,
      institutionId: demo.id,
      email: `${key}@${domain}`,
      role,
      name,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { institutionId: demo.id, email: `${key}@${domain}`, role, name },
    })
    .returning({ id: users.id })
  if (!row) throw new Error(`seed: ${key} upsert returned no row`)
  return row
}

const lecturer = await demoUser('lecturer', 'faculty', 'A. Lecturer')
const student = await demoUser('student', 'student', 'S. Student')

const dept = one(
  await db
    .insert(academic.departments)
    .values({ ...tenant, code: 'CSE', name: 'Computer Science & Engineering' })
    .onConflictDoUpdate({
      target: [academic.departments.institutionId, academic.departments.code],
      set: { name: 'Computer Science & Engineering' },
    })
    .returning(),
  'department',
)

const program = one(
  await db
    .insert(academic.programs)
    .values({
      ...tenant,
      departmentId: dept.id,
      code: 'BTECH-CSE',
      name: 'B.Tech Computer Science',
      level: 'undergraduate',
      durationTerms: 8,
    })
    .onConflictDoUpdate({
      target: [academic.programs.institutionId, academic.programs.code],
      set: { name: 'B.Tech Computer Science' },
    })
    .returning(),
  'program',
)

const term = one(
  await db
    .insert(academic.terms)
    .values({
      ...tenant,
      code: '2026-ODD',
      name: 'Odd Semester 2026',
      startsOn: '2026-07-01',
      endsOn: '2026-12-15',
      isCurrent: true,
    })
    .onConflictDoUpdate({
      target: [academic.terms.institutionId, academic.terms.code],
      set: { isCurrent: true },
    })
    .returning(),
  'term',
)

const section = one(
  await db
    .insert(academic.sections)
    .values({ ...tenant, programId: program.id, label: 'A', admissionYear: 2026 })
    .onConflictDoUpdate({
      target: [
        academic.sections.institutionId,
        academic.sections.programId,
        academic.sections.admissionYear,
        academic.sections.label,
      ],
      set: { label: 'A' },
    })
    .returning(),
  'section',
)

await db
  .insert(academic.sectionMembers)
  .values({ ...tenant, sectionId: section.id, userId: student.id })
  .onConflictDoNothing()

const COURSES = [
  { code: 'CS301', title: 'Operating Systems', credits: 4, room: 'LT-1', day: 1, at: '09:00' },
  { code: 'CS302', title: 'Databases', credits: 4, room: 'LT-1', day: 1, at: '10:00' },
  { code: 'CS303', title: 'Computer Networks', credits: 3, room: 'LT-2', day: 3, at: '11:00' },
]

for (const c of COURSES) {
  const course = one(
    await db
      .insert(academic.courses)
      .values({ ...tenant, departmentId: dept.id, code: c.code, title: c.title, credits: c.credits })
      .onConflictDoUpdate({
        target: [academic.courses.institutionId, academic.courses.code],
        set: { title: c.title },
      })
      .returning(),
    'course',
  )

  const room = one(
    await db
      .insert(academic.rooms)
      .values({ ...tenant, code: c.room, building: 'Main Block', capacity: 120 })
      .onConflictDoUpdate({
        target: [academic.rooms.institutionId, academic.rooms.code],
        set: { building: 'Main Block' },
      })
      .returning(),
    'room',
  )

  const offering = one(
    await db
      .insert(academic.offerings)
      .values({
        ...tenant,
        termId: term.id,
        courseId: course.id,
        sectionId: section.id,
        facultyUserId: lecturer.id,
      })
      .onConflictDoUpdate({
        target: [
          academic.offerings.termId,
          academic.offerings.courseId,
          academic.offerings.sectionId,
        ],
        set: { facultyUserId: lecturer.id },
      })
      .returning(),
    'offering',
  )

  // No unique index to conflict on, and the clash constraints make a duplicate
  // insert fail rather than duplicate. Skip if this offering already has a slot.
  const existing = await db
    .select({ id: academic.slots.id })
    .from(academic.slots)
    .where(eq(academic.slots.offeringId, offering.id))
  if (existing.length === 0) {
    const [h, m] = c.at.split(':')
    await db.insert(academic.slots).values({
      ...tenant,
      offeringId: offering.id,
      roomId: room.id,
      dayOfWeek: c.day,
      startsAt: c.at,
      endsAt: `${String(Number(h) + 1).padStart(2, '0')}:${m}`,
    })
  }
}

console.log(
  `seeded institution=${demo.slug} super_admin=${email} ` +
    `academic=1 dept, 1 programme, ${COURSES.length} courses, 1 cohort, ${COURSES.length} slots`,
)
console.log(
  'note: this populates, it does not reconcile. If SUPER_ADMIN_EMAILS changed, ' +
    'the previous admin row is still there -- use `docker compose down -v` for a true reset.',
)
process.exit(0)
