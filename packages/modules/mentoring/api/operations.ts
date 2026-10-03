import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import { moduleEnabled, readUpload, UploadError, type Role } from '@campusos/module-framework'
import { sectionMembers, sections, programs, terms } from '@campusos/module-academic/schema'
import { studentProfile } from '@campusos/module-academic/api'
import { attendanceSummary } from '@campusos/module-attendance/api'
import { manifest as attendanceManifest } from '@campusos/module-attendance/manifest'
import { officialTranscript } from '@campusos/module-examinations/api'
import { manifest as examinationsManifest } from '@campusos/module-examinations/manifest'
import { studentLedger } from '@campusos/module-fees/api'
import { manifest as feesManifest } from '@campusos/module-fees/manifest'
import { housingOf, recordLeaveWithin, withdrawLeaveWithin } from '@campusos/module-hostel/api'
import { manifest as hostelManifest } from '@campusos/module-hostel/manifest'
import { formatPaise } from '@campusos/money'
import { manifest } from '../manifest'
import { assignments, leaveApplications, leaveTypes, messages, notes, type LeaveApplication } from '../schema'
import {
  applyLeaveSchema,
  assignSchema,
  cancelLeaveSchema,
  decideLeaveSchema,
  endAssignmentSchema,
  leaveTypeSchema,
  messageSchema,
  noteSchema,
  retireLeaveTypeSchema,
} from './schemas'
import { instant, wallClock } from './time'

const MODULE = 'mentoring'
const ZONE = 'Asia/Kolkata'
const KNOWN = [manifest, attendanceManifest, examinationsManifest, feesManifest, hostelManifest]

export interface Actor {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class MentorError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
/** The other modules take their own actor types, all the same shape. */
type Any = never

const tenantOf = (actor: Actor) => {
  if (!actor.institutionId) throw new MentorError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
const isAdmin = (r: Role) => r === 'institution_admin' || r === 'super_admin'
/** Assigns mentors and sees every mentee. */
const runs = (r: Role) => isAdmin(r) || r === 'hod'
const isStaff = (r: Role) => runs(r) || r === 'faculty'
const requireRunner = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!runs(actor.role)) throw new MentorError(403, 'forbidden', 'not permitted')
  return t
}
const requireStudent = (actor: Actor) => {
  const t = tenantOf(actor)
  if (actor.role !== 'student') throw new MentorError(403, 'forbidden', 'this is the student’s to do')
  return t
}
const who = (actor: Actor, tenant: string) => ({ institutionId: tenant, actorId: actor.id, actorEmail: actor.email ?? null, moduleId: MODULE })

const REFUSALS: Record<string, [400 | 403 | 409, string]> = {
  mentor_assignments_current: [409, 'that student already has a mentor'],
  mentor_assignments_two: [400, 'a co-mentor is somebody other than the mentor'],
  mentor_student: [400, 'a mentee is a student'],
  mentor_staff: [400, 'a mentor is a member of staff'],
  mentor_assignment_fixed: [409, 'an assignment only ends, once'],
  mentor_assignment_kept: [409, 'an assignment is ended, not deleted'],
  mentor_note_author: [403, 'notes are written by staff'],
  mentor_note_kept: [409, 'a note is kept as written; add another to correct it'],
  mentor_message_sender: [403, 'only the student and their mentors write here'],
  mentor_message_fixed: [409, 'a message is left as it was sent'],
  mentor_leave_types_name: [409, 'there is already a kind of leave with that name'],
  leave_student: [403, 'leave is asked for by a student'],
  leave_type_retired: [409, 'that kind of leave is no longer offered'],
  leave_document_required: [400, 'that kind of leave needs a supporting document (a PDF)'],
  leave_too_long: [400, 'that is longer than this kind of leave allows'],
  leave_overlap: [409, 'you already have leave asked for or granted over those days'],
  leave_fixed: [409, 'what was asked for does not change'],
  leave_decided: [409, 'that leave has been decided'],
  leave_reason: [400, 'say why the leave is refused'],
  leave_kept: [409, 'a leave application is kept'],
  mentor_leave_applications_days: [400, 'leave ends on or after the day it starts'],
  mentor_leave_applications_times: [400, 'you come back after you leave'],
  hostel_leaves_no_overlap: [409, 'the hostel already has leave for those days'],
}

