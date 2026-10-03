import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { moduleEnabled, readUpload, UploadError } from '@campusos/module-framework'
import { studentProfile, type Actor as AcademicActor } from '@campusos/module-academic/api'
import { completion, type Actor as FeedbackActor } from '@campusos/module-feedback/api'
import { manifest as feedbackManifest } from '@campusos/module-feedback/manifest'
import { cancelChargeForSourceWithin, chargeStudentWithin } from '@campusos/module-fees/api'
import { manifest as feesManifest } from '@campusos/module-fees/manifest'
import { formatPaise, parseRupeesToPaise } from '@campusos/money'
import { manifest } from '../manifest'
import {
  backlogBookings,
  enrolmentPapers,
  enrolments,
  examMarks,
  examSettings,
  examWindows,
  exams,
  questionPapers,
  type ExamWindow,
} from '../schema'
import { courseCompletions, courses, institutions, offerings, programs, sectionMembers, sections, studentPrograms, terms, users } from './joins'
import { ExamError, type Actor } from './operations'
import {
  bookBacklogSchema,
  cancelBacklogSchema,
  cancelEnrolmentSchema,
  enrolSchema,
  setSettingsSchema,
  setWindowSchema,
  uploadPaperSchema,
} from './cycle-schemas'
import { gpa } from './grading'
import { assertZone, instant, wallClock, ZoneError } from './time'

/**
 * The examination cycle a student walks through each term, as KIIT's portal
 * lays it out: feedback first, then enrolment with the details they confirm,
 * then the admit card -- with backlog booking beside it and the semester grade
 * report at the end.
 */

const MODULE = 'examinations'
const KNOWN = [manifest, feedbackManifest, feesManifest]

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const tenantOf = (actor: Actor) => {
  if (!actor.institutionId) throw new ExamError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
const isAdmin = (r: Actor['role']) => r === 'institution_admin' || r === 'super_admin'
const isStaff = (r: Actor['role']) => isAdmin(r) || r === 'hod' || r === 'faculty'
const requireAdmin = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new ExamError(403, 'forbidden', 'the examination cell does this')
  return t
}
const requireStaff = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!isStaff(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  return t
}
const requireStudent = (actor: Actor) => {
  const t = tenantOf(actor)
  if (actor.role !== 'student') throw new ExamError(403, 'forbidden', 'this is the student’s to do')
  return t
}
/** A student reads their own; staff read anybody's. */
const mayRead = (actor: Actor, studentId: string) => {
  if (actor.role === 'student' ? actor.id !== studentId : !isStaff(actor.role)) {
    throw new ExamError(403, 'forbidden', 'not permitted')
  }
}

const REFUSALS: Record<string, [400 | 403 | 409, string]> = {
  exam_windows_once: [409, 'that term already has that window; change its dates instead'],
  exam_windows_span: [400, 'a window must close after it opens'],
  exam_window_fixed: [409, 'a window keeps its term and kind'],
  exam_window_used: [409, 'that window has been used and is kept'],
  exam_enrolment_window: [409, 'the enrolment window is not open; contact the examination cell'],
  exam_enrolment_student: [403, 'enrolment is for a student'],
  exam_enrolments_once: [409, 'you are already enrolled for this term'],
  exam_enrolment_paper: [403, 'that is not one of your classes this term'],
  exam_enrolment_fixed: [409, 'an enrolment is only cancelled, once, with a reason'],
  exam_backlog_window: [409, 'the backlog booking window is not open'],
  exam_backlog_student: [403, 'a backlog is booked by a student'],
  exam_backlog_not_failed: [409, 'that course is not a backlog on your record'],
  exam_backlog_bookings_once: [409, 'that paper is already booked'],
  exam_backlog_fixed: [409, 'a booking is only cancelled, once, with a reason'],
  exam_paper_unscheduled: [409, 'schedule the exam before its paper is set'],
  exam_paper_locked: [409, 'the paper is sealed: it is too close to the exam to change'],
  exam_paper_fixed: [409, 'a question paper is never edited; upload a new one'],
  exam_paper_kept: [409, 'a question paper is kept'],
  exam_settings_release: [400, 'the release lead is between 5 minutes and a day'],
  fee_student_charge_invoiced: [409, 'the fee for that booking is already on an invoice; the accounts office refunds it'],
}

