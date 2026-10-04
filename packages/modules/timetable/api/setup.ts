import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import * as z from 'zod'
import { users, withTenant } from '@campusos/db'
import { readUpload, ticked, UploadError } from '@campusos/module-framework'
import { courses, departments, programs, rooms, sections, terms } from '@campusos/module-academic/schema'
import { eligibility, periods, roomKinds, sectionPlans, settings, teacherLimits, unavailable } from '../schema'
import {
  TEACHERS,
  TimetableError,
  fromMinutes,
  hm,
  named,
  requireOffice,
  requireReader,
  requireTeacherOrOffice,
  tenantOf,
  toMinutes,
  type Actor,
  type Tx,
} from './core'

/**
 * What the solver works from, beyond the academic core: the institution's
 * defaults, the week's periods, rooms' kinds, cohorts' sizes and batches,
 * teachers' limits, who may teach what, and when somebody cannot.
 */

const uuid = z.uuid()
const optionalId = z.uuid().optional().or(z.literal('').transform(() => undefined))
const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : undefined))
const optionalInt = (min: number, max: number) =>
  z.union([z.literal('').transform(() => undefined), z.coerce.number().int().min(min).max(max)]).optional()
const hhmm = z.string().trim().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'a time like 09:00').transform((t) => t.slice(0, 5))

// --- settings --------------------------------------------------------------------------

export const DEFAULTS = { maxPerDay: 6, maxPerWeek: 24, maxConsecutive: 3, yearStartsMonth: 7, timeLimitSeconds: 20 }

export async function settingsWithin(tx: Tx, institutionId: string) {
  const [row] = await tx.select().from(settings).where(eq(settings.institutionId, institutionId))
  return row ?? { institutionId, ...DEFAULTS, updatedAt: null }
}

export async function getSettings(actor: Actor) {
  const tenant = requireTeacherOrOffice(actor)
  return withTenant(tenant, (tx) => settingsWithin(tx, tenant))
}

export const settingsSchema = z
  .object({
    maxPerDay: optionalInt(1, 16),
    maxPerWeek: optionalInt(1, 80),
    maxConsecutive: optionalInt(1, 16),
    yearStartsMonth: optionalInt(1, 12),
    timeLimitSeconds: optionalInt(1, 600),
  })
  .meta({ id: 'TimetableSettings' })

export async function updateSettings(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = settingsSchema.parse(input)
  const set = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))
  return withTenant(tenant, async (tx) => {
    const now = await settingsWithin(tx, tenant)
    const next = { ...DEFAULTS, ...pick(now), ...set }
    await tx
      .insert(settings)
      .values({ institutionId: tenant, ...next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.institutionId, set: { ...next, updatedAt: new Date() } })
    return { ...next, notice: 'Settings saved.' }
  })
}
const pick = (s: Record<string, unknown>) => ({
  maxPerDay: s.maxPerDay as number,
  maxPerWeek: s.maxPerWeek as number,
  maxConsecutive: s.maxConsecutive as number,
  yearStartsMonth: s.yearStartsMonth as number,
  timeLimitSeconds: s.timeLimitSeconds as number,
})

// --- the week's periods ----------------------------------------------------------------

/** The periods a term is timetabled in: its own week if it has one, else the standing week. */
export async function periodsFor(tx: Tx, termId: string | null) {
  if (termId) {
    const own = await tx
      .select()
      .from(periods)
      .where(eq(periods.termId, termId))
      .orderBy(asc(periods.dayOfWeek), asc(periods.index))
    if (own.length) return { own: true, rows: own }
  }
  const rows = await tx.select().from(periods).where(isNull(periods.termId)).orderBy(asc(periods.dayOfWeek), asc(periods.index))
  return { own: false, rows }
}

export async function listPeriods(actor: Actor, input: { termId?: string } = {}) {
  const tenant = requireTeacherOrOffice(actor)
  return withTenant(tenant, async (tx) => {
    const { own, rows } = await periodsFor(tx, input.termId || null)
    return {
      termId: input.termId || null,
      own,
      periods: rows.map((p) => ({ ...p, startsAt: hm(p.startsAt), endsAt: hm(p.endsAt) })),
    }
  })
}

