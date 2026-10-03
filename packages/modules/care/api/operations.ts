import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { studentProfiles } from '@campusos/module-academic/schema'
import { notify } from '@campusos/module-notices/api'
import { appointments, counsellors, instruments, notes, requests, results, settings, shared } from '../schema'
import {
  BUILT_IN,
  CheckError,
  instrumentSchema,
  maxScore,
  optionsOf,
  score,
  type Check,
  type CheckBand,
  type CheckItem,
  type CheckOption,
} from './instruments'
import {
  acceptSchema,
  askSchema,
  bookSchema,
  cancelAppointmentSchema,
  closeSchema,
  counsellorActiveSchema,
  counsellorSchema,
  deleteResultSchema,
  handoverSchema,
  noteSchema,
  recordSchema,
  retireInstrumentSchema,
  settingsSchema,
  takeCheckSchema,
  withdrawSchema,
} from './schemas'
import { assertZone, instant, wallClock, ZoneError } from './time'

/**
 * Student care, as each person may see it.
 *
 * A student sees their own results, requests and appointments. A counsellor
 * sees the requests waiting for one -- with whatever results the student
 * chose to share -- and the cases they hold, with their notes. The office
 * names counsellors, writes checks and sets the helpline, and reads counts
 * (see statistics.ts); nothing here answers the office with a person.
 *
 * Case events are not written to the shared audit log, which the office can
 * read: a handover's reason goes into the case's own notes instead. What the
 * office does here -- counsellors, checks, settings -- is audited as usual.
 */

const MODULE = 'care'

export interface Actor {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class CareError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const tenantOf = (actor: Actor) => {
  if (!actor.institutionId) throw new CareError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
const isAdmin = (r: Role) => r === 'institution_admin' || r === 'super_admin'
const isStaff = (r: Role) => r !== 'student' && r !== 'parent' && r !== 'pending'
const requireStudent = (actor: Actor) => {
  const t = tenantOf(actor)
  if (actor.role !== 'student') throw new CareError(403, 'forbidden', 'this is for students')
  return t
}
const requireAdmin = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new CareError(403, 'forbidden', 'not permitted')
  return t
}
const who = (actor: Actor, tenant: string) => ({ institutionId: tenant, actorId: actor.id, actorEmail: actor.email ?? null, moduleId: MODULE })

const REFUSALS: Record<string, [400 | 403 | 409, string]> = {
  care_counsellor_kept: [409, 'a counsellor is made inactive, not removed'],
  care_counsellor_fixed: [409, 'a counsellor is a person; name another rather than changing this one'],
  care_counsellor_staff: [400, 'a counsellor is a member of staff'],
  care_counsellor_cases: [409, 'hand their open cases to another counsellor first'],
  care_instrument_kept: [409, 'a check is retired, not deleted'],
  care_instrument_fixed: [409, 'a check is fixed once written; write a new one'],
  care_instruments_code: [409, 'there is already a check with that code'],
  care_instruments_builtin: [409, 'that code is a built-in check'],
  care_result_fixed: [409, 'a result is kept as it was taken'],
  care_result_student: [403, 'a self-check is taken by a student'],
  care_result_instrument: [409, 'that check is no longer offered'],
  care_request_kept: [409, 'a request for counselling is kept'],
  care_request_student: [403, 'counselling is asked for by a student'],
  care_request_open: [409, 'you already have a request open'],
  care_request_fixed: [409, 'what the student asked does not change'],
  care_request_final: [409, 'that request is finished'],
  care_request_counsellor: [400, 'that is not one of the counsellors'],
  care_share_own: [403, 'only your own results go with your request'],
  care_share_open: [409, 'that request is finished'],
  care_appointment_kept: [409, 'an appointment is cancelled, not deleted'],
  care_appointment_case: [403, 'appointments are made by the counsellor holding an open case'],
  care_appointment_clash: [409, 'you have another appointment then'],
  care_appointment_fixed: [409, 'an appointment is cancelled and made again, not moved'],
  care_appointment_final: [409, 'that appointment is already recorded'],
  care_appointment_early: [409, 'an appointment is recorded once it has begun'],
  care_appointments_times: [400, 'an appointment lasts up to four hours, and ends after it starts'],
  care_note_author: [403, 'notes are written by the counsellor holding the case'],
  care_note_kept: [409, 'a note is kept as written; add another to correct it'],
}

async function named<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof CareError) throw e
    if (e instanceof CheckError) throw new CareError(400, 'check_answers', e.message)
    if (e instanceof ZoneError) throw new CareError(400, 'time_zone', e.message)
    const c = (e as { cause?: { constraint?: string } }).cause?.constraint ?? (e as { constraint?: string }).constraint
    const known = c ? REFUSALS[c] : undefined
    if (known) throw new CareError(known[0], c!, known[1])
    throw e
  }
}

const TOPICS = {
  studies: 'Studies and exams',
  mood: 'Low mood',
  anxiety: 'Worry and anxiety',
  relationships: 'Relationships',
  family: 'Family',
  health: 'Health',
  loss: 'Loss or grief',
  other: 'Something else',
  not_said: 'Not said',
} as const
const URGENCY = { routine: 'In the next week or two', soon: 'In the next few days', today: 'Today' } as const
const MODES = { in_person: 'In person', phone: 'By phone', video: 'By video call' } as const
const OUTCOMES = { supported: 'Supported', referred: 'Referred on', no_response: 'No response' } as const
export const words = { topics: TOPICS, urgency: URGENCY, modes: MODES, outcomes: OUTCOMES }