async function named<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ExamError) throw e
    const fee = e as { code?: string; status?: number }
    if (fee.code === 'fee_student_charge_invoiced') {
      const [s, m] = REFUSALS.fee_student_charge_invoiced!
      throw new ExamError(s, fee.code, m)
    }
    const c = (e as { cause?: { constraint?: string } }).cause?.constraint ?? (e as { constraint?: string }).constraint
    const known = c ? REFUSALS[c] : undefined
    if (known) throw new ExamError(known[0], c!, known[1])
    if (e instanceof ZoneError) throw new ExamError(400, 'bad_time_zone', e.message)
    if (e instanceof UploadError) throw new ExamError(400, e.code, e.message)
    throw e
  }
}

export type WindowPhase = 'none' | 'upcoming' | 'open' | 'closed'
const phaseOf = (w: Pick<ExamWindow, 'opensAt' | 'closesAt'> | undefined, now = new Date()): WindowPhase =>
  !w ? 'none' : now < w.opensAt ? 'upcoming' : now < w.closesAt ? 'open' : 'closed'

const showWindow = (w: ExamWindow | undefined) =>
  w
    ? {
        ...w,
        phase: phaseOf(w),
        opens: wallClock(w.opensAt, w.timeZone),
        closes: wallClock(w.closesAt, w.timeZone),
        internalFee: formatPaise(w.internalFeePaise),
        examFee: formatPaise(w.examFeePaise),
      }
    : null

// --- settings and windows -------------------------------------------------------

export async function settingsOf(tx: Tx, tenant: string) {
  const [s] = await tx.select().from(examSettings).where(eq(examSettings.institutionId, tenant))
  return { paperReleaseMinutes: s?.paperReleaseMinutes ?? 60, gradeReportNeedsFeedback: s?.gradeReportNeedsFeedback ?? false }
}

export async function examCycleSettings(actor: Actor) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, (tx) => settingsOf(tx, tenant))
}

export async function setExamCycleSettings(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = setSettingsSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const values = { paperReleaseMinutes: d.paperReleaseMinutes, gradeReportNeedsFeedback: d.gradeReportNeedsFeedback, updatedAt: new Date() }
      await tx.insert(examSettings).values({ institutionId: tenant, ...values }).onConflictDoUpdate({ target: examSettings.institutionId, set: values })
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'settings',
        entity: 'exam_settings',
        entityId: tenant,
        reason: `papers open ${d.paperReleaseMinutes} min before; grade report ${d.gradeReportNeedsFeedback ? 'waits for' : 'does not wait for'} feedback`,
      })
      return { notice: 'Saved.' }
    }),
  )
}

/** Open, move or change a term's enrolment or backlog window. */
export async function setWindow(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = setWindowSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const zone = assertZone(d.timeZone)
      const opensAt = instant(d.opensAt, zone)
      const closesAt = instant(d.closesAt, zone)
      if (closesAt <= opensAt) throw new ExamError(400, 'exam_windows_span', 'a window must close after it opens')
      const fee = (v: string | undefined) => {
        if (!v) return 0
        const p = parseRupeesToPaise(v)
        if (p === null || p < 0) throw new ExamError(400, 'bad_amount', 'a fee is an amount in rupees')
        return p
      }
      const values = {
        opensAt,
        closesAt,
        timeZone: zone,
        instructions: d.instructions || null,
        internalFeePaise: d.kind === 'backlog' ? fee(d.internalFee) : 0,
        examFeePaise: d.kind === 'backlog' ? fee(d.examFee) : 0,
      }
      const [w] = await tx
        .insert(examWindows)
        .values({ institutionId: tenant, termId: d.termId, kind: d.kind, createdBy: actor.id, ...values })
        .onConflictDoUpdate({ target: [examWindows.termId, examWindows.kind], set: values })
        .returning()
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'window',
        entity: 'exam_windows',
        entityId: w!.id,
        reason: `${d.kind} window ${wallClock(opensAt, zone)} to ${wallClock(closesAt, zone)}`,
      })
      return { ...w!, notice: `The ${d.kind} window is set: ${wallClock(opensAt, zone)} to ${wallClock(closesAt, zone)} (${zone}).` }
    }),
  )
}

export async function listWindows(actor: Actor) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ w: examWindows, term: terms.code, termName: terms.name })
      .from(examWindows)
      .innerJoin(terms, eq(terms.id, examWindows.termId))
      .orderBy(desc(terms.startsOn), asc(examWindows.kind))
    return rows.map((r) => ({ ...showWindow(r.w)!, term: r.term, termName: r.termName }))
  })
}

// --- a student's term ---------------------------------------------------------