async function named<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof MentorError) throw e
    if (e instanceof UploadError) throw new MentorError(400, e.code, e.message)
    const c = (e as { cause?: { constraint?: string } }).cause?.constraint ?? (e as { constraint?: string }).constraint
    const known = c ? REFUSALS[c] : undefined
    if (known) throw new MentorError(known[0], c!, known[1])
    throw e
  }
}


// --- who mentors whom -------------------------------------------------------------

async function currentOf(tx: Tx, studentId: string) {
  const [a] = await tx
    .select()
    .from(assignments)
    .where(and(eq(assignments.studentId, studentId), isNull(assignments.toOn)))
  return a ?? null
}

/** Whether this reader may see this student as a mentor does. */
async function assertMentorOf(tx: Tx, actor: Actor, studentId: string) {
  if (runs(actor.role)) return
  const a = await currentOf(tx, studentId)
  if (!a || (a.mentorId !== actor.id && a.coMentorId !== actor.id)) {
    throw new MentorError(403, 'not_your_mentee', 'that student is not your mentee')
  }
}

/**
 * Give students a mentor (and a co-mentor): one, several ticked, or a whole
 * section. A student who had one has it ended today and the new one begins,
 * so the history says who was responsible when.
 */
export async function assignMentor(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = assignSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      let ids = d.studentIds ?? []
      if (d.sectionId) {
        const members = await tx
          .select({ id: sectionMembers.userId })
          .from(sectionMembers)
          .innerJoin(users, and(eq(users.id, sectionMembers.userId), eq(users.role, 'student')))
          .where(eq(sectionMembers.sectionId, d.sectionId))
        ids = [...new Set([...ids, ...members.map((m) => m.id)])]
      }
      if (!ids.length) throw new MentorError(400, 'nobody', 'that section has no students')
      const today = new Date().toISOString().slice(0, 10)
      let changed = 0
      for (const studentId of ids) {
        const cur = await currentOf(tx, studentId)
        if (cur && cur.mentorId === d.mentorId && (cur.coMentorId ?? null) === (d.coMentorId ?? null)) continue
        if (cur) await tx.update(assignments).set({ toOn: today }).where(eq(assignments.id, cur.id))
        await tx.insert(assignments).values({
          institutionId: tenant,
          studentId,
          mentorId: d.mentorId,
          coMentorId: d.coMentorId ?? null,
          fromOn: today,
          reason: d.reason ?? null,
          assignedBy: actor.id,
        })
        changed++
      }
      await audit(tx, {
        ...who(actor, tenant),
        action: 'assign',
        entity: 'mentor_assignments',
        entityId: d.mentorId,
        reason: d.reason ?? `${changed} student(s) to a mentor`,
      })
      return { assigned: changed, notice: `${changed} student${changed === 1 ? '' : 's'} given ${changed === 1 ? 'this mentor' : 'these mentors'}.` }
    }),
  )
}

export async function endAssignments(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = endAssignmentSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const today = new Date().toISOString().slice(0, 10)
      const rows = await tx
        .update(assignments)
        .set({ toOn: today })
        .where(and(inArray(assignments.studentId, d.studentIds), isNull(assignments.toOn)))
        .returning({ id: assignments.id })
      await audit(tx, { ...who(actor, tenant), action: 'end', entity: 'mentor_assignments', entityId: rows[0]?.id ?? 'none', reason: d.reason })
      return { ended: rows.length, notice: `${rows.length} ended.` }
    }),
  )
}