// --- settings, counsellors and checks ------------------------------------------------

async function settingsOf(tx: Tx, tenant: string) {
  const [s] = await tx.select().from(settings).where(eq(settings.institutionId, tenant))
  return { crisisLine: s?.crisisLine ?? '', contact: s?.contact ?? '', timeZone: s?.timeZone ?? 'Asia/Kolkata' }
}

/** What a student is told when they may be in danger: the institution's helpline, or the general rule. */
export const crisisText = (crisisLine: string | null | undefined) =>
  typeof crisisLine === 'string' && crisisLine.trim() ? crisisLine.trim() : 'your local emergency number'

async function activeCounsellor(tx: Tx, userId: string) {
  const [c] = await tx
    .select({ id: counsellors.id })
    .from(counsellors)
    .where(and(eq(counsellors.userId, userId), eq(counsellors.active, true)))
  return Boolean(c)
}

async function requireCounsellor(tx: Tx, actor: Actor) {
  if (!(await activeCounsellor(tx, actor.id))) {
    throw new CareError(403, 'not_a_counsellor', 'only the institution’s counsellors see requests for counselling')
  }
}

async function counsellorIds(tx: Tx) {
  const rows = await tx.select({ userId: counsellors.userId }).from(counsellors).where(eq(counsellors.active, true))
  return rows.map((r) => r.userId)
}

const fromRow = (r: typeof instruments.$inferSelect): Check => ({
  code: r.code,
  name: r.name,
  about: r.about,
  stem: r.stem,
  source: r.source,
  options: r.options as CheckOption[],
  items: r.items as CheckItem[],
  bands: r.bands as CheckBand[],
  builtIn: false,
  id: r.id,
})

/** The checks on offer -- or every one ever written, to read old results by. */
async function checksOf(tx: Tx, includeRetired = false) {
  const own = await tx
    .select()
    .from(instruments)
    .where(includeRetired ? undefined : eq(instruments.active, true))
    .orderBy(asc(instruments.name))
  return [...BUILT_IN, ...own.map(fromRow)]
}

const checkFor = (all: Check[], code: string, id?: string | null) =>
  all.find((c) => (id ? c.id === id : c.builtIn && c.code.toUpperCase() === code.toUpperCase())) ?? null

// --- a student's own ---------------------------------------------------------------

/** One check, to take: its questions and answers, and the helpline. */
export async function checkToTake(actor: Actor, code: string) {
  const tenant = requireStudent(actor)
  return withTenant(tenant, async (tx) => {
    const all = await checksOf(tx)
    const check = all.find((c) => c.code.toUpperCase() === code.toUpperCase())
    if (!check) throw new CareError(404, 'no_such_check', 'no such check')
    const s = await settingsOf(tx, tenant)
    return { check, max: maxScore(check), crisisLine: s.crisisLine }
  })
}

/**
 * Take a check. The answers are scored here, as the check is published; the
 * result is the student's alone.
 */
export async function takeCheck(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const raw = (input ?? {}) as Record<string, unknown>
  const d = takeCheckSchema.parse({ code: raw.code, answers: Array.isArray(raw.answers) ? raw.answers : [] })
  return named(() =>
    withTenant(tenant, async (tx) => {
      const check = (await checksOf(tx)).find((c) => c.code.toUpperCase() === d.code.toUpperCase())
      if (!check) throw new CareError(404, 'no_such_check', 'no such check')
      // A form sends a0, a1, ...; an API caller sends the list.
      const given: unknown[] = Array.isArray(raw.answers) ? d.answers : check.items.map((_, i) => raw[`a${i}`])
      const answers = check.items.map((_, i) => {
        const v = given[i]
        if (v === undefined || v === null || v === '') return null
        const n = Number(v)
        return Number.isInteger(n) ? n : -1
      })
      const s = score(check, answers)
      const [row] = await tx
        .insert(results)
        .values({
          institutionId: tenant,
          studentId: actor.id,
          instrumentCode: check.code,
          instrumentId: check.id,
          answers: answers as number[],
          score: s.score,
          maxScore: s.max,
          band: s.band.label,
          bandRank: s.rank,
          safety: s.safety,
        })
        .returning({ id: results.id })
      return {
        id: row!.id,
        score: s.score,
        max: s.max,
        band: s.band.label,
        safety: s.safety,
        notice: `${check.name}: ${s.score} of ${s.max}, ${s.band.label.toLowerCase()}. Only you can see this.`,
        next: `/m/care/result?id=${row!.id}`,
      }
    }),
  )
}

/**
 * One result, read by the student who took it, or by a counsellor it was
 * shared with: any counsellor while the request waits, and then the one who
 * holds it. Nobody else, the office included.
 */
