import { createHash } from 'node:crypto'
import * as z from 'zod'
import { and, asc, desc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import { programs, sectionMembers, sections, studentPrograms, terms } from '../schema'
import { AcademicError, requireWriter, type Actor } from './operations'

/**
 * Year-end promotion and detention of a school section (P1-13c, MG-04).
 *
 * One deliberate operation: the old declaration of every student on the roster
 * ends on the last day of the old session's final term, and a new one starts on
 * the first day of the new session's first term, for the next class (promoted)
 * or the same class again (detained). The old section membership is kept, for
 * the attendance and marks recorded against it. Nothing here posts a fee or
 * touches an enrolment registration: billing reads the declarations (decision
 * 189), so the next term is billed to the right class by itself.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const MAX_ROSTER = 500

const MESSAGES = {
  no_such_section: 'No such section.',
  no_such_program: 'No such programme.',
  no_such_term: 'No such term.',
  invalid_next_class: 'Choose a different school class without a cycle.',
  invalid_promotion: 'Check the classes, terms and destination sections.',
  school_section_taken: 'The student already has a section for this class and school year.',
  school_section_finalised: 'This section has already been promoted.',
  promotion_roster_changed: 'Reload the section roster before promoting.',
  promotion_roster_size: 'Promotion requires between 1 and 500 students.',
  promotion_declaration_conflict: 'Every student must have one live declaration for the source class.',
  promotion_conflict: 'The records changed. Reload and try again.',
} as const

type Failure = keyof typeof MESSAGES

const STATUS: Record<Failure, 400 | 404 | 409> = {
  no_such_section: 404,
  no_such_program: 404,
  no_such_term: 404,
  invalid_next_class: 400,
  invalid_promotion: 400,
  school_section_taken: 409,
  school_section_finalised: 409,
  promotion_roster_changed: 409,
  promotion_roster_size: 409,
  promotion_declaration_conflict: 409,
  promotion_conflict: 409,
}

/** The error a caller sees, with the fixed text of decision 956. */
export const promotionError = (code: Failure) => new AcademicError(STATUS[code], code, MESSAGES[code])

/**
 * What a database refusal means to the office. Only the named constraints and
 * the retryable states are translated; anything else is somebody's bug and goes
 * up untouched. Raw errors and Drizzle's wrapped ones both carry the detail.
 */
export function promotionConflict(e: unknown): never {
  const pg = ((e as { cause?: unknown }).cause ?? e) as { code?: string; constraint?: string }
  if (pg.constraint === 'academic_school_member_one_section') throw promotionError('school_section_taken')
  if (pg.constraint === 'academic_school_section_finalised') throw promotionError('school_section_finalised')
  if (
    pg.constraint === 'academic_student_programs_live' ||
    pg.constraint === 'academic_student_programs_primary' ||
    pg.code === '40P01' ||
    pg.code === '40001'
  ) {
    throw promotionError('promotion_conflict')
  }
  throw e
}

// --- contracts --------------------------------------------------------------

const uuid = z.uuid()
const blankToUndefined = (v: unknown) => (v === '' ? undefined : v)

export const setNextSchoolProgramSchema = z
  .strictObject({
    programId: uuid,
    nextProgramId: z.preprocess((v) => (v === '' || v === undefined ? null : v), uuid.nullable()),
  })
  .meta({ id: 'AcademicSetNextSchoolProgram' })

export const promoteSectionSchema = z
  .strictObject({
    sourceSectionId: uuid,
    sourceTermId: uuid,
    nextTermId: uuid,
    promotedSectionId: z.preprocess(blankToUndefined, uuid.optional()),
    detainedSectionId: z.preprocess(blankToUndefined, uuid.optional()),
    /** A single ticked box arrives as a string, none as nothing. */
    detainedStudentIds: z
      .preprocess((v) => (v === undefined || v === '' ? [] : typeof v === 'string' ? [v] : v), z.array(z.string().min(1)).max(MAX_ROSTER))
      .default([]),
    rosterToken: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string().trim().min(5).max(500),
  })
  .refine((d) => new Set(d.detainedStudentIds).size === d.detainedStudentIds.length, {
    message: 'a student is named once',
    path: ['detainedStudentIds'],
  })
  .meta({ id: 'AcademicPromoteSection' })

// --- the day, and the roster ------------------------------------------------

/** Today at the school, not at the server. */
export function todayIST(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (t: string) => parts.find((p) => p.type === t)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** What the office saw: who is on the roster, and who of them takes part. */
export function schoolRosterToken(memberIds: readonly string[], participantIds: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([[...memberIds].sort(), [...participantIds].sort()]))
    .digest('hex')
}

export interface PromotionRoster {
  memberIds: string[]
  participantIds: string[]
  activeDeclarations: (typeof studentPrograms.$inferSelect)[]
}

/**
 * The roster of a school section for promotion. Members in user order, at most
 * 501 read so that an oversize roster is seen without reading further. A member
 * with no live school declaration whose latest declaration of this class was
 * withdrawn or transferred out on or before today has departed: still on the
 * historical roster, no longer part of the promotion. Anyone else is a
 * participant, including a member with a missing or wrong declaration, so that
 * the problem is raised instead of silently skipped.
 */
export async function readSchoolPromotionRoster(tx: Tx, sectionId: string, programId: string, today: string, lock: boolean): Promise<PromotionRoster> {
  const memberQuery = tx.select({ userId: sectionMembers.userId }).from(sectionMembers).where(eq(sectionMembers.sectionId, sectionId)).orderBy(asc(sectionMembers.userId)).limit(MAX_ROSTER + 1)
  const memberIds = (await (lock ? memberQuery.for('update') : memberQuery)).map((r) => r.userId)
  if (memberIds.length > MAX_ROSTER) return { memberIds, participantIds: [], activeDeclarations: [] }

  const declarationQuery = tx
    .select({ d: studentPrograms })
    .from(studentPrograms)
    .innerJoin(programs, eq(programs.id, studentPrograms.programId))
    .where(
      and(
        inArray(studentPrograms.studentId, memberIds),
        sql`((${studentPrograms.status} = 'active' and ${programs.level} = 'school') or ${studentPrograms.programId} = ${programId})`,
      ),
    )
    .orderBy(asc(studentPrograms.studentId), desc(studentPrograms.declaredOn), desc(studentPrograms.id))
  const all = (await (lock && memberIds.length ? declarationQuery.for('update', { of: studentPrograms }) : declarationQuery)).map((r) => r.d)

  const live = new Map<string, (typeof all)[number][]>()
  const latestOfClass = new Map<string, (typeof all)[number]>()
  for (const d of all) {
    if (d.status === 'active') live.set(d.studentId, [...(live.get(d.studentId) ?? []), d])
    else if (d.programId === programId && !latestOfClass.has(d.studentId)) latestOfClass.set(d.studentId, d)
  }
  const participantIds = memberIds.filter((id) => {
    if (live.has(id)) return true
    const last = latestOfClass.get(id)
    const gone = last && (last.status === 'withdrawn' || last.status === 'transferred_out') && last.endedOn !== null && last.endedOn <= today
    return !gone
  })
  const kept = new Set(participantIds)
  return { memberIds, participantIds, activeDeclarations: all.filter((d) => d.status === 'active' && kept.has(d.studentId)) }
}

// --- the successor ----------------------------------------------------------

/** A school class's next class, or none. Never a different level, itself, or a loop. */
export async function setNextSchoolProgram(actor: Actor, input: unknown): Promise<{ programId: string; nextProgramId: string | null }> {
  const tenant = requireWriter(actor)
  const data = setNextSchoolProgramSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'academic.next_school:' + tenant}, 0))`)
    const wanted = [data.programId, ...(data.nextProgramId ? [data.nextProgramId] : [])]
    const found = await tx.select({ id: programs.id, level: programs.level }).from(programs).where(inArray(programs.id, wanted))
    const source = found.find((p) => p.id === data.programId)
    if (!source) throw promotionError('no_such_program')
    if (source.level !== 'school') throw promotionError('invalid_next_class')
    if (data.nextProgramId) {
      const target = found.find((p) => p.id === data.nextProgramId)
      if (!target) throw promotionError('no_such_program')
      if (target.level !== 'school' || target.id === source.id) throw promotionError('invalid_next_class')
      const loops = await tx.execute(sql`
        with recursive chain(id) as (
          select id from academic_programs where id = ${data.nextProgramId}
          union
          select p.next_program_id from academic_programs p join chain c on p.id = c.id where p.next_program_id is not null
        ) select 1 from chain where id = ${data.programId}`)
      if (loops.rows.length) throw promotionError('invalid_next_class')
    }
    await tx.update(programs).set({ nextProgramId: data.nextProgramId }).where(eq(programs.id, data.programId))
    return { programId: data.programId, nextProgramId: data.nextProgramId }
  })
}

// --- the promotion ----------------------------------------------------------

/** Promote or detain every student of one section, once. */
export async function promoteSection(actor: Actor, input: unknown): Promise<{ sourceSectionId: string; promoted: number; detained: number }> {
  const tenant = requireWriter(actor)
  const data = promoteSectionSchema.parse(input)
  const today = todayIST()
  try {
    return await withTenant(tenant, async (tx) => {
      // Every section named, in one order, so two promotions cannot deadlock.
      const ids = [...new Set([data.sourceSectionId, data.promotedSectionId, data.detainedSectionId].filter((x): x is string => !!x))]
      const locked = await tx.select().from(sections).where(inArray(sections.id, ids)).orderBy(asc(sections.id)).for('update')
      if (locked.length !== ids.length) throw promotionError('no_such_section')
      const section = (id: string) => locked.find((s) => s.id === id)!
      const source = section(data.sourceSectionId)

      const [from] = await tx.select().from(programs).where(eq(programs.id, source.programId)).for('share')
      if (!from || from.level !== 'school') throw promotionError('invalid_promotion')
      if (source.schoolPromotedAt) throw promotionError('school_section_finalised')

      const termRows = await tx.select().from(terms).where(inArray(terms.id, [data.sourceTermId, data.nextTermId])).orderBy(asc(terms.id)).for('share')
      const oldTerm = termRows.find((t) => t.id === data.sourceTermId)
      const newTerm = termRows.find((t) => t.id === data.nextTermId)
      if (!oldTerm || !newTerm) throw promotionError('no_such_term')
      if (oldTerm.id === newTerm.id || oldTerm.kind !== 'regular' || newTerm.kind !== 'regular') throw promotionError('invalid_promotion')
      const newYear = source.admissionYear + 1
      if (
        oldTerm.startsOn < `${source.admissionYear}-01-01` ||
        oldTerm.endsOn >= newTerm.startsOn ||
        Number(newTerm.startsOn.slice(0, 4)) !== newYear ||
        newTerm.startsOn > today
      ) {
        throw promotionError('invalid_promotion')
      }

      // The two terms must be neighbours: a regular term between them would go unbilled once every declaration ends at the old term's end.
      const between = await tx
        .select({ id: terms.id })
        .from(terms)
        .where(and(eq(terms.kind, 'regular'), gt(terms.startsOn, oldTerm.startsOn), lt(terms.startsOn, newTerm.startsOn), ne(terms.id, oldTerm.id), ne(terms.id, newTerm.id)))
        .limit(1)
      if (between.length) throw promotionError('invalid_promotion')

      const roster = await readSchoolPromotionRoster(tx, source.id, source.programId, today, true)
      if (roster.memberIds.length < 1 || roster.memberIds.length > MAX_ROSTER || roster.participantIds.length < 1) throw promotionError('promotion_roster_size')
      if (schoolRosterToken(roster.memberIds, roster.participantIds) !== data.rosterToken) throw promotionError('promotion_roster_changed')
      const participants = new Set(roster.participantIds)
      if (!data.detainedStudentIds.every((id) => participants.has(id))) throw promotionError('invalid_promotion')
      const detainedIds = [...data.detainedStudentIds].sort()
      const detained = new Set(detainedIds)
      const promotedIds = roster.participantIds.filter((id) => !detained.has(id)).sort()

      // Each outcome has a destination exactly when someone goes there.
      const destination = (ids: string[], sectionId: string | undefined, programId: string | null) => {
        if (!ids.length) {
          if (sectionId) throw promotionError('invalid_promotion')
          return null
        }
        const s = sectionId ? section(sectionId) : undefined
        if (!s || !programId || s.programId !== programId || s.admissionYear !== newYear || s.schoolPromotedAt) throw promotionError('invalid_promotion')
        return s
      }
      const toNext = destination(promotedIds, data.promotedSectionId, from.nextProgramId)
      const toSame = destination(detainedIds, data.detainedSectionId, from.id)
      for (const target of [toNext, toSame]) {
        if (!target) continue
        const [dest] = await tx.select({ level: programs.level }).from(programs).where(eq(programs.id, target.programId))
        if (dest?.level !== 'school') throw promotionError('invalid_promotion')
      }

      // One live declaration each, of the source class, running through the term's end.
      const byStudent = new Map<string, typeof roster.activeDeclarations>()
      for (const d of roster.activeDeclarations) byStudent.set(d.studentId, [...(byStudent.get(d.studentId) ?? []), d])
      const old = new Map<string, (typeof roster.activeDeclarations)[number]>()
      for (const id of roster.participantIds) {
        const own = byStudent.get(id) ?? []
        const only = own[0]
        if (own.length !== 1 || !only || only.programId !== source.programId || only.endedOn !== null || only.declaredOn >= oldTerm.endsOn) {
          throw promotionError('promotion_declaration_conflict')
        }
        old.set(id, only)
      }
      const students = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, roster.participantIds), eq(users.role, 'student')))
      if (students.length !== roster.participantIds.length) throw promotionError('promotion_roster_changed')

      // A student already seated in the destination class and year blocks it all.
      for (const [ids, target] of [[promotedIds, toNext], [detainedIds, toSame]] as const) {
        if (!target || !ids.length) continue
        const seated = await tx
          .select({ userId: sectionMembers.userId })
          .from(sectionMembers)
          .innerJoin(sections, eq(sections.id, sectionMembers.sectionId))
          .where(and(inArray(sectionMembers.userId, ids), eq(sections.programId, target.programId), eq(sections.admissionYear, target.admissionYear)))
          .limit(1)
        if (seated.length) throw promotionError('school_section_taken')
      }

      await tx
        .update(studentPrograms)
        .set({ status: 'completed', endedOn: oldTerm.endsOn, isPrimary: false })
        .where(inArray(studentPrograms.id, [...old.values()].map((d) => d.id)))
      const fresh = (id: string, programId: string, curriculumId: string | null) => ({
        institutionId: tenant,
        studentId: id,
        programId,
        curriculumId,
        status: 'active' as const,
        isPrimary: old.get(id)!.isPrimary,
        declaredOn: newTerm.startsOn,
      })
      const rows = [
        ...promotedIds.map((id) => fresh(id, from.nextProgramId!, null)),
        ...detainedIds.map((id) => fresh(id, from.id, old.get(id)!.curriculumId)),
      ]
      await tx.insert(studentPrograms).values(rows)
      for (const [ids, target] of [[promotedIds, toNext], [detainedIds, toSame]] as const) {
        if (target && ids.length) {
          await tx.insert(sectionMembers).values(ids.map((userId) => ({ institutionId: tenant, sectionId: target.id, userId })))
        }
      }
      await tx.update(sections).set({ schoolPromotedAt: sql`transaction_timestamp()` }).where(eq(sections.id, source.id))
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        moduleId: 'academic',
        action: 'school.section_promoted',
        entity: 'academic_sections',
        entityId: source.id,
        reason: data.reason,
        detail: {
          sourceTermId: oldTerm.id,
          nextTermId: newTerm.id,
          endedOn: oldTerm.endsOn,
          startedOn: newTerm.startsOn,
          promotedSectionId: toNext?.id ?? null,
          detainedSectionId: toSame?.id ?? null,
          promoted: promotedIds.length,
          detained: detainedIds.length,
          departed: roster.memberIds.length - roster.participantIds.length,
        },
      })
      return { sourceSectionId: source.id, promoted: promotedIds.length, detained: detainedIds.length }
    })
  } catch (e) {
    return promotionConflict(e)
  }
}