async function currentTerm(tx: Tx, termId?: string | null) {
  const [t] = termId
    ? await tx.select().from(terms).where(eq(terms.id, termId))
    : await tx.select().from(terms).where(sql`is_current`).limit(1)
  return t ?? null
}

async function classesOf(tx: Tx, studentId: string, termId: string) {
  return tx
    .select({ offeringId: offerings.id, code: courses.code, title: courses.title, credits: courses.credits })
    .from(offerings)
    .innerJoin(sectionMembers, and(eq(sectionMembers.sectionId, offerings.sectionId), eq(sectionMembers.userId, studentId)))
    .innerJoin(courses, eq(courses.id, offerings.courseId))
    .where(eq(offerings.termId, termId))
    .orderBy(asc(courses.code))
}

async function leadingProgramme(tx: Tx, studentId: string) {
  const [p] = await tx
    .select({ code: programs.code, name: programs.name })
    .from(studentPrograms)
    .innerJoin(programs, eq(programs.id, studentPrograms.programId))
    .where(eq(studentPrograms.studentId, studentId))
    .orderBy(asc(studentPrograms.declaredOn))
    .limit(1)
  if (p) return `${p.code} ${p.name}`
  const [s] = await tx
    .select({ code: programs.code, name: programs.name })
    .from(sectionMembers)
    .innerJoin(sections, eq(sections.id, sectionMembers.sectionId))
    .innerJoin(programs, eq(programs.id, sections.programId))
    .where(eq(sectionMembers.userId, studentId))
    .limit(1)
  return s ? `${s.code} ${s.name}` : null
}

async function activeEnrolment(tx: Tx, studentId: string, termId: string) {
  const [e] = await tx
    .select()
    .from(enrolments)
    .where(and(eq(enrolments.studentId, studentId), eq(enrolments.termId, termId), isNull(enrolments.cancelledAt)))
  return e ?? null
}

/** Failed on the record and not passed since. */
async function backlogsOf(tx: Tx, studentId: string) {
  return tx
    .select({ courseId: courses.id, code: courses.code, title: courses.title, credits: courses.credits, failedIn: terms.code })
    .from(courseCompletions)
    .innerJoin(courses, eq(courses.id, courseCompletions.courseId))
    .leftJoin(terms, eq(terms.id, courseCompletions.termId))
    .where(
      and(
        eq(courseCompletions.studentId, studentId),
        eq(courseCompletions.passed, false),
        sql`not exists (select 1 from academic_course_completions p
                         where p.student_id = ${studentId} and p.course_id = academic_course_completions.course_id and p.passed)`,
      ),
    )
    .orderBy(asc(courses.code))
}

/** Is the grade report held for feedback, for this reader and term? */
async function feedbackGate(actor: Actor, tenant: string, studentId: string, termId: string) {
  const s = await withTenant(tenant, (tx) => settingsOf(tx, tenant))
  const on = await moduleEnabled(KNOWN, 'feedback', tenant)
  if (!on) return { applies: false as const, complete: true, owed: [] as { window: string; course: string }[] }
  const c = await completion(actor as unknown as FeedbackActor, studentId, termId)
  const owed = [...c.owed, ...c.missed].map((i) => ({ window: i.window, course: i.course }))
  return { applies: s.gradeReportNeedsFeedback, complete: c.complete, owed }
}

/**
 * Everything the exam-booking page shows a student for a term: feedback,
 * enrolment, the admit card, backlogs and grade reports.
 */