export async function resultView(actor: Actor, resultId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const [r] = await tx.select().from(results).where(eq(results.id, resultId))
    if (!r) throw new CareError(404, 'no_such_result', 'no such result')
    const mine = r.studentId === actor.id
    if (!mine) {
      // Not found, rather than forbidden, to anyone else: that a result
      // exists is itself the student's to tell.
      if (!isStaff(actor.role) || !(await activeCounsellor(tx, actor.id))) {
        throw new CareError(404, 'no_such_result', 'no such result')
      }
      const [seen] = await tx
        .select({ id: requests.id })
        .from(shared)
        .innerJoin(requests, eq(requests.id, shared.requestId))
        .where(
          and(eq(shared.resultId, resultId), sql`(${requests.status} = 'waiting' or ${requests.counsellorId} = ${actor.id})`),
        )
      if (!seen) throw new CareError(404, 'no_such_result', 'no such result')
    }
    const all = await checksOf(tx, true)
    const check = checkFor(all, r.instrumentCode, r.instrumentId)
    const s = await settingsOf(tx, tenant)
    const band = check?.bands[r.bandRank]
    const [student] = mine ? [null] : await tx.select({ name: users.name }).from(users).where(eq(users.id, r.studentId))
    const [open] = mine
      ? await tx
          .select({ id: requests.id, status: requests.status, urgency: requests.urgency, counsellor: users.name })
          .from(requests)
          .leftJoin(users, eq(users.id, requests.counsellorId))
          .where(and(eq(requests.studentId, actor.id), inArray(requests.status, ['waiting', 'accepted'])))
      : [null]
    const sharedWith = mine
      ? (await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(shared).where(eq(shared.resultId, resultId)))[0]!.n
      : 0
    return {
      id: r.id,
      mine,
      student: student?.name ?? null,
      code: r.instrumentCode,
      name: check?.name ?? r.instrumentCode,
      about: check?.about ?? '',
      source: check?.source ?? '',
      takenAt: wallClock(r.takenAt, s.timeZone),
      score: r.score,
      max: r.maxScore,
      band: r.band,
      rank: r.bandRank,
      top: (check?.bands.length ?? 1) - 1,
      advice: band?.advice ?? '',
      safety: r.safety,
      answers: (check?.items ?? []).map((item, i) => {
        const a = r.answers[i]
        const option = a === null || a === undefined ? null : optionsOf(check!, item)[a]
        return {
          n: i + 1,
          question: item.text,
          answer: option?.label ?? '—',
          points: item.scored === false || !option ? '' : String(option.score),
          flagged: Boolean(item.safety && option && option.score > 0),
        }
      }),
      crisisLine: s.crisisLine,
      contact: s.contact,
      openRequest: open ?? null,
      sharedWith,
    }
  })
}

/** The student deletes a result of theirs; a counsellor it was shared with no longer sees it. */
export async function deleteResult(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const d = deleteResultSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const gone = await tx
      .delete(results)
      .where(and(eq(results.id, d.resultId), eq(results.studentId, actor.id)))
      .returning({ id: results.id })
    if (!gone.length) throw new CareError(404, 'no_such_result', 'no such result')
    return { notice: 'Deleted. Nobody can see it now, you included.', next: '/m/care' }
  })
}

/** The student's page: what is on offer, what they have taken, asked and been given. */
export async function careHome(actor: Actor) {
  const tenant = requireStudent(actor)
  return withTenant(tenant, async (tx) => {
    const s = await settingsOf(tx, tenant)
    const offered = await checksOf(tx)
    const all = await checksOf(tx, true)
    const mine = await tx.select().from(results).where(eq(results.studentId, actor.id)).orderBy(desc(results.takenAt))
    const asked = await tx
      .select({ r: requests, counsellor: users.name })
      .from(requests)
      .leftJoin(users, eq(users.id, requests.counsellorId))
      .where(eq(requests.studentId, actor.id))
      .orderBy(desc(requests.createdAt))
    const booked = await tx
      .select({ a: appointments, counsellor: users.name })
      .from(appointments)
      .innerJoin(requests, eq(requests.id, appointments.requestId))
      .innerJoin(users, eq(users.id, appointments.counsellorId))
      .where(eq(requests.studentId, actor.id))
      .orderBy(desc(appointments.startsAt))
    const team = await tx
      .select({ name: users.name, title: counsellors.title })
      .from(counsellors)
      .innerJoin(users, eq(users.id, counsellors.userId))
      .where(eq(counsellors.active, true))
      .orderBy(asc(users.name))
    const nameOf = (r: (typeof mine)[number]) => checkFor(all, r.instrumentCode, r.instrumentId)?.name ?? r.instrumentCode
    const now = Date.now()
    return {
      settings: s,
      counsellors: team,
      checks: offered.map((c) => {
        const last = mine.find((r) => r.instrumentCode.toUpperCase() === c.code.toUpperCase())
        return {
          code: c.code,
          name: c.name,
          about: c.about,
          builtIn: c.builtIn,
          last: last ? `${last.band}, ${wallClock(last.takenAt, s.timeZone).slice(0, 10)}` : null,
        }
      }),
      results: mine.map((r) => ({
        id: r.id,
        name: nameOf(r),
        takenAt: wallClock(r.takenAt, s.timeZone),
        score: `${r.score} of ${r.maxScore}`,
        band: r.band,
        safety: r.safety,
      })),
      requests: asked.map(({ r, counsellor }) => ({
        id: r.id,
        asked: wallClock(r.createdAt, s.timeZone),
        topic: TOPICS[r.topic],
        urgency: URGENCY[r.urgency],
        mode: MODES[r.mode],
        status: r.status,
        counsellor: counsellor ?? '',
        open: r.status === 'waiting' || r.status === 'accepted',
      })),
      appointments: booked.map(({ a, counsellor }) => ({
        id: a.id,
        when: wallClock(a.startsAt, s.timeZone),
        until: wallClock(a.endsAt, s.timeZone).slice(11),
        counsellor,
        mode: MODES[a.mode],
        place: a.place,
        note: a.noteToStudent ?? '',
        status: a.status === 'held' ? 'attended' : a.status,
        upcoming: a.status === 'booked' && a.startsAt.getTime() > now,
      })),
    }
  })
}