export const generatePeriodsSchema = z
  .object({
    termId: optionalId,
    /** ISO weekdays, 1 = Monday. */
    days: z.preprocess((v) => (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]), z.array(z.coerce.number().int().min(1).max(7)).min(1)),
    startsAt: hhmm,
    minutes: z.coerce.number().int().min(10).max(240),
    count: z.coerce.number().int().min(1).max(16),
    /** Breaks after a period, "2:10, 4:40" -- ten minutes after the second, forty after the fourth. */
    breaks: optionalText(200),
  })
  .meta({ id: 'TimetableGeneratePeriods' })

/**
 * Lay out the given days' periods in one go: a first start, a length, how many,
 * and the breaks. Replaces those days' periods in that week; other days are
 * left alone, so a shorter Saturday is a second call.
 */
export async function generatePeriods(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = generatePeriodsSchema.parse(input)
  const gaps = new Map<number, number>()
  for (const part of (data.breaks ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,2})\s*:\s*(\d{1,3})$/.exec(part)
    if (!m) throw new TimetableError(400, 'bad_breaks', `"${part}" is not "after:minutes", like 4:40`)
    gaps.set(Number(m[1]), Number(m[2]))
  }
  const rows: { dayOfWeek: number; index: number; startsAt: string; endsAt: string }[] = []
  for (const day of [...new Set(data.days)].sort()) {
    let t = toMinutes(data.startsAt)
    for (let index = 1; index <= data.count; index++) {
      if (t + data.minutes > 24 * 60) throw new TimetableError(400, 'past_midnight', 'the day would run past midnight')
      rows.push({ dayOfWeek: day, index, startsAt: fromMinutes(t), endsAt: fromMinutes(t + data.minutes) })
      t += data.minutes + (gaps.get(index) ?? 0)
    }
  }
  return withTenant(tenant, (tx) =>
    named(async () => {
      if (data.termId) await termWithin(tx, data.termId)
      await tx
        .delete(periods)
        .where(and(data.termId ? eq(periods.termId, data.termId) : isNull(periods.termId), inArray(periods.dayOfWeek, data.days)))
      await tx.insert(periods).values(rows.map((r) => ({ institutionId: tenant, termId: data.termId ?? null, ...r })))
      return { periods: rows.length, notice: `${rows.length} periods laid out.` }
    }),
  )
}

export const periodSchema = z
  .object({
    termId: optionalId,
    dayOfWeek: z.coerce.number().int().min(1).max(7),
    index: z.coerce.number().int().min(1).max(30),
    startsAt: hhmm,
    endsAt: hhmm,
    label: optionalText(40),
  })
  .meta({ id: 'TimetablePeriod' })

export async function addPeriod(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = periodSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      if (data.termId) await termWithin(tx, data.termId)
      const [row] = await tx
        .insert(periods)
        .values({ institutionId: tenant, termId: data.termId ?? null, dayOfWeek: data.dayOfWeek, index: data.index, startsAt: data.startsAt, endsAt: data.endsAt, label: data.label ?? null })
        .returning()
      await assertOrdered(tx, data.termId ?? null, data.dayOfWeek)
      return { ...row!, notice: 'Period added.' }
    }),
  )
}

export async function deletePeriod(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const { periodId } = z.object({ periodId: uuid }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.delete(periods).where(eq(periods.id, periodId))
    return { notice: 'Period removed.' }
  })
}

/** Period numbers run in time order: period 3 never starts before period 2. */
async function assertOrdered(tx: Tx, termId: string | null, day: number) {
  const rows = await tx
    .select()
    .from(periods)
    .where(and(termId ? eq(periods.termId, termId) : isNull(periods.termId), eq(periods.dayOfWeek, day)))
    .orderBy(asc(periods.index))
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.startsAt < rows[i - 1]!.endsAt) {
      throw new TimetableError(409, 'periods_out_of_order', `period ${rows[i]!.index} starts before period ${rows[i - 1]!.index} ends`)
    }
  }
}