export async function myExamCycle(actor: Actor, termId?: string | null) {
  const tenant = requireStudent(actor)
  const profile = await studentProfile(actor as unknown as AcademicActor, actor.id)
  const base = await withTenant(tenant, async (tx) => {
    const term = await currentTerm(tx, termId)
    if (!term) return null
    const ws = await tx.select().from(examWindows).where(eq(examWindows.termId, term.id))
    const enrolWindow = ws.find((w) => w.kind === 'enrolment')
    const backlogWindow = ws.find((w) => w.kind === 'backlog')
    const enrolment = await activeEnrolment(tx, actor.id, term.id)
    const papers = enrolment
      ? await tx
          .select({ code: courses.code, title: courses.title })
          .from(enrolmentPapers)
          .innerJoin(offerings, eq(offerings.id, enrolmentPapers.offeringId))
          .innerJoin(courses, eq(courses.id, offerings.courseId))
          .where(eq(enrolmentPapers.enrolmentId, enrolment.id))
          .orderBy(asc(courses.code))
      : []
    const classes = await classesOf(tx, actor.id, term.id)
    const backlogs = await backlogsOf(tx, actor.id)
    const bookings = await tx
      .select({ b: backlogBookings, code: courses.code, title: courses.title })
      .from(backlogBookings)
      .innerJoin(courses, eq(courses.id, backlogBookings.courseId))
      .where(and(eq(backlogBookings.studentId, actor.id), eq(backlogBookings.termId, term.id)))
      .orderBy(desc(backlogBookings.bookedAt))
    const reportTerms = await tx
      .selectDistinct({ id: terms.id, code: terms.code, name: terms.name, startsOn: terms.startsOn })
      .from(courseCompletions)
      .innerJoin(terms, eq(terms.id, courseCompletions.termId))
      .where(eq(courseCompletions.studentId, actor.id))
      .orderBy(asc(terms.startsOn))
    const programme = await leadingProgramme(tx, actor.id)
    return { term, enrolWindow, backlogWindow, enrolment, papers, classes, backlogs, bookings, reportTerms, programme }
  })
  if (!base) return null
  const feedbackOn = await moduleEnabled(KNOWN, 'feedback', tenant)
  const gate = await feedbackGate(actor, tenant, actor.id, base.term.id)
  const booked = new Set(base.bookings.filter((b) => !b.b.cancelledAt).map((b) => b.b.courseId))
  const reports = []
  for (const t of base.reportTerms) {
    const g = t.id === base.term.id ? gate : await feedbackGate(actor, tenant, actor.id, t.id)
    reports.push({ termId: t.id, term: `${t.code} ${t.name}`, held: g.applies && !g.complete })
  }
  return {
    term: base.term,
    profile,
    programme: base.programme,
    feedback: feedbackOn ? { complete: gate.complete, owed: gate.owed } : null,
    enrolWindow: showWindow(base.enrolWindow),
    enrolment: base.enrolment,
    papers: base.papers,
    classes: base.classes,
    backlogWindow: showWindow(base.backlogWindow),
    backlogs: base.backlogs.map((b) => ({ ...b, booked: booked.has(b.courseId) })),
    bookings: base.bookings.map((r) => ({
      ...r.b,
      code: r.code,
      title: r.title,
      fee: formatPaise(r.b.feePaise),
      state: r.b.cancelledAt ? 'cancelled' : 'booked',
    })),
    reports,
  }
}

export async function enrol(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const d = enrolSchema.parse(input)
  if (!d.confirm) throw new ExamError(400, 'not_confirmed', 'confirm that your details are correct, or contact the office first')
  const p = await studentProfile(actor as unknown as AcademicActor, actor.id)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const classes = await classesOf(tx, actor.id, d.termId)
      if (!classes.length) throw new ExamError(409, 'no_papers', 'you have no classes this term to sit')
      const confirmed = {
        name: p.name,
        email: p.email,
        rollNo: p.rollNo,
        registrationNo: p.registrationNo,
        programme: await leadingProgramme(tx, actor.id),
        phone: p.phone,
        address: p.address,
      }
      const [e] = await tx
        .insert(enrolments)
        .values({ institutionId: tenant, termId: d.termId, studentId: actor.id, confirmed })
        .returning()
      await tx
        .insert(enrolmentPapers)
        .values(classes.map((c) => ({ institutionId: tenant, enrolmentId: e!.id, offeringId: c.offeringId })))
      return {
        ...e!,
        notice: `Enrolled for ${classes.length} paper${classes.length === 1 ? '' : 's'}. Your admit card can be downloaded now.`,
        link: '/m/examinations/booking',
      }
    }),
  )
}

export async function cancelEnrolment(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = cancelEnrolmentSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const rows = await tx
        .update(enrolments)
        .set({ cancelledAt: new Date(), cancelledBy: actor.id, cancelReason: d.reason })
        .where(eq(enrolments.id, d.enrolmentId))
        .returning({ id: enrolments.id })
      if (!rows.length) throw new ExamError(404, 'no_such_enrolment', 'no such enrolment')
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'cancel',
        entity: 'exam_enrolments',
        entityId: d.enrolmentId,
        reason: d.reason,
      })
      return { id: d.enrolmentId, notice: 'Enrolment cancelled. The student may enrol again while the window is open.' }
    }),
  )
}