/** Every student, with their mentor and co-mentor now. */
export async function assignmentList(actor: Actor) {
  const tenant = requireRunner(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.execute(sql`
      select u.id as student_id, coalesce(u.name, u.email) as student, p.roll_no,
             a.from_on, coalesce(m.name, m.email) as mentor, coalesce(cm.name, cm.email) as co_mentor,
             (select string_agg(distinct s.label || ' ' || pr.code, ', ')
                from academic_section_members sm join academic_sections s on s.id = sm.section_id
                join academic_programs pr on pr.id = s.program_id where sm.user_id = u.id) as section
        from users u
        left join academic_student_profiles p on p.student_id = u.id
        left join mentor_assignments a on a.student_id = u.id and a.to_on is null
        left join users m on m.id = a.mentor_id
        left join users cm on cm.id = a.co_mentor_id
       where u.role = 'student'
       order by a.id is not null, student`)
    return (rows.rows as {
      student_id: string
      student: string
      roll_no: string | null
      from_on: string | null
      mentor: string | null
      co_mentor: string | null
      section: string | null
    }[]).map((r) => ({
      studentId: r.student_id,
      student: r.student,
      rollNo: r.roll_no,
      section: r.section,
      mentor: r.mentor,
      coMentor: r.co_mentor,
      since: r.from_on ? String(r.from_on).slice(0, 10) : null,
      state: r.mentor ? 'assigned' : 'unassigned',
    }))
  })
}

export async function staffChoices(actor: Actor) {
  const tenant = requireRunner(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(inArray(users.role, ['faculty', 'hod']))
      .orderBy(asc(users.name))
    return rows.map((u) => ({ value: u.id, label: u.name ?? u.email ?? u.id }))
  })
}

export async function sectionChoices(actor: Actor) {
  const tenant = requireRunner(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ id: sections.id, label: sections.label, year: sections.admissionYear, program: programs.code })
      .from(sections)
      .innerJoin(programs, eq(programs.id, sections.programId))
      .orderBy(asc(programs.code), asc(sections.label))
    return rows.map((s) => ({ value: s.id, label: `${s.program} ${s.label} (${s.year})` }))
  })
}

// --- a mentor's mentees -------------------------------------------------------------

/** The signed-in teacher's mentees, with what wants their attention. */
export async function myMentees(actor: Actor) {
  const tenant = tenantOf(actor)
  if (!isStaff(actor.role)) throw new MentorError(403, 'forbidden', 'not permitted')
  const attendanceOn = await moduleEnabled(KNOWN, 'attendance', tenant)
  const list = await withTenant(tenant, async (tx) => {
    const rows = await tx.execute(sql`
      select a.student_id, coalesce(u.name, u.email) as student, p.roll_no,
             case when a.mentor_id = ${actor.id} then 'mentor' else 'co-mentor' end as as_role,
             (select count(*)::int from mentor_leave_applications l where l.student_id = a.student_id and l.status = 'pending') as leave_waiting,
             (select count(*)::int from mentor_messages mm where mm.student_id = a.student_id
                 and mm.sender_id = a.student_id and mm.read_at is null) as unread,
             (select max(n.met_on) from mentor_notes n where n.student_id = a.student_id) as last_note
        from mentor_assignments a
        join users u on u.id = a.student_id
        left join academic_student_profiles p on p.student_id = a.student_id
       where a.to_on is null and ${actor.id} in (a.mentor_id, a.co_mentor_id)
       order by student`)
    return rows.rows as { student_id: string; student: string; roll_no: string | null; as_role: string; leave_waiting: number; unread: number; last_note: string | null }[]
  })
  const out = []
  for (const r of list) {
    let attendance: number | null = null
    if (attendanceOn) {
      const lines = await attendanceSummary(actor as Any, r.student_id)
      const held = lines.reduce((n, l) => n + l.held, 0)
      const present = lines.reduce((n, l) => n + l.present, 0)
      attendance = held ? Math.round((present / held) * 1000) / 10 : null
    }
    out.push({
      studentId: r.student_id,
      student: r.student,
      rollNo: r.roll_no,
      as: r.as_role,
      attendance,
      low: attendance !== null && attendance < 75,
      leaveWaiting: r.leave_waiting,
      unread: r.unread,
      lastNote: r.last_note ? String(r.last_note).slice(0, 10) : null,
    })
  }
  return out
}