async function termWithin(tx: Tx, termId: string) {
  const [t] = await tx.select().from(terms).where(eq(terms.id, termId))
  if (!t) throw new TimetableError(404, 'no_such_term', 'no such term')
  return t
}

// --- rooms -------------------------------------------------------------------------

export async function listRooms(actor: Actor) {
  const tenant = requireReader(actor)
  return withTenant(tenant, (tx) => roomsWithin(tx))
}

/** Every room, with its kind for timetabling (a classroom unless said) and whether it may be used. */
export function roomsWithin(tx: Tx) {
  return tx
      .select({
        id: rooms.id,
        code: rooms.code,
        building: rooms.building,
        capacity: rooms.capacity,
        kind: sql<string>`coalesce(${roomKinds.kind}, 'classroom')`,
        available: sql<boolean>`coalesce(${roomKinds.available}, true)`,
      })
      .from(rooms)
      .leftJoin(roomKinds, eq(roomKinds.roomId, rooms.id))
      .orderBy(asc(rooms.code))
}

export const roomSchema = z
  .object({
    roomId: uuid,
    kind: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9 _:-]{0,39}$/, 'a short word: classroom, lab, hall, lab:chemistry'),
    available: z.preprocess(ticked, z.boolean()).default(true),
  })
  .meta({ id: 'TimetableRoom' })

export async function setRoom(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = roomSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await tx
        .insert(roomKinds)
        .values({ institutionId: tenant, ...data })
        .onConflictDoUpdate({ target: roomKinds.roomId, set: { kind: data.kind, available: data.available } })
      return { notice: data.available ? `Room is a ${data.kind}.` : 'Room taken out of timetabling.' }
    }),
  )
}

// --- cohorts -------------------------------------------------------------------------

export async function listSections(actor: Actor) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        id: sections.id,
        label: sections.label,
        admissionYear: sections.admissionYear,
        programId: programs.id,
        programCode: programs.code,
        members: sql<number>`(select count(*)::int from academic_section_members m where m.section_id = academic_sections.id)`,
        expectedSize: sectionPlans.expectedSize,
        parentSectionId: sectionPlans.parentSectionId,
      })
      .from(sections)
      .innerJoin(programs, eq(programs.id, sections.programId))
      .leftJoin(sectionPlans, eq(sectionPlans.sectionId, sections.id))
      .orderBy(asc(programs.code), asc(sections.admissionYear), asc(sections.label))
    const label = new Map(rows.map((r) => [r.id, `${r.programCode} ${r.admissionYear} ${r.label}`]))
    return rows.map((r) => ({
      ...r,
      name: label.get(r.id)!,
      size: r.expectedSize ?? r.members,
      parent: r.parentSectionId ? (label.get(r.parentSectionId) ?? null) : null,
    }))
  })
}

export const sectionPlanSchema = z
  .object({
    sectionId: uuid,
    expectedSize: optionalInt(1, 2000),
    parentSectionId: optionalId,
  })
  .meta({ id: 'TimetableSectionPlan' })

export async function setSection(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = sectionPlanSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      // A batch is part of a section, never part of itself further up.
      let up = data.parentSectionId ?? null
      for (let hops = 0; up && hops < 20; hops++) {
        if (up === data.sectionId) throw new TimetableError(409, 'section_cycle', 'a section cannot be part of itself')
        const [p] = await tx.select({ parent: sectionPlans.parentSectionId }).from(sectionPlans).where(eq(sectionPlans.sectionId, up))
        up = p?.parent ?? null
      }
      const values = { expectedSize: data.expectedSize ?? null, parentSectionId: data.parentSectionId ?? null }
      await tx
        .insert(sectionPlans)
        .values({ institutionId: tenant, sectionId: data.sectionId, ...values })
        .onConflictDoUpdate({ target: sectionPlans.sectionId, set: values })
      return { notice: 'Saved.' }
    }),
  )
}

// --- teachers ------------------------------------------------------------------------

