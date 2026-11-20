import { sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { moduleEnabled } from '@campusos/module-framework'
import { attendanceSummaryWithin, type AttendanceLine, type AttendanceRules } from '@campusos/module-attendance/api'
import { manifest as attendanceManifest } from '@campusos/module-attendance/manifest'
import { postedSql } from '@campusos/module-fees/api'
import { manifest as feesManifest } from '@campusos/module-fees/manifest'
import { manifest } from '../manifest'
import { setEligibilityWaiverSchema } from './cycle-schemas'
import { ExamError, type Actor } from './operations'

/**
 * Who may sit (FUNC-01, P1-07b): attendance at the institution's own minimum
 * and no posted fees outstanding for the term, each checked when its module is
 * on, and each waivable by the examination cell with a reason on the record.
 * Nothing is stored as "cleared": every enrolment and every admit-card request
 * reads the books and the register as they stand.
 */

const KNOWN = [manifest, attendanceManifest, feesManifest]

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export type EligibilityCheck = 'attendance' | 'dues'
export type EligibilityState = 'not_applicable' | 'passed' | 'failed' | 'unavailable' | 'waived'
export type Blocker = 'exam_attendance_short' | 'exam_attendance_unavailable' | 'exam_dues_outstanding'
export type Eligibility = {
  attendance: { state: EligibilityState; held: number; counted: number; percent: number | null; minimumPercent: number | null }
  dues: EligibilityState
  blocker: Blocker | null
}
export type AttendanceScope = { kind: 'daily'; sectionId: string } | { kind: 'period'; offeringIds: string[] } | { kind: 'ambiguous' }

const SKIPPED: Eligibility['attendance'] = { state: 'not_applicable', held: 0, counted: 0, percent: null, minimumPercent: null }

/** One decision per student, term and institution at a time: waivers, enrolment and card checks queue here. */
export async function lockEligibility(tx: Tx, tenant: string, studentId: string, termId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`examinations.eligibility:${tenant}:${termId}:${studentId}`}, 0))`)
}

/**
 * The attendance verdict from the lines in scope. Counts are summed, the
 * comparison is exact (counted * 100 >= held * minimum, no rounding), and the
 * percentage is only for display. A register with nothing held, or a roster
 * mixing sessions with days, has no verdict.
 */
export function attendanceDecision(lines: AttendanceLine[], rules: AttendanceRules, scope: AttendanceScope): Eligibility['attendance'] {
  const minimumPercent = rules.minimumPercent
  if (scope.kind === 'ambiguous') return { state: 'unavailable', held: 0, counted: 0, percent: null, minimumPercent }
  const picked =
    scope.kind === 'daily'
      ? lines.filter((l) => l.kind === 'daily' && l.offeringId === scope.sectionId)
      : lines.filter((l) => l.kind === 'period' && scope.offeringIds.includes(l.offeringId))
  const held = picked.reduce((a, l) => a + l.held, 0)
  const counted = picked.reduce((a, l) => a + l.present + (rules.excusedCounts ? l.excused : 0), 0)
  if (held === 0) return { state: 'unavailable', held, counted, percent: null, minimumPercent }
  const percent = Math.round((counted / held) * 1000) / 10
  return { state: counted * 100 >= held * minimumPercent ? 'passed' : 'failed', held, counted, percent, minimumPercent }
}

async function scopeOf(tx: Tx, studentId: string, termId: string): Promise<AttendanceScope> {
  const rows = (
    await tx.execute(sql`
      select o.id as offering_id, s.id as section_id, p.level::text as level
        from academic_offerings o
        join academic_section_members m on m.section_id = o.section_id and m.user_id = ${studentId}
        join academic_sections s on s.id = o.section_id
        join academic_programs p on p.id = s.program_id
       where o.term_id = ${termId}`)
  ).rows as { offering_id: string; section_id: string; level: string }[]
  const school = new Set(rows.filter((r) => r.level === 'school').map((r) => r.section_id))
  if (school.size === 0) return { kind: 'period', offeringIds: rows.map((r) => r.offering_id) }
  if (school.size === 1 && rows.every((r) => r.level === 'school')) return { kind: 'daily', sectionId: [...school][0]! }
  return { kind: 'ambiguous' }
}

/** Where a student stands for a term, inside the caller's tenant transaction. Reads only; the caller locks when it must. */
export async function eligibilityWithin(tx: Tx, tenant: string, studentId: string, termId: string): Promise<Eligibility> {
  const attendanceOn = await moduleEnabled(KNOWN, 'attendance', tenant)
  const feesOn = await moduleEnabled(KNOWN, 'fees', tenant)
  let attendance = SKIPPED
  if (attendanceOn) {
    const scope = await scopeOf(tx, studentId, termId)
    const { rules, lines } = await attendanceSummaryWithin(tx, tenant, studentId, termId)
    attendance = attendanceDecision(lines, rules, scope)
  }
  let dues: EligibilityState = 'not_applicable'
  if (feesOn) {
    const rows = (await tx.execute(sql`select balance_paise::text as balance from (${postedSql({ termId, studentId })}) as dues`)).rows as { balance: string }[]
    dues = rows.length && BigInt(rows[0]!.balance) > 0n ? 'failed' : 'passed'
  }
  const waived = new Set(
    (
      (await tx.execute(sql`
        select check_kind from exam_eligibility_waivers
         where institution_id = ${tenant} and term_id = ${termId} and student_id = ${studentId}`)).rows as { check_kind: string }[]
    ).map((r) => r.check_kind),
  )
  if (waived.has('attendance') && (attendance.state === 'failed' || attendance.state === 'unavailable')) attendance = { ...attendance, state: 'waived' }
  if (waived.has('dues') && dues === 'failed') dues = 'waived'
  const blocker: Blocker | null =
    attendance.state === 'failed'
      ? 'exam_attendance_short'
      : attendance.state === 'unavailable'
        ? 'exam_attendance_unavailable'
        : dues === 'failed'
          ? 'exam_dues_outstanding'
          : null
  return { attendance, dues, blocker }
}

const REFUSAL: Record<Blocker, string> = {
  exam_attendance_short: 'Attendance is below the required minimum.',
  exam_attendance_unavailable: 'Attendance is not available for this term.',
  exam_dues_outstanding: 'Posted fees are outstanding for this term.',
}

export function assertEligible(value: Eligibility): void {
  if (value.blocker) throw new ExamError(409, value.blocker, REFUSAL[value.blocker])
}

// --- the examination cell's waiver ---------------------------------------------------

/**
 * Grant or revoke one waiver for one student, term and check. Idempotent: a
 * repeat changes nothing and audits nothing. The reason belongs to the audit
 * event (actor included), not to the waiver row.
 */
export async function setEligibilityWaiver(actor: Actor, input: unknown) {
  if (!actor.institutionId) throw new ExamError(400, 'no_institution', 'no institution for this session')
  const tenant = actor.institutionId
  if (actor.role !== 'institution_admin' && actor.role !== 'super_admin') throw new ExamError(403, 'forbidden', 'the examination cell does this')
  const d = setEligibilityWaiverSchema.parse(input)
  const none = () => new ExamError(404, 'no_such_exam_candidate', 'No such examination candidate.')
  return withTenant(tenant, async (tx) => {
    await lockEligibility(tx, tenant, d.studentId, d.termId)
    const [term] = (await tx.execute(sql`select id from academic_terms where id = ${d.termId}`)).rows
    const [student] = (
      await tx.execute(sql`select 1 from users where id = ${d.studentId} and institution_id = ${tenant} and role = 'student' and erased_at is null`)
    ).rows
    if (!term || !student) throw none()
    if (d.action === 'grant') {
      // The roster test is the one enrolment uses; a revoke needs none, so a withdrawn student's waiver can still go.
      const [rostered] = (
        await tx.execute(sql`
          select 1 from academic_offerings o
            join academic_section_members m on m.section_id = o.section_id and m.user_id = ${d.studentId}
           where o.term_id = ${d.termId} limit 1`)
      ).rows
      if (!rostered) throw none()
    }
    const rows =
      d.action === 'grant'
        ? (
            await tx.execute(sql`
              insert into exam_eligibility_waivers (institution_id, term_id, student_id, check_kind)
              values (${tenant}, ${d.termId}, ${d.studentId}, ${d.check})
              on conflict do nothing returning check_kind`)
          ).rows
        : (
            await tx.execute(sql`
              delete from exam_eligibility_waivers
               where institution_id = ${tenant} and term_id = ${d.termId} and student_id = ${d.studentId} and check_kind = ${d.check}
              returning check_kind`)
          ).rows
    if (rows.length) {
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: 'examinations',
        action: d.action === 'grant' ? 'eligibility.waiver_granted' : 'eligibility.waiver_revoked',
        entity: 'exam_eligibility_waivers',
        entityId: `${d.termId}:${d.studentId}:${d.check}`,
        reason: d.reason,
        detail: { termId: d.termId, studentId: d.studentId, check: d.check },
      })
    }
    return {
      termId: d.termId,
      studentId: d.studentId,
      check: d.check,
      waived: d.action === 'grant',
      changed: rows.length > 0,
      notice: d.action === 'grant' ? 'Eligibility waiver saved.' : 'Eligibility waiver revoked.',
    }
  })
}