/**
 * The whole of a student, for their mentor: who they are, their attendance
 * class by class, their results, what they owe, where they live, their leave,
 * the notes kept and the conversation. Each part from the module that owns
 * it, and only where that module is on.
 */
export async function menteeView(actor: Actor, studentId: string) {
  const tenant = tenantOf(actor)
  if (!isStaff(actor.role)) throw new MentorError(403, 'forbidden', 'not permitted')
  await withTenant(tenant, (tx) => assertMentorOf(tx, actor, studentId))
  const [attendanceOn, examsOn, feesOn, hostelOn] = await Promise.all(
    ['attendance', 'examinations', 'fees', 'hostel'].map((m) => moduleEnabled(KNOWN, m, tenant)),
  )
  const profile = await studentProfile(actor as Any, studentId)
  const attendance = attendanceOn ? await attendanceSummary(actor as Any, studentId) : null
  const results = examsOn
    ? await officialTranscript(actor as Any, studentId).then(
        (t) => ({ terms: t.terms.map((x) => ({ term: x.termCode, gpa: x.gpa, credits: x.credits, courses: x.grades.length, failed: x.grades.filter((g) => !g.passed).length })), cgpa: t.cumulativeGpa }),
        () => null,
      )
    : null
  const base = await withTenant(tenant, async (tx) => {
    const current = await currentOf(tx, studentId)
    const names = async (id: string | null | undefined) => {
      if (!id) return null
      const [u] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, id))
      return u?.name ?? u?.email ?? id
    }
    const [term] = await tx.select().from(terms).where(sql`is_current`).limit(1)
    const [prog] = await tx
      .select({ code: programs.code, name: programs.name, label: sections.label })
      .from(sectionMembers)
      .innerJoin(sections, eq(sections.id, sectionMembers.sectionId))
      .innerJoin(programs, eq(programs.id, sections.programId))
      .where(eq(sectionMembers.userId, studentId))
      .limit(1)
    const history = await tx
      .select({ a: assignments, mentor: users.name })
      .from(assignments)
      .leftJoin(users, eq(users.id, assignments.mentorId))
      .where(eq(assignments.studentId, studentId))
      .orderBy(desc(assignments.fromOn))
    return {
      current,
      mentor: await names(current?.mentorId),
      coMentor: await names(current?.coMentorId),
      term: term ?? null,
      programme: prog ? `${prog.code} ${prog.name}, section ${prog.label}` : null,
      housing: hostelOn ? await housingOf(tx, studentId) : null,
      history: history.map((h) => ({ mentor: h.mentor, from: h.a.fromOn, to: h.a.toOn, reason: h.a.reason })),
      leave: await leaveRows(tx, studentId),
      notes: await noteRows(tx, studentId, true),
      thread: await threadRows(tx, actor, studentId),
    }
  })
  const fees = feesOn && base.term
    ? await studentLedger(actor as Any, studentId, base.term.id).then(
        (l) => ({ term: base.term!.code, payable: formatPaise(l.payablePaise), paid: formatPaise(l.paidPaise), outstanding: formatPaise(l.outstandingPaise), owes: l.outstandingPaise > 0 }),
        () => null,
      )
    : null
  const held = attendance?.reduce((n, l) => n + l.held, 0) ?? 0
  const present = attendance?.reduce((n, l) => n + l.present, 0) ?? 0
  return {
    profile,
    programme: base.programme,
    mentor: base.mentor,
    coMentor: base.coMentor,
    current: base.current,
    housing: base.housing,
    attendance,
    attendanceOverall: held ? Math.round((present / held) * 1000) / 10 : null,
    results,
    fees,
    history: base.history,
    leave: base.leave,
    notes: base.notes,
    thread: base.thread,
    modules: { attendance: attendanceOn, examinations: examsOn, fees: feesOn, hostel: hostelOn },
  }
}