const rank = { routine: 0, soon: 1, today: 2 } as const

/**
 * Ask to see a counsellor, showing them the results the student picks. With a
 * request already open, the results are added to it and its urgency raised if
 * the student says it is now more urgent: one request per student, so nobody
 * waits in two queues.
 */
export async function ask(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const d = askSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [open] = await tx
        .select()
        .from(requests)
        .where(and(eq(requests.studentId, actor.id), inArray(requests.status, ['waiting', 'accepted'])))
      const share = async (requestId: string) => {
        for (const resultId of d.resultIds) {
          await tx.insert(shared).values({ institutionId: tenant, requestId, resultId }).onConflictDoNothing()
        }
      }
      if (open) {
        await share(open.id)
        const raised = rank[d.urgency] > rank[open.urgency]
        if (raised) await tx.update(requests).set({ urgency: d.urgency }).where(eq(requests.id, open.id))
        const tell = open.counsellorId ? [open.counsellorId] : await counsellorIds(tx)
        if (raised || d.resultIds.length) {
          await notify(tx, tenant, {
            userIds: tell,
            moduleId: MODULE,
            title: raised ? `Counselling: a request is now ${d.urgency === 'today' ? 'for today' : 'more urgent'}` : 'Counselling: a student shared a result',
            body: 'Open the request to see it.',
            link: `/m/care/case?id=${open.id}`,
          })
        }
        return {
          id: open.id,
          notice: raised
            ? 'Added to your open request, and marked more urgent. A counsellor has been told.'
            : 'Added to your open request.',
          next: '/m/care',
        }
      }
      const [row] = await tx
        .insert(requests)
        .values({
          institutionId: tenant,
          studentId: actor.id,
          topic: d.topic,
          urgency: d.urgency,
          mode: d.mode,
          preferredTimes: d.preferredTimes ?? null,
          message: d.message ?? null,
        })
        .returning({ id: requests.id })
      await share(row!.id)
      await notify(tx, tenant, {
        userIds: await counsellorIds(tx),
        moduleId: MODULE,
        title: `Counselling: a request is waiting${d.urgency === 'today' ? ' (today)' : ''}`,
        body: `${URGENCY[d.urgency]}; ${MODES[d.mode].toLowerCase()}.`,
        link: `/m/care/case?id=${row!.id}`,
      })
      return {
        id: row!.id,
        notice:
          d.urgency === 'today'
            ? 'Asked. The counsellors have been told it is for today. If you are in danger now, use the helpline.'
            : 'Asked. A counsellor will take your request and offer you a time.',
        next: '/m/care',
      }
    }),
  )
}

/** The student takes their request back; any time booked for it is cancelled. */
export async function withdraw(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const d = withdrawSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [r] = await tx.select().from(requests).where(and(eq(requests.id, d.requestId), eq(requests.studentId, actor.id)))
      if (!r) throw new CareError(404, 'no_such_request', 'no such request')
      await tx
        .update(appointments)
        .set({ status: 'cancelled', cancelledBy: actor.id, cancelReason: 'The student withdrew the request' })
        .where(and(eq(appointments.requestId, r.id), eq(appointments.status, 'booked')))
      await tx.update(requests).set({ status: 'withdrawn' }).where(eq(requests.id, r.id))
      if (r.counsellorId) {
        await notify(tx, tenant, {
          userIds: [r.counsellorId],
          moduleId: MODULE,
          title: 'Counselling: a student withdrew their request',
          body: d.reason ? `They said: ${d.reason}` : 'They gave no reason.',
          link: `/m/care/case?id=${r.id}`,
        })
      }
      return { notice: 'Withdrawn. You can ask again at any time.' }
    }),
  )
}

/** Cancel an appointment: the student whose it is, or the counsellor who made it. */
export async function cancelAppointment(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = cancelAppointmentSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [x] = await tx
        .select({ a: appointments, studentId: requests.studentId })
        .from(appointments)
        .innerJoin(requests, eq(requests.id, appointments.requestId))
        .where(eq(appointments.id, d.appointmentId))
      if (!x || (x.studentId !== actor.id && x.a.counsellorId !== actor.id)) {
        throw new CareError(404, 'no_such_appointment', 'no such appointment')
      }
      await tx
        .update(appointments)
        .set({ status: 'cancelled', cancelledBy: actor.id, cancelReason: d.reason })
        .where(eq(appointments.id, d.appointmentId))
      const s = await settingsOf(tx, tenant)
      const byStudent = x.studentId === actor.id
      await notify(tx, tenant, {
        userIds: [byStudent ? x.a.counsellorId : x.studentId],
        moduleId: MODULE,
        title: `Student care: the appointment on ${wallClock(x.a.startsAt, s.timeZone)} is cancelled`,
        body: byStudent ? `The student said: ${d.reason}` : `${d.reason}. Your counsellor will offer another time.`,
        link: byStudent ? `/m/care/case?id=${x.a.requestId}` : '/m/care',
      })
      return { notice: 'Cancelled, and the other side has been told.' }
    }),
  )
}

// --- counsellors ------------------------------------------------------------------