/** Who is enrolled for a term, and who has classes but is not. */
export async function enrolmentList(actor: Actor, termId: string) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.execute(sql`
      select u.id as student_id, coalesce(u.name, u.email) as name, p.roll_no,
             e.id as enrolment_id, e.enrolled_at,
             (select count(*)::int from exam_enrolment_papers ep where ep.enrolment_id = e.id) as papers,
             (select count(distinct o.id)::int from academic_offerings o
                join academic_section_members m2 on m2.section_id = o.section_id and m2.user_id = u.id
               where o.term_id = ${termId}) as classes
        from users u
        left join academic_student_profiles p on p.student_id = u.id
        left join exam_enrolments e on e.student_id = u.id and e.term_id = ${termId} and e.cancelled_at is null
       where u.role = 'student'
         and exists (select 1 from academic_offerings o
                       join academic_section_members m on m.section_id = o.section_id and m.user_id = u.id
                      where o.term_id = ${termId})
       order by e.id is null desc, name`)
    return (rows.rows as {
      student_id: string
      name: string
      roll_no: string | null
      enrolment_id: string | null
      enrolled_at: Date | null
      papers: number
      classes: number
    }[]).map((r) => ({
      studentId: r.student_id,
      name: r.name,
      rollNo: r.roll_no,
      enrolmentId: r.enrolment_id,
      enrolledAt: r.enrolled_at ? new Date(r.enrolled_at).toISOString() : null,
      papers: r.papers,
      classes: r.classes,
      state: r.enrolment_id ? 'enrolled' : 'not_enrolled',
    }))
  })
}

// --- the admit card -------------------------------------------------------------

export interface AdmitCard {
  institution: string
  term: { code: string; name: string }
  ticketNo: string
  student: Record<string, string | null>
  enrolledOn: string
  timeZone: string
  instructions: string | null
  papers: { code: string; title: string; exam: string | null; when: string | null; room: string | null }[]
}

export async function admitCard(actor: Actor, studentId: string, termId: string): Promise<AdmitCard> {
  const tenant = tenantOf(actor)
  mayRead(actor, studentId)
  return withTenant(tenant, async (tx) => {
    const e = await activeEnrolment(tx, studentId, termId)
    if (!e) throw new ExamError(409, 'not_enrolled', 'there is an admit card only for an enrolment; enrol first')
    const [t] = await tx.select().from(terms).where(eq(terms.id, termId))
    const [inst] = await tx.select({ name: institutions.name }).from(institutions).where(eq(institutions.id, tenant))
    const [w] = await tx.select().from(examWindows).where(and(eq(examWindows.termId, termId), eq(examWindows.kind, 'enrolment')))
    const zone = w?.timeZone ?? 'Asia/Kolkata'
    const rows = await tx.execute(sql`
      select c.code, c.title, x.name as exam, x.scheduled_at, r.code as room
        from exam_enrolment_papers ep
        join academic_offerings o on o.id = ep.offering_id
        join academic_courses c on c.id = o.course_id
        left join lateral (
          select name, scheduled_at, room_id from exams
           where offering_id = o.id and kind = 'final'
           order by scheduled_at nulls last limit 1
        ) x on true
        left join academic_rooms r on r.id = x.room_id
       where ep.enrolment_id = ${e.id}
       order by x.scheduled_at nulls last, c.code`)
    const roll = e.confirmed.rollNo ?? studentId.slice(0, 8).toUpperCase()
    return {
      institution: inst?.name ?? '',
      term: { code: t!.code, name: t!.name },
      ticketNo: `${t!.code}/${roll}`,
      student: e.confirmed,
      enrolledOn: wallClock(e.enrolledAt, zone),
      timeZone: zone,
      instructions: w?.instructions ?? null,
      papers: (rows.rows as { code: string; title: string; exam: string | null; scheduled_at: Date | null; room: string | null }[]).map((p) => ({
        code: p.code,
        title: p.title,
        exam: p.exam,
        when: p.scheduled_at ? wallClock(new Date(p.scheduled_at), zone) : null,
        room: p.room,
      })),
    }
  })
}

// --- backlogs ---------------------------------------------------------------------

const TYPE_WORDS = { internal: 'internal assessment', university: 'university exam', both: 'internal assessment and university exam' } as const