// --- notes and the conversation -----------------------------------------------------

async function noteRows(tx: Tx, studentId: string, all: boolean) {
  const rows = await tx
    .select({ n: notes, author: users.name })
    .from(notes)
    .leftJoin(users, eq(users.id, notes.authorId))
    .where(and(eq(notes.studentId, studentId), all ? undefined : eq(notes.shared, true)))
    .orderBy(desc(notes.metOn), desc(notes.createdAt))
  return rows.map((r) => ({ ...r.n, author: r.author, sharedText: r.n.shared ? 'shared' : 'private' }))
}

/** The thread, oldest first; whatever the other side wrote is marked read now. */
async function threadRows(tx: Tx, actor: Actor, studentId: string) {
  const readerIsStudent = actor.id === studentId
  await tx
    .update(messages)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(messages.studentId, studentId),
        isNull(messages.readAt),
        readerIsStudent ? ne(messages.senderId, studentId) : eq(messages.senderId, studentId),
      ),
    )
  const rows = await tx
    .select({ m: messages, sender: users.name, email: users.email })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(eq(messages.studentId, studentId))
    .orderBy(asc(messages.sentAt))
  return rows.map((r) => ({
    id: r.m.id,
    from: r.m.senderId === studentId ? 'student' : 'mentor',
    sender: r.sender ?? r.email ?? '',
    body: r.m.body,
    sent: wallClock(r.m.sentAt, ZONE),
    read: r.m.readAt ? wallClock(r.m.readAt, ZONE) : null,
  }))
}

export async function addNote(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!isStaff(actor.role)) throw new MentorError(403, 'forbidden', 'notes are written by staff')
  const d = noteSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await assertMentorOf(tx, actor, d.studentId)
      const [n] = await tx
        .insert(notes)
        .values({ institutionId: tenant, studentId: d.studentId, authorId: actor.id, metOn: d.metOn, kind: d.kind, body: d.body, shared: d.shared })
        .returning()
      return { ...n!, notice: d.shared ? 'Noted, and shared with the student.' : 'Noted. Private to the mentors and the office.' }
    }),
  )
}

export async function sendMessage(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = messageSchema.parse(input)
  const studentId = actor.role === 'student' ? actor.id : d.studentId
  if (!studentId) throw new MentorError(400, 'no_student', 'say which student')
  return named(() =>
    withTenant(tenant, async (tx) => {
      if (actor.role === 'student') {
        if (!(await currentOf(tx, actor.id))) throw new MentorError(409, 'no_mentor', 'you have no mentor yet; the office assigns one')
      }
      const [m] = await tx.insert(messages).values({ institutionId: tenant, studentId, senderId: actor.id, body: d.body }).returning()
      return { id: m!.id, notice: 'Sent.' }
    }),
  )
}

// --- leave --------------------------------------------------------------------------

async function leaveRows(tx: Tx, studentId?: string) {
  const rows = await tx
    .select({ l: leaveApplications, type: leaveTypes.name, student: users.name, email: users.email })
    .from(leaveApplications)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveApplications.leaveTypeId))
    .innerJoin(users, eq(users.id, leaveApplications.studentId))
    .where(studentId ? eq(leaveApplications.studentId, studentId) : undefined)
    .orderBy(desc(leaveApplications.startsOn))
  return rows.map((r) => shapeLeave(r.l, r.type, r.student ?? r.email ?? r.l.studentId))
}

function shapeLeave(l: LeaveApplication, type: string, student: string) {
  const { document: _bytes, ...rest } = l
  void _bytes
  return {
    ...rest,
    type,
    student,
    days: Math.round((Date.parse(l.endsOn) - Date.parse(l.startsOn)) / 86_400_000) + 1,
    leaving: wallClock(l.leavingAt, ZONE),
    arriving: wallClock(l.arrivingAt, ZONE),
    hasDocument: l.documentSha256 !== null,
    documentLink: l.documentSha256 ? 'Document' : '',
  }
}