const studentWho = (tx: Tx) =>
  tx
    .select({ id: users.id, name: users.name, email: users.email, rollNo: studentProfiles.rollNo })
    .from(users)
    .leftJoin(studentProfiles, eq(studentProfiles.studentId, users.id))

/**
 * What a counsellor works from: the requests waiting for one, most urgent
 * first; the cases they hold; their appointments to come.
 */
export async function queue(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    if (!isStaff(actor.role) || !(await activeCounsellor(tx, actor.id))) return { counsellor: false as const }
    const s = await settingsOf(tx, tenant)
    const flagged = sql<boolean>`exists (select 1 from care_shared_results sr join care_results cr on cr.id = sr.result_id
                                         where sr.request_id = care_requests.id and cr.safety)`
    const sharedCount = sql<number>`(select count(*) from care_shared_results sr where sr.request_id = care_requests.id)`.mapWith(Number)
    const waiting = await tx
      .select({ r: requests, name: users.name, email: users.email, rollNo: studentProfiles.rollNo, flagged, sharedCount })
      .from(requests)
      .innerJoin(users, eq(users.id, requests.studentId))
      .leftJoin(studentProfiles, eq(studentProfiles.studentId, requests.studentId))
      .where(eq(requests.status, 'waiting'))
      .orderBy(desc(requests.urgency), asc(requests.createdAt))
    const nextAppointment = sql<Date | null>`(select min(a.starts_at) from care_appointments a
                                               where a.request_id = care_requests.id and a.status = 'booked' and a.starts_at > now())`
    const lastNote = sql<Date | null>`(select max(n.created_at) from care_notes n where n.request_id = care_requests.id)`
    const held = await tx
      .select({ r: requests, name: users.name, email: users.email, rollNo: studentProfiles.rollNo, nextAppointment, lastNote, flagged })
      .from(requests)
      .innerJoin(users, eq(users.id, requests.studentId))
      .leftJoin(studentProfiles, eq(studentProfiles.studentId, requests.studentId))
      .where(and(eq(requests.status, 'accepted'), eq(requests.counsellorId, actor.id)))
      .orderBy(desc(requests.urgency), asc(requests.acceptedAt))
    const coming = await tx
      .select({ a: appointments, name: users.name })
      .from(appointments)
      .innerJoin(requests, eq(requests.id, appointments.requestId))
      .innerJoin(users, eq(users.id, requests.studentId))
      .where(and(eq(appointments.counsellorId, actor.id), eq(appointments.status, 'booked')))
      .orderBy(asc(appointments.startsAt))
    const day = 86_400_000
    const now = Date.now()
    const at = (v: Date | string | null) => (v ? wallClock(v, s.timeZone) : '')
    return {
      counsellor: true as const,
      waiting: waiting.map((w) => ({
        id: w.r.id,
        student: w.name ?? w.email ?? '',
        rollNo: w.rollNo ?? '',
        topic: TOPICS[w.r.topic],
        urgency: w.r.urgency,
        mode: MODES[w.r.mode],
        preferred: w.r.preferredTimes ?? '',
        asked: at(w.r.createdAt),
        days: Math.floor((now - w.r.createdAt.getTime()) / day),
        shared: w.sharedCount,
        flagged: Boolean(w.flagged),
        safety: w.flagged ? 'safety question' : '',
      })),
      cases: held.map((h) => ({
        id: h.r.id,
        student: h.name ?? h.email ?? '',
        rollNo: h.rollNo ?? '',
        topic: TOPICS[h.r.topic],
        urgency: h.r.urgency,
        since: at(h.r.acceptedAt),
        next: at(h.nextAppointment),
        lastNote: at(h.lastNote),
        flagged: Boolean(h.flagged),
      })),
      appointments: coming.map((c) => ({
        id: c.a.id,
        requestId: c.a.requestId,
        student: c.name ?? '',
        when: at(c.a.startsAt),
        mode: MODES[c.a.mode],
        place: c.a.place,
        due: c.a.startsAt.getTime() <= now,
      })),
      urgentWaiting: waiting.filter((w) => w.r.urgency === 'today').length,
      waitingLong: waiting.filter((w) => now - w.r.createdAt.getTime() > 2 * day).length,
    }
  })
}

/** Whether this counsellor may read this request: any of them while it waits, then its holder. */
async function caseFor(tx: Tx, actor: Actor, requestId: string) {
  await requireCounsellor(tx, actor)
  const [r] = await tx.select().from(requests).where(eq(requests.id, requestId))
  if (!r || (r.status !== 'waiting' && r.counsellorId !== actor.id)) {
    throw new CareError(404, 'no_such_request', 'no such request, or it is another counsellor’s case')
  }
  return r
}

async function holding(tx: Tx, actor: Actor, requestId: string) {
  const r = await caseFor(tx, actor, requestId)
  if (r.status !== 'accepted' || r.counsellorId !== actor.id) {
    throw new CareError(409, 'not_holding', r.status === 'waiting' ? 'take the request first' : 'that case is not open with you')
  }
  return r
}