export async function teachersWithin(tx: Tx, institutionId: string) {
  const s = await settingsWithin(tx, institutionId)
  const people = await tx
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      maxPerDay: teacherLimits.maxPerDay,
      maxPerWeek: teacherLimits.maxPerWeek,
      maxConsecutive: teacherLimits.maxConsecutive,
      note: teacherLimits.note,
    })
    .from(users)
    .leftJoin(teacherLimits, eq(teacherLimits.userId, users.id))
    .where(
      and(
        eq(users.institutionId, institutionId),
        sql`(${users.role} in ('faculty', 'hod') or exists (select 1 from timetable_eligibility e where e.user_id = "users"."id"))`,
      ),
    )
    .orderBy(asc(users.name))
  return people.map((p) => ({
    ...p,
    effective: {
      maxPerDay: p.maxPerDay ?? s.maxPerDay,
      maxPerWeek: p.maxPerWeek ?? s.maxPerWeek,
      maxConsecutive: p.maxConsecutive ?? s.maxConsecutive,
    },
  }))
}

export async function listTeachers(actor: Actor) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    const people = await teachersWithin(tx, tenant)
    const counts = await tx
      .select({ userId: eligibility.userId, n: sql<number>`count(*)::int` })
      .from(eligibility)
      .groupBy(eligibility.userId)
    const n = new Map(counts.map((c) => [c.userId, c.n]))
    return people.map((p) => ({ ...p, eligibility: n.get(p.userId) ?? 0 }))
  })
}

export const teacherSchema = z
  .object({
    userId: z.string().trim().min(1).max(100),
    maxPerDay: optionalInt(1, 16),
    maxPerWeek: optionalInt(0, 80),
    maxConsecutive: optionalInt(1, 16),
    note: optionalText(500),
  })
  .meta({ id: 'TimetableTeacher' })

export async function setTeacher(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = teacherSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await staffWithin(tx, tenant, data.userId)
      const values = {
        maxPerDay: data.maxPerDay ?? null,
        maxPerWeek: data.maxPerWeek ?? null,
        maxConsecutive: data.maxConsecutive ?? null,
        note: data.note ?? null,
      }
      await tx
        .insert(teacherLimits)
        .values({ institutionId: tenant, userId: data.userId, ...values })
        .onConflictDoUpdate({ target: teacherLimits.userId, set: values })
      return { notice: 'Limits saved.' }
    }),
  )
}

async function staffWithin(tx: Tx, institutionId: string, userId: string) {
  const [u] = await tx.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.id, userId), eq(users.institutionId, institutionId)))
  if (!u) throw new TimetableError(404, 'no_such_person', 'no such person here')
  if (u.role === 'student' || u.role === 'parent' || u.role === 'pending') {
    throw new TimetableError(409, 'not_staff', 'only staff teach')
  }
  return u
}

// --- who may teach what ------------------------------------------------------------------

export async function listEligibility(actor: Actor, input: { userId?: string; courseId?: string } = {}) {
  const tenant = requireTeacherOrOffice(actor)
  const own = TEACHERS.includes(actor.role) && actor.role !== 'hod'
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: eligibility.id,
        userId: eligibility.userId,
        teacher: users.name,
        courseId: eligibility.courseId,
        course: courses.code,
        courseTitle: courses.title,
        departmentId: eligibility.departmentId,
        department: departments.code,
        programId: eligibility.programId,
        program: programs.code,
        yearOfStudy: eligibility.yearOfStudy,
        preference: eligibility.preference,
      })
      .from(eligibility)
      .innerJoin(users, eq(users.id, eligibility.userId))
      .leftJoin(courses, eq(courses.id, eligibility.courseId))
      .leftJoin(departments, eq(departments.id, eligibility.departmentId))
      .leftJoin(programs, eq(programs.id, eligibility.programId))
      .where(
        and(
          own ? eq(eligibility.userId, actor.id) : input.userId ? eq(eligibility.userId, input.userId) : undefined,
          input.courseId ? eq(eligibility.courseId, input.courseId) : undefined,
        ),
      )
      .orderBy(asc(users.name), asc(courses.code)),
  )
}