export async function listLeaveTypes(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, (tx) => tx.select().from(leaveTypes).orderBy(asc(leaveTypes.retiredAt), asc(leaveTypes.name)))
}

export async function addLeaveType(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = leaveTypeSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [t] = await tx.insert(leaveTypes).values({ institutionId: tenant, name: d.name, needsDocument: d.needsDocument, maxDays: d.maxDays ?? null }).returning()
      return { ...t!, notice: 'Added. Students can ask for it now.' }
    }),
  )
}

export async function retireLeaveType(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = retireLeaveTypeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.update(leaveTypes).set({ retiredAt: new Date() }).where(and(eq(leaveTypes.id, d.leaveTypeId), isNull(leaveTypes.retiredAt)))
    return { notice: 'Retired. Applications already made stand.' }
  })
}

export async function applyLeave(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const d = applyLeaveSchema.parse(input)
  if (d.endsOn < d.startsOn) throw new MentorError(400, 'mentor_leave_applications_days', 'leave ends on or after the day it starts')
  return named(() =>
    withTenant(tenant, async (tx) => {
      const f = d.document ? readUpload(d.document, { types: ['application/pdf'], maxBytes: 5 * 1024 * 1024, what: 'the supporting document' }) : null
      const [l] = await tx
        .insert(leaveApplications)
        .values({
          institutionId: tenant,
          studentId: actor.id,
          leaveTypeId: d.leaveTypeId,
          startsOn: d.startsOn,
          endsOn: d.endsOn,
          purpose: d.purpose,
          placeOfVisit: d.placeOfVisit,
          leavingAt: instant(d.leavingAt, ZONE),
          arrivingAt: instant(d.arrivingAt, ZONE),
          contactPhone: d.contactPhone,
          documentName: f?.name ?? null,
          documentSha256: f?.sha256 ?? null,
          documentSize: f?.size ?? null,
          document: f?.bytes ?? null,
        })
        .returning({ id: leaveApplications.id, mentorId: leaveApplications.mentorId })
      return {
        id: l!.id,
        notice: l!.mentorId ? 'Asked. Your mentor decides; you will see it here.' : 'Asked. You have no mentor yet, so the office decides.',
      }
    }),
  )
}

/** Leave waiting on this reader: their mentees', or everybody's for the office. */
export async function pendingLeave(actor: Actor) {
  const tenant = tenantOf(actor)
  if (!isStaff(actor.role)) throw new MentorError(403, 'forbidden', 'not permitted')
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ l: leaveApplications, type: leaveTypes.name, student: users.name, email: users.email })
      .from(leaveApplications)
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveApplications.leaveTypeId))
      .innerJoin(users, eq(users.id, leaveApplications.studentId))
      .where(
        and(
          eq(leaveApplications.status, 'pending'),
          runs(actor.role)
            ? undefined
            : sql`exists (select 1 from mentor_assignments a where a.student_id = mentor_leave_applications.student_id
                            and a.to_on is null and ${actor.id} in (a.mentor_id, a.co_mentor_id))`,
        ),
      )
      .orderBy(asc(leaveApplications.startsOn))
    return rows.map((r) => shapeLeave(r.l, r.type, r.student ?? r.email ?? r.l.studentId))
  })
}

/**
 * The mentor (or co-mentor, or the office) decides. Approved leave is handed
 * to the hostel in the same act, where the hostel is on and the student lives
 * in it, so the roll call expects the empty bed.
 */