export async function bookBacklog(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const d = bookBacklogSchema.parse(input)
  const feesOn = await moduleEnabled(KNOWN, 'fees', tenant)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [b] = await tx
        .insert(backlogBookings)
        .values({ institutionId: tenant, termId: d.termId, studentId: actor.id, courseId: d.courseId, bookingType: d.bookingType })
        .returning()
      const [c] = await tx.select({ code: courses.code, title: courses.title }).from(courses).where(eq(courses.id, d.courseId))
      let billed = false
      if (b!.feePaise > 0 && feesOn) {
        // The booking and its fee land together or not at all.
        await chargeStudentWithin(tx, tenant, actor.id, {
          studentId: actor.id,
          termId: d.termId,
          label: `Backlog: ${c!.code} ${c!.title} (${TYPE_WORDS[d.bookingType]})`,
          amountPaise: b!.feePaise,
          sourceModule: MODULE,
          sourceId: b!.id,
        })
        billed = true
      }
      const fee = b!.feePaise ? formatPaise(b!.feePaise) : null
      return {
        ...b!,
        notice: `Booked ${c!.code} (${TYPE_WORDS[d.bookingType]}).${fee ? ` Fee ${fee}${billed ? ', added to your fees' : ', payable at the office'}.` : ''}`,
      }
    }),
  )
}

export async function cancelBacklog(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = cancelBacklogSchema.parse(input)
  const feesOn = await moduleEnabled(KNOWN, 'fees', tenant)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [b] = await tx.select().from(backlogBookings).where(eq(backlogBookings.id, d.bookingId))
      if (!b) throw new ExamError(404, 'no_such_booking', 'no such booking')
      if (actor.role === 'student') {
        if (b.studentId !== actor.id) throw new ExamError(403, 'forbidden', 'not permitted')
        const [w] = await tx.select().from(examWindows).where(and(eq(examWindows.termId, b.termId), eq(examWindows.kind, 'backlog')))
        if (phaseOf(w) !== 'open') throw new ExamError(409, 'exam_backlog_window', 'the backlog window has closed; ask the examination cell')
      } else if (!isAdmin(actor.role)) {
        throw new ExamError(403, 'forbidden', 'not permitted')
      }
      if (feesOn) await cancelChargeForSourceWithin(tx, MODULE, b.id, d.reason)
      await tx
        .update(backlogBookings)
        .set({ cancelledAt: new Date(), cancelledBy: actor.id, cancelReason: d.reason })
        .where(eq(backlogBookings.id, b.id))
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'cancel',
        entity: 'exam_backlog_bookings',
        entityId: b.id,
        reason: d.reason,
      })
      return { id: b.id, notice: 'Booking cancelled, and its fee with it.' }
    }),
  )
}

export async function backlogList(actor: Actor, termId: string) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ b: backlogBookings, student: users.name, email: users.email, code: courses.code, title: courses.title })
      .from(backlogBookings)
      .innerJoin(users, eq(users.id, backlogBookings.studentId))
      .innerJoin(courses, eq(courses.id, backlogBookings.courseId))
      .where(eq(backlogBookings.termId, termId))
      .orderBy(asc(courses.code), asc(users.name))
    return rows.map((r) => ({
      ...r.b,
      student: r.student ?? r.email ?? r.b.studentId,
      course: `${r.code} ${r.title}`,
      typeText: TYPE_WORDS[r.b.bookingType],
      fee: formatPaise(r.b.feePaise),
      state: r.b.cancelledAt ? 'cancelled' : 'booked',
    }))
  })
}

// --- the semester grade report ----------------------------------------------------

export interface GradeReport {
  institution: string
  term: { code: string; name: string }
  student: { name: string; rollNo: string | null; registrationNo: string | null; programme: string | null }
  courses: { code: string; title: string; credits: number; grade: string | null; points: number | null; passed: boolean }[]
  sgpa: number | null
  cgpa: number | null
  creditsEarned: number
  creditsEarnedTotal: number
}

/**
 * A term's grades from the official record -- finalised courses only -- with
 * the term's average and the cumulative one up to and including it. Held for
 * a student whose required feedback is outstanding, where the institution
 * says so and the feedback module is on.
 */