export const eligibilitySchema = z
  .object({
    userId: z.string().trim().min(1).max(100),
    courseId: optionalId,
    departmentId: optionalId,
    programId: optionalId,
    yearOfStudy: optionalInt(1, 10),
    preference: z.coerce.number().int().min(1).max(5).default(3),
  })
  .meta({ id: 'TimetableEligibility' })

export async function addEligibility(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = eligibilitySchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await staffWithin(tx, tenant, data.userId)
      const [row] = await tx
        .insert(eligibility)
        .values({
          institutionId: tenant,
          userId: data.userId,
          courseId: data.courseId ?? null,
          departmentId: data.departmentId ?? null,
          programId: data.programId ?? null,
          yearOfStudy: data.yearOfStudy ?? null,
          preference: data.preference,
        })
        .returning()
      return { ...row!, notice: 'Eligibility added.' }
    }),
  )
}

export async function deleteEligibility(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const { id } = z.object({ id: uuid }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.delete(eligibility).where(eq(eligibility.id, id))
    return { notice: 'Removed.' }
  })
}

/**
 * Who may teach what, from a spreadsheet saved as CSV: one row per line,
 * `email, course, department, programme, year, preference` -- codes, any of
 * course to year left blank, a header row allowed. Every row is checked
 * before any is written; a file with a bad row writes nothing and says which.
 */
export async function importEligibility(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const data = z.object({ file: z.unknown() }).parse(input)
  let text: string
  try {
    text = readUpload(data.file, { what: 'the CSV', maxBytes: 1024 * 1024 }).bytes.toString('utf8')
  } catch (e) {
    if (e instanceof UploadError) throw new TimetableError(400, e.code, e.message)
    throw e
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const cells = lines.map((l) => l.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1')))
  if (cells[0] && /mail/i.test(cells[0][0] ?? '')) cells.shift()
  return withTenant(tenant, (tx) =>
    named(async () => {
      const people = await tx.select({ id: users.id, email: users.email, role: users.role }).from(users).where(eq(users.institutionId, tenant))
      const byEmail = new Map(people.map((p) => [(p.email ?? '').toLowerCase(), p]))
      const cs = new Map((await tx.select({ id: courses.id, code: courses.code }).from(courses)).map((c) => [c.code.toUpperCase(), c.id]))
      const ds = new Map((await tx.select({ id: departments.id, code: departments.code }).from(departments)).map((c) => [c.code.toUpperCase(), c.id]))
      const ps = new Map((await tx.select({ id: programs.id, code: programs.code }).from(programs)).map((c) => [c.code.toUpperCase(), c.id]))
      const rows: (typeof eligibility.$inferInsert)[] = []
      const problems: string[] = []
      cells.forEach((c, i) => {
        const at = `line ${i + 1}`
        const [email = '', course = '', dept = '', prog = '', year = '', pref = ''] = c
        const person = byEmail.get(email.toLowerCase())
        if (!person) return problems.push(`${at}: nobody here has the email ${email || '(blank)'}`)
        if (['student', 'parent', 'pending'].includes(person.role)) return problems.push(`${at}: ${email} is not staff`)
        const courseId = course ? cs.get(course.toUpperCase()) : undefined
        if (course && !courseId) return problems.push(`${at}: no course ${course}`)
        const departmentId = dept ? ds.get(dept.toUpperCase()) : undefined
        if (dept && !departmentId) return problems.push(`${at}: no department ${dept}`)
        const programId = prog ? ps.get(prog.toUpperCase()) : undefined
        if (prog && !programId) return problems.push(`${at}: no programme ${prog}`)
        const y = year ? Number(year) : null
        if (year && (!Number.isInteger(y) || y! < 1 || y! > 10)) return problems.push(`${at}: year ${year} is not 1 to 10`)
        const p = pref ? Number(pref) : 3
        if (!Number.isInteger(p) || p < 1 || p > 5) return problems.push(`${at}: preference ${pref} is not 1 to 5`)
        if (!courseId && !departmentId && !programId && y === null) return problems.push(`${at}: say what they may teach`)
        rows.push({ institutionId: tenant, userId: person.id, courseId: courseId ?? null, departmentId: departmentId ?? null, programId: programId ?? null, yearOfStudy: y, preference: p })
      })
      if (problems.length) {
        throw new TimetableError(400, 'bad_rows', `${problems.length} row(s) need fixing; nothing was imported. ${problems.slice(0, 5).join('; ')}`, problems)
      }
      if (rows.length === 0) throw new TimetableError(400, 'empty', 'the file has no rows')
      const written = await tx
        .insert(eligibility)
        .values(rows)
        .onConflictDoUpdate({
          target: [eligibility.userId, eligibility.courseId, eligibility.departmentId, eligibility.programId, eligibility.yearOfStudy],
          set: { preference: sql`excluded.preference` },
        })
        .returning({ id: eligibility.id })
      return { imported: written.length, notice: `${written.length} row(s) of eligibility imported.` }
    }),
  )
}

// --- when somebody cannot ----------------------------------------------------------------

export async function listUnavailable(actor: Actor, input: { userId?: string } = {}) {
  const tenant = requireTeacherOrOffice(actor)
  const own = actor.role === 'faculty'
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: unavailable.id,
        userId: unavailable.userId,
        teacher: users.name,
        roomId: unavailable.roomId,
        room: rooms.code,
        sectionId: unavailable.sectionId,
        section: sections.label,
        dayOfWeek: unavailable.dayOfWeek,
        period: unavailable.period,
        reason: unavailable.reason,
      })
      .from(unavailable)
      .leftJoin(users, eq(users.id, unavailable.userId))
      .leftJoin(rooms, eq(rooms.id, unavailable.roomId))
      .leftJoin(sections, eq(sections.id, unavailable.sectionId))
      .where(own ? eq(unavailable.userId, actor.id) : input.userId ? eq(unavailable.userId, input.userId) : undefined)
      .orderBy(asc(unavailable.dayOfWeek), asc(unavailable.period)),
  )
}