/** One case, for the counsellor: what was asked, the results shared, appointments and notes. */
export async function caseView(actor: Actor, requestId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const r = await caseFor(tx, actor, requestId)
    const s = await settingsOf(tx, tenant)
    const [student] = await studentWho(tx).where(eq(users.id, r.studentId))
    const [counsellor] = r.counsellorId
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, r.counsellorId))
      : [null]
    const all = await checksOf(tx, true)
    const shown = await tx
      .select({ r: results })
      .from(shared)
      .innerJoin(results, eq(results.id, shared.resultId))
      .where(eq(shared.requestId, r.id))
      .orderBy(desc(results.takenAt))
    const booked = await tx.select().from(appointments).where(eq(appointments.requestId, r.id)).orderBy(desc(appointments.startsAt))
    const written = await tx
      .select({ n: notes, by: users.name })
      .from(notes)
      .leftJoin(users, eq(users.id, notes.authorId))
      .where(eq(notes.requestId, r.id))
      .orderBy(desc(notes.createdAt))
    const others = await tx
      .select({ value: counsellors.userId, label: users.name, title: counsellors.title })
      .from(counsellors)
      .innerJoin(users, eq(users.id, counsellors.userId))
      .where(and(eq(counsellors.active, true), sql`${counsellors.userId} <> ${actor.id}`))
      .orderBy(asc(users.name))
    const at = (v: Date | null) => (v ? wallClock(v, s.timeZone) : '')
    const now = Date.now()
    return {
      request: {
        id: r.id,
        status: r.status,
        topic: TOPICS[r.topic],
        urgency: r.urgency,
        urgencyText: URGENCY[r.urgency],
        mode: MODES[r.mode],
        modeValue: r.mode,
        preferred: r.preferredTimes ?? '',
        message: r.message ?? '',
        asked: at(r.createdAt),
        accepted: at(r.acceptedAt),
        closed: at(r.closedAt),
        outcome: r.outcome ? OUTCOMES[r.outcome] : '',
        counsellor: counsellor?.name ?? '',
        mine: r.counsellorId === actor.id,
        open: r.status === 'accepted' && r.counsellorId === actor.id,
      },
      student: { name: student?.name ?? student?.email ?? '', email: student?.email ?? '', rollNo: student?.rollNo ?? '' },
      results: shown.map(({ r: x }) => ({
        id: x.id,
        name: checkFor(all, x.instrumentCode, x.instrumentId)?.name ?? x.instrumentCode,
        takenAt: at(x.takenAt),
        score: `${x.score} of ${x.maxScore}`,
        band: x.band,
        safety: x.safety ? 'safety question' : '',
        flagged: x.safety,
      })),
      appointments: booked.map((a) => ({
        id: a.id,
        when: at(a.startsAt),
        until: at(a.endsAt).slice(11),
        mode: MODES[a.mode],
        place: a.place,
        note: a.noteToStudent ?? '',
        status: a.status === 'held' ? 'attended' : a.status,
        reason: a.cancelReason ?? '',
        due: a.status === 'booked' && a.startsAt.getTime() <= now,
      })),
      notes: written.map(({ n, by }) => ({ id: n.id, at: at(n.createdAt), by: by ?? '', body: n.body })),
      counsellors: others.map((o) => ({ value: o.value, label: `${o.label ?? o.value} (${o.title})` })),
      timeZone: s.timeZone,
      // The case's own history, for the record's sidebar: case events are
      // kept out of the audit log the office reads.
      timeline: [
        { at: r.createdAt.toISOString(), who: student?.name ?? null, text: `Asked: ${URGENCY[r.urgency].toLowerCase()}` },
        ...(r.acceptedAt ? [{ at: r.acceptedAt.toISOString(), who: null, text: 'Taken by a counsellor' }] : []),
        ...booked.map((a) => ({
          at: a.createdAt.toISOString(),
          who: null,
          text: `Appointment for ${at(a.startsAt)}: ${a.status === 'held' ? 'attended' : a.status}`,
        })),
        ...written.map(({ n, by }) => ({
          at: n.createdAt.toISOString(),
          who: by,
          text: n.body.startsWith('Handed to ') ? n.body.split(':')[0]! : 'Note',
        })),
        ...(r.closedAt
          ? [{ at: r.closedAt.toISOString(), who: null, text: r.status === 'closed' ? `Closed: ${r.outcome ? OUTCOMES[r.outcome].toLowerCase() : ''}` : 'Withdrawn by the student' }]
          : []),
      ],
    }
  })
}

/** A counsellor takes a waiting request. First to take it holds it. */
export async function accept(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = acceptSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const r = await caseFor(tx, actor, d.requestId)
      const taken = await tx
        .update(requests)
        .set({ status: 'accepted', counsellorId: actor.id })
        .where(and(eq(requests.id, r.id), eq(requests.status, 'waiting')))
        .returning({ id: requests.id })
      if (!taken.length) throw new CareError(409, 'taken', 'another counsellor has taken it')
      const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.id))
      await notify(tx, tenant, {
        userIds: [r.studentId],
        moduleId: MODULE,
        title: 'Student care: a counsellor has your request',
        body: `${me?.name ?? 'A counsellor'} will offer you a time.`,
        link: '/m/care',
      })
      return { notice: 'Yours now. Offer the student a time.', next: `/m/care/case?id=${r.id}` }
    }),
  )
}

/**
 * Hand a case to another counsellor. The reason goes into the case's notes,
 * for whoever holds it next, rather than into the audit log the office reads;
 * times booked with the first counsellor are cancelled and the student told.
 */