export async function gradeReport(actor: Actor, studentId: string, termId: string): Promise<GradeReport> {
  const tenant = tenantOf(actor)
  mayRead(actor, studentId)
  if (actor.role === 'student') {
    const g = await feedbackGate(actor, tenant, studentId, termId)
    if (g.applies && !g.complete) {
      throw new ExamError(
        409,
        'feedback_first',
        `please give your feedback before downloading the grade report: ${g.owed.map((o) => o.course).join(', ')}`,
      )
    }
  }
  const p = await studentProfile(actor as unknown as AcademicActor, studentId)
  return withTenant(tenant, async (tx) => {
    const [t] = await tx.select().from(terms).where(eq(terms.id, termId))
    if (!t) throw new ExamError(404, 'no_such_term', 'no such term')
    const [inst] = await tx.select({ name: institutions.name }).from(institutions).where(eq(institutions.id, tenant))
    const rows = await tx
      .select({
        termId: courseCompletions.termId,
        startsOn: terms.startsOn,
        code: courses.code,
        title: courses.title,
        credits: courseCompletions.credits,
        grade: courseCompletions.gradeLabel,
        points: courseCompletions.gradePoints,
        passed: courseCompletions.passed,
      })
      .from(courseCompletions)
      .innerJoin(courses, eq(courses.id, courseCompletions.courseId))
      .innerJoin(terms, eq(terms.id, courseCompletions.termId))
      .where(and(eq(courseCompletions.studentId, studentId), sql`${terms.startsOn} <= ${t.startsOn}`))
      .orderBy(asc(courses.code))
    const shape = (r: (typeof rows)[number]) => ({
      percent: 0,
      complete: true,
      label: r.grade,
      points: r.points === null ? null : Number(r.points),
      passed: r.passed,
      credits: r.credits,
    })
    const these = rows.filter((r) => r.termId === termId)
    if (!these.length) throw new ExamError(409, 'no_results', 'no finalised results for that term yet')
    return {
      institution: inst?.name ?? '',
      term: { code: t.code, name: t.name },
      student: { name: p.name, rollNo: p.rollNo, registrationNo: p.registrationNo, programme: await leadingProgramme(tx, studentId) },
      courses: these.map((r) => ({
        code: r.code,
        title: r.title,
        credits: r.credits,
        grade: r.grade,
        points: r.points === null ? null : Number(r.points),
        passed: r.passed,
      })),
      sgpa: gpa(these.map(shape)).value,
      cgpa: gpa(rows.map(shape)).value,
      creditsEarned: these.filter((r) => r.passed).reduce((n, r) => n + r.credits, 0),
      creditsEarnedTotal: rows.filter((r) => r.passed).reduce((n, r) => n + r.credits, 0),
    }
  })
}

// --- question papers --------------------------------------------------------------

async function examFor(tx: Tx, actor: Actor, examId: string) {
  const [x] = await tx
    .select({ exam: exams, faculty: offerings.facultyUserId, code: courses.code, title: courses.title })
    .from(exams)
    .innerJoin(offerings, eq(offerings.id, exams.offeringId))
    .innerJoin(courses, eq(courses.id, offerings.courseId))
    .where(eq(exams.id, examId))
  if (!x) throw new ExamError(404, 'no_such_exam', 'no such exam')
  if (actor.role === 'faculty' && x.faculty !== actor.id) throw new ExamError(403, 'not_your_offering', 'that is not your course')
  return x
}

export async function uploadPaper(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = uploadPaperSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await examFor(tx, actor, d.examId)
      const f = readUpload(d.paper, { types: ['application/pdf'], maxBytes: 8 * 1024 * 1024, what: 'the question paper' })
      const [row] = await tx
        .insert(questionPapers)
        .values({
          institutionId: tenant,
          examId: d.examId,
          version: 0,
          fileName: f.name,
          contentType: f.type,
          sizeBytes: f.size,
          sha256: f.sha256,
          content: f.bytes,
          uploadedBy: actor.id,
        })
        .returning({ id: questionPapers.id, version: questionPapers.version, sha256: questionPapers.sha256 })
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'upload',
        entity: 'exam_question_papers',
        entityId: row!.id,
        reason: `version ${row!.version}, sha256 ${row!.sha256.slice(0, 16)}`,
      })
      return { ...row!, notice: `Sealed as version ${row!.version}. Keep this fingerprint: ${row!.sha256.slice(0, 16)}…` }
    }),
  )
}

/** The papers for an exam, without their contents, and when they open. */
export async function papersFor(actor: Actor, examId: string) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const x = await examFor(tx, actor, examId)
    const s = await settingsOf(tx, tenant)
    const list = await tx
      .select({
        id: questionPapers.id,
        version: questionPapers.version,
        fileName: questionPapers.fileName,
        sizeBytes: questionPapers.sizeBytes,
        sha256: questionPapers.sha256,
        uploadedAt: questionPapers.uploadedAt,
        supersededAt: questionPapers.supersededAt,
        uploader: users.name,
      })
      .from(questionPapers)
      .leftJoin(users, eq(users.id, questionPapers.uploadedBy))
      .where(eq(questionPapers.examId, examId))
      .orderBy(desc(questionPapers.version))
    const releaseAt = x.exam.scheduledAt ? new Date(x.exam.scheduledAt.getTime() - s.paperReleaseMinutes * 60_000) : null
    const released = releaseAt !== null && Date.now() >= releaseAt.getTime()
    return {
      exam: { ...x.exam, course: `${x.code} ${x.title}` },
      releaseAt,
      released,
      releaseMinutes: s.paperReleaseMinutes,
      papers: list.map((p) => ({ ...p, state: p.supersededAt ? 'superseded' : released ? 'released' : 'sealed' })),
    }
  })
}