export async function decideLeave(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!isStaff(actor.role)) throw new MentorError(403, 'forbidden', 'not permitted')
  const d = decideLeaveSchema.parse(input)
  const hostelOn = await moduleEnabled(KNOWN, 'hostel', tenant)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [l] = await tx.select().from(leaveApplications).where(eq(leaveApplications.id, d.applicationId)).for('update')
      if (!l) throw new MentorError(404, 'no_such_leave', 'no such leave application')
      await assertMentorOf(tx, actor, l.studentId)
      if (l.status !== 'pending') throw new MentorError(409, 'leave_decided', 'that leave has been decided')
      let hostelLeaveId: string | null = null
      if (d.decision === 'approve' && hostelOn) {
        hostelLeaveId = await recordLeaveWithin(tx, tenant, actor.id, {
          studentId: l.studentId,
          fromOn: l.startsOn,
          toOn: l.endsOn,
          reason: `Leave approved by mentor: ${l.purpose}`.slice(0, 300),
        })
      }
      await tx
        .update(leaveApplications)
        .set({
          status: d.decision === 'approve' ? 'approved' : 'rejected',
          decidedBy: actor.id,
          decisionNote: d.note ?? null,
          hostelLeaveId,
        })
        .where(eq(leaveApplications.id, l.id))
      await audit(tx, {
        ...who(actor, tenant),
        action: d.decision,
        entity: 'mentor_leave_applications',
        entityId: l.id,
        reason: d.note ?? (d.decision === 'approve' ? 'approved' : 'refused'),
      })
      return {
        id: l.id,
        notice:
          d.decision === 'approve'
            ? `Approved.${hostelLeaveId ? ' The hostel roll call now expects the empty bed.' : ''}`
            : 'Refused. The student sees why.',
      }
    }),
  )
}

/** The student changes their plans: a pending or approved leave, before they go. */
export async function cancelLeave(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const d = cancelLeaveSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [l] = await tx.select().from(leaveApplications).where(eq(leaveApplications.id, d.applicationId)).for('update')
      if (!l || l.studentId !== actor.id) throw new MentorError(404, 'no_such_leave', 'no such leave application')
      if (l.status === 'approved' && l.leavingAt.getTime() <= Date.now()) {
        throw new MentorError(409, 'already_gone', 'that leave has begun; tell your mentor you are back early instead')
      }
      if (l.hostelLeaveId) await withdrawLeaveWithin(tx, l.hostelLeaveId)
      await tx
        .update(leaveApplications)
        .set({ status: 'cancelled', decisionNote: d.reason ?? l.decisionNote })
        .where(eq(leaveApplications.id, l.id))
      return { id: l.id, notice: 'Cancelled.' }
    }),
  )
}

/** The supporting document: the student, their mentors and the office. */
export async function leaveDocument(actor: Actor, applicationId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const [l] = await tx.select().from(leaveApplications).where(eq(leaveApplications.id, applicationId))
    if (!l?.document) throw new MentorError(404, 'no_document', 'no document with that application')
    if (actor.id !== l.studentId) {
      if (!isStaff(actor.role)) throw new MentorError(403, 'forbidden', 'not permitted')
      await assertMentorOf(tx, actor, l.studentId)
    }
    return { name: l.documentName ?? 'document.pdf', content: l.document }
  })
}

// --- the student's own page ---------------------------------------------------------

export async function myMentoring(actor: Actor) {
  const tenant = requireStudent(actor)
  const hostelOn = await moduleEnabled(KNOWN, 'hostel', tenant)
  return withTenant(tenant, async (tx) => {
    const current = await currentOf(tx, actor.id)
    const person = async (id: string | null | undefined) => {
      if (!id) return null
      const [u] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, id))
      return u ? { name: u.name ?? u.email ?? id, email: u.email } : null
    }
    const types = await tx.select().from(leaveTypes).where(isNull(leaveTypes.retiredAt)).orderBy(asc(leaveTypes.name))
    return {
      mentor: await person(current?.mentorId),
      coMentor: await person(current?.coMentorId),
      since: current?.fromOn ?? null,
      housing: hostelOn ? await housingOf(tx, actor.id) : null,
      thread: await threadRows(tx, actor, actor.id),
      notes: await noteRows(tx, actor.id, false),
      leaveTypes: types,
      leave: await leaveRows(tx, actor.id),
    }
  })
}