export async function handover(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = handoverSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const r = await holding(tx, actor, d.requestId)
      if (d.counsellorId === actor.id) throw new CareError(400, 'same_counsellor', 'hand it to somebody else')
      const [next] = await tx
        .select({ name: users.name })
        .from(counsellors)
        .innerJoin(users, eq(users.id, counsellors.userId))
        .where(and(eq(counsellors.userId, d.counsellorId), eq(counsellors.active, true)))
      if (!next) throw new CareError(400, 'care_request_counsellor', 'that is not one of the counsellors')
      await tx.insert(notes).values({
        institutionId: tenant,
        requestId: r.id,
        authorId: actor.id,
        body: `Handed to ${next.name ?? 'another counsellor'}: ${d.reason}`,
      })
      const cancelled = await tx
        .update(appointments)
        .set({ status: 'cancelled', cancelledBy: actor.id, cancelReason: 'Handed to another counsellor' })
        .where(and(eq(appointments.requestId, r.id), eq(appointments.status, 'booked')))
        .returning({ id: appointments.id })
      await tx.update(requests).set({ counsellorId: d.counsellorId }).where(eq(requests.id, r.id))
      await notify(tx, tenant, {
        userIds: [d.counsellorId],
        moduleId: MODULE,
        title: 'Counselling: a case was handed to you',
        body: 'Open it to read why, and offer the student a time.',
        link: `/m/care/case?id=${r.id}`,
      })
      await notify(tx, tenant, {
        userIds: [r.studentId],
        moduleId: MODULE,
        title: 'Student care: another counsellor will see you',
        body: `${next.name ?? 'A colleague'} will offer you a time${cancelled.length ? '; the time you had is cancelled' : ''}.`,
        link: '/m/care',
      })
      return { notice: `Handed to ${next.name ?? 'them'}.`, next: '/m/care/queue' }
    }),
  )
}

/** Close a case with what came of it. Appointments still to come are cancelled; one that has begun must be recorded first. */
export async function closeCase(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = closeSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const r = await holding(tx, actor, d.requestId)
      const [due] = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(eq(appointments.requestId, r.id), eq(appointments.status, 'booked'), sql`${appointments.startsAt} <= now()`))
      if (due) throw new CareError(409, 'record_first', 'record whether the appointments that have begun were held')
      await tx
        .update(appointments)
        .set({ status: 'cancelled', cancelledBy: actor.id, cancelReason: 'The case was closed' })
        .where(and(eq(appointments.requestId, r.id), eq(appointments.status, 'booked')))
      if (d.note) await tx.insert(notes).values({ institutionId: tenant, requestId: r.id, authorId: actor.id, body: d.note })
      await tx.update(requests).set({ status: 'closed', outcome: d.outcome }).where(eq(requests.id, r.id))
      await notify(tx, tenant, {
        userIds: [r.studentId],
        moduleId: MODULE,
        title: 'Student care: your request is closed',
        body: 'You can ask to see a counsellor again at any time.',
        link: '/m/care',
      })
      return { notice: 'Closed.', next: '/m/care/queue' }
    }),
  )
}

/** Offer the student a time. Never over another appointment of the counsellor's. */
export async function book(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = bookSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const r = await holding(tx, actor, d.requestId)
      const s = await settingsOf(tx, tenant)
      const startsAt = instant(d.startsAt, s.timeZone)
      const endsAt = new Date(startsAt.getTime() + d.minutes * 60_000)
      const [row] = await tx
        .insert(appointments)
        .values({
          institutionId: tenant,
          requestId: r.id,
          counsellorId: actor.id,
          startsAt,
          endsAt,
          mode: d.mode,
          place: d.place,
          noteToStudent: d.noteToStudent ?? null,
        })
        .returning({ id: appointments.id })
      const when = wallClock(startsAt, s.timeZone)
      await notify(tx, tenant, {
        userIds: [r.studentId],
        moduleId: MODULE,
        title: `Student care: an appointment on ${when}`,
        body: `${MODES[d.mode]}, ${d.place}.${d.noteToStudent ? ` ${d.noteToStudent}` : ''}`,
        link: '/m/care',
      })
      return { id: row!.id, notice: `Booked for ${when}. The student has been told.` }
    }),
  )
}

/** Held or missed, once it has begun. */
export async function recordAppointment(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = recordSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await requireCounsellor(tx, actor)
      const [a] = await tx.select().from(appointments).where(eq(appointments.id, d.appointmentId))
      if (!a || a.counsellorId !== actor.id) throw new CareError(404, 'no_such_appointment', 'no such appointment')
      await tx.update(appointments).set({ status: d.status }).where(eq(appointments.id, a.id))
      return { notice: d.status === 'held' ? 'Recorded as held.' : 'Recorded as missed.' }
    }),
  )
}

export async function addNote(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = noteSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const r = await caseFor(tx, actor, d.requestId)
      await tx.insert(notes).values({ institutionId: tenant, requestId: r.id, authorId: actor.id, body: d.body })
      return { notice: 'Noted.' }
    }),
  )
}

// --- the office ------------------------------------------------------------------