/** The paper itself: the examination cell, from the release time, on the record. */
export async function downloadPaper(actor: Actor, paperId: string) {
  const tenant = requireAdmin(actor)
  return withTenant(tenant, async (tx) => {
    const [p] = await tx.select().from(questionPapers).where(eq(questionPapers.id, paperId))
    if (!p) throw new ExamError(404, 'no_such_paper', 'no such paper')
    const [x] = await tx.select().from(exams).where(eq(exams.id, p.examId))
    const s = await settingsOf(tx, tenant)
    if (!x?.scheduledAt || Date.now() < x.scheduledAt.getTime() - s.paperReleaseMinutes * 60_000) {
      throw new ExamError(409, 'sealed', 'the paper is sealed until shortly before the exam')
    }
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'download',
      entity: 'exam_question_papers',
      entityId: p.id,
      reason: `version ${p.version} downloaded for the exam`,
    })
    return { fileName: p.fileName, contentType: p.contentType, content: p.content }
  })
}

// --- statistics -----------------------------------------------------------------

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)

/** How an exam went: the spread, the middle, and how many passed. */
export async function examStats(actor: Actor, examId: string) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const x = await examFor(tx, actor, examId)
    const marks = await tx.select().from(examMarks).where(eq(examMarks.examId, examId))
    const max = Number(x.exam.maxMarks)
    const sat = marks.filter((m) => !m.absent && m.obtained !== null).map((m) => (Number(m.obtained) / max) * 100)
    const passFloor = await tx.execute(sql`
      select coalesce(min(b.min_percent) filter (where b.is_pass), 40)::float as floor
        from exam_grade_bands b join exam_grading_schemes s on s.id = b.scheme_id
       where s.is_default`)
    const floor = Number((passFloor.rows[0] as { floor: number } | undefined)?.floor ?? 40)
    const bands = Array.from({ length: 10 }, (_, i) => ({
      band: `${i * 10}–${i === 9 ? 100 : i * 10 + 9}`,
      students: sat.filter((p) => (i === 9 ? p >= 90 : p >= i * 10 && p < i * 10 + 10)).length,
    }))
    return {
      exam: { ...x.exam, course: `${x.code} ${x.title}`, published: x.exam.publishedAt !== null },
      entered: marks.length,
      absent: marks.filter((m) => m.absent).length,
      sat: sat.length,
      mean: r1(sat.length ? sat.reduce((a, b) => a + b, 0) / sat.length : null),
      median: r1(median(sat)),
      highest: r1(sat.length ? Math.max(...sat) : null),
      lowest: r1(sat.length ? Math.min(...sat) : null),
      passFloor: floor,
      passRate: sat.length ? r1((sat.filter((p) => p >= floor).length / sat.length) * 100) : null,
      bands,
    }
  })
}

/** One student across every published exam, beside their class. */
export async function studentPerformance(actor: Actor, studentId: string) {
  const tenant = tenantOf(actor)
  mayRead(actor, studentId)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.execute(sql`
      select t.code as term, c.code as course, x.name as exam, x.kind, x.max_marks::float as max,
             m.obtained::float as obtained, m.absent,
             (select avg(m2.obtained / x.max_marks * 100)::float from exam_marks m2
               where m2.exam_id = x.id and not m2.absent and m2.obtained is not null) as class_mean
        from exam_marks m
        join exams x on x.id = m.exam_id and x.published_at is not null
        join academic_offerings o on o.id = x.offering_id
        join academic_courses c on c.id = o.course_id
        join academic_terms t on t.id = o.term_id
       where m.student_id = ${studentId}
       order by t.starts_on, c.code, x.scheduled_at nulls last`)
    return (rows.rows as { term: string; course: string; exam: string; kind: string; max: number; obtained: number | null; absent: boolean; class_mean: number | null }[]).map(
      (r) => {
        const pct = r.absent || r.obtained === null ? null : (r.obtained / r.max) * 100
        return {
          term: r.term,
          course: r.course,
          exam: r.exam,
          kind: r.kind,
          percent: r1(pct),
          classMean: r1(r.class_mean),
          versus: pct === null || r.class_mean === null ? null : r1(pct - r.class_mean),
          absent: r.absent,
        }
      },
    )
  })
}