export const unavailableSchema = z
  .object({
    userId: optionalText(100),
    roomId: optionalId,
    sectionId: optionalId,
    dayOfWeek: z.coerce.number().int().min(1).max(7),
    period: optionalInt(1, 30),
    reason: optionalText(200),
  })
  .meta({ id: 'TimetableUnavailable' })

/** The office marks anybody or anything; a teacher marks only themselves. */
export async function addUnavailable(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const data = unavailableSchema.parse(input)
  const office = ['institution_admin', 'super_admin'].includes(actor.role)
  if (!office) {
    requireTeacherOrOffice(actor)
    if (data.roomId || data.sectionId || (data.userId && data.userId !== actor.id)) {
      throw new TimetableError(403, 'forbidden', 'a teacher marks only their own time')
    }
    data.userId = actor.id
  }
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [row] = await tx
        .insert(unavailable)
        .values({
          institutionId: tenant,
          userId: data.userId ?? null,
          roomId: data.roomId ?? null,
          sectionId: data.sectionId ?? null,
          dayOfWeek: data.dayOfWeek,
          period: data.period ?? null,
          reason: data.reason ?? null,
        })
        .returning()
      return { ...row!, notice: 'Marked unavailable.' }
    }),
  )
}

export async function deleteUnavailable(actor: Actor, input: unknown) {
  const tenant = requireTeacherOrOffice(actor)
  const { id } = z.object({ id: uuid }).parse(input)
  const office = ['institution_admin', 'super_admin'].includes(actor.role)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(unavailable).where(eq(unavailable.id, id))
    if (!row) throw new TimetableError(404, 'not_found', 'no such entry')
    if (!office && row.userId !== actor.id) throw new TimetableError(403, 'forbidden', 'a teacher removes only their own')
    await tx.delete(unavailable).where(eq(unavailable.id, id))
    return { notice: 'Removed.' }
  })
}