/** The office's page: the helpline, the counsellors, the checks. */
export async function careSettings(actor: Actor) {
  const tenant = requireAdmin(actor)
  return withTenant(tenant, async (tx) => {
    const s = await settingsOf(tx, tenant)
    const openCases = sql<number>`(select count(*) from care_requests q
                                    where q.counsellor_id = care_counsellors.user_id and q.status = 'accepted')`.mapWith(Number)
    const team = await tx
      .select({ c: counsellors, name: users.name, email: users.email, role: users.role, openCases })
      .from(counsellors)
      .innerJoin(users, eq(users.id, counsellors.userId))
      .orderBy(desc(counsellors.active), asc(users.name))
    const staff = await tx
      .select({ value: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(
        and(
          eq(users.institutionId, tenant),
          sql`${users.role} not in ('student', 'parent', 'pending')`,
          sql`not exists (select 1 from care_counsellors c where c.user_id = users.id)`,
        ),
      )
      .orderBy(asc(users.name))
    const all = await checksOf(tx, true)
    const taken = await tx
      .select({ code: results.instrumentCode, id: results.instrumentId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(results)
      .groupBy(results.instrumentCode, results.instrumentId)
    const own = await tx.select({ id: instruments.id, active: instruments.active }).from(instruments)
    return {
      settings: s,
      counsellors: team.map((t) => ({
        userId: t.c.userId,
        name: t.name ?? t.email ?? t.c.userId,
        title: t.c.title,
        role: t.role,
        state: t.c.active ? 'active' : 'inactive',
        openCases: t.openCases,
        active: t.c.active,
      })),
      staff: staff.map((u) => ({ value: u.value, label: `${u.name ?? u.email ?? u.value} (${u.role.replace('_', ' ')})` })),
      checks: all.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        source: c.source,
        kind: c.builtIn ? 'built in' : 'the institution’s',
        state: c.builtIn || own.find((o) => o.id === c.id)?.active ? 'offered' : 'retired',
        // How many times taken: a count, which the office may see.
        taken: taken.filter((t) => (c.id ? t.id === c.id : !t.id && t.code.toUpperCase() === c.code.toUpperCase())).reduce((n, t) => n + t.n, 0),
      })),
    }
  })
}

export async function saveSettings(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = settingsSchema.parse(input)
  return named(async () => {
    assertZone(d.timeZone)
    return withTenant(tenant, async (tx) => {
      const values = { crisisLine: d.crisisLine, contact: d.contact, timeZone: d.timeZone, updatedBy: actor.id, updatedAt: new Date() }
      await tx
        .insert(settings)
        .values({ institutionId: tenant, ...values })
        .onConflictDoUpdate({ target: settings.institutionId, set: values })
      await audit(tx, { ...who(actor, tenant), action: 'care.settings', entity: 'care_settings', entityId: tenant, reason: 'the helpline, the centre or the time zone changed', detail: values })
      return { notice: 'Saved. Students see the helpline and the centre on every page of Student care.' }
    })
  })
}

/** Name a member of staff a counsellor, or make an inactive one active again. */
export async function addCounsellor(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = counsellorSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [row] = await tx
        .insert(counsellors)
        .values({ institutionId: tenant, userId: d.userId, title: d.title, addedBy: actor.id })
        .onConflictDoUpdate({ target: [counsellors.institutionId, counsellors.userId], set: { title: d.title, active: true } })
        .returning({ id: counsellors.id })
      await audit(tx, { ...who(actor, tenant), action: 'care.counsellor_named', entity: 'care_counsellors', entityId: row!.id, reason: `named ${d.title}`, detail: { userId: d.userId, title: d.title } })
      return { notice: 'Named. They now see the requests waiting for a counsellor.' }
    }),
  )
}

export async function setCounsellorActive(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = counsellorActiveSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const rows = await tx
        .update(counsellors)
        .set({ active: d.active })
        .where(eq(counsellors.userId, d.userId))
        .returning({ id: counsellors.id })
      if (!rows.length) throw new CareError(404, 'no_such_counsellor', 'no such counsellor')
      await audit(tx, { ...who(actor, tenant), action: d.active ? 'care.counsellor_active' : 'care.counsellor_inactive', entity: 'care_counsellors', entityId: rows[0]!.id, reason: d.active ? 'made active' : 'made inactive' })
      return { notice: d.active ? 'Active again.' : 'Inactive. Their closed cases stay as they were.' }
    }),
  )
}

/** A check of the institution's own, with the source every student is shown. */
export async function addInstrument(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = instrumentSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const bands = [...d.bands].sort((a, b) => a.from - b.from)
      const check: Check = { ...d, bands, builtIn: false, id: null }
      const [row] = await tx
        .insert(instruments)
        .values({
          institutionId: tenant,
          code: d.code,
          name: d.name,
          about: d.about,
          stem: d.stem,
          source: d.source,
          options: d.options,
          items: d.items,
          bands,
          maxScore: maxScore(check),
          createdBy: actor.id,
        })
        .returning({ id: instruments.id })
      await audit(tx, { ...who(actor, tenant), action: 'care.check_written', entity: 'care_instruments', entityId: row!.id, reason: `offered ${d.name}`, detail: { code: d.code, name: d.name } })
      return { id: row!.id, notice: `${d.name} is offered to students.` }
    }),
  )
}

export async function retireInstrument(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = retireInstrumentSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const rows = await tx
        .update(instruments)
        .set({ active: false })
        .where(eq(instruments.id, d.instrumentId))
        .returning({ id: instruments.id, name: instruments.name })
      if (!rows.length) throw new CareError(404, 'no_such_check', 'no such check')
      await audit(tx, { ...who(actor, tenant), action: 'care.check_retired', entity: 'care_instruments', entityId: d.instrumentId, reason: `no longer offered: ${rows[0]!.name}` })
      return { notice: `${rows[0]!.name} is no longer offered. Results already taken stay with the students.` }
    }),
  )
}


/** The checks on offer, for any client: what each asks and how it is scored. */
export async function offeredChecks(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => (await checksOf(tx)).map((c) => ({ ...c, max: maxScore(c) })))
}
