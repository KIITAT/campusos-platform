import { sql, type SQL } from 'drizzle-orm'
import { PluginError, type PluginActor } from './plugin'
import { ADMIN, hasRole } from './roles'
import { viewsOnBehalf, type Role } from './types'

/**
 * May this person see this student, for this purpose? (SEC-07, decision 193)
 *
 * A role alone no longer answers it: a lecturer sees the students they teach,
 * a HoD those of their department, a mentor their mentees. Which relations
 * exist is up to the modules installed. Each declares its own as a view in the
 * `student_relations` schema (viewer_id, student_id, relation, purposes), and
 * core's `campusos_student_relation` asks them all in one call. Views and not
 * a registry in memory, because every plugin bundle carries its own copy of
 * this package.
 *
 * Called inside the operation, in its transaction, so it holds on every way
 * in: the API, page loaders, the parents module's in-process calls.
 */
export const STUDENT_PURPOSES = [
  /** Contact details: phone, address, emergency contact. */
  'profile',
  /** Transcript, completions, programmes, eligibility, degree audit, grade report. */
  'academic_record',
  'admit_card',
  'attendance',
  /** Mentoring notes, the mentee view, leave and its documents. */
  'mentoring',
  'skills',
  'certificates',
  'fee_ledger',
] as const
export type StudentPurpose = (typeof STUDENT_PURPOSES)[number]

/** What a verified guardian may see for their child (decisions 52 and 54). */
const GUARDIAN: readonly StudentPurpose[] = ['profile', 'academic_record', 'admit_card', 'attendance', 'certificates', 'fee_ledger']

/** An office that sees one purpose for every student. */
const GRANTS: Partial<Record<Role, readonly StudentPurpose[]>> = { accounts_staff: ['fee_ledger'] }

/** Any drizzle transaction. */
interface Executor {
  execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }>
}
type Viewer = Pick<PluginActor, 'id' | 'role' | 'institutionId' | 'viewerOf' | 'authzReportOnly'>

export async function canAccessStudent(tx: Executor, actor: Viewer, studentId: string, purpose: StudentPurpose): Promise<boolean> {
  if (!actor.institutionId || actor.role === 'pending') return false
  if (actor.id === studentId) return true
  if (viewsOnBehalf(actor, studentId) && GUARDIAN.includes(purpose)) return true
  if (hasRole(actor.role, ADMIN)) return true
  if (GRANTS[actor.role]?.includes(purpose)) return true
  if (actor.role === 'student' || actor.role === 'parent') return false
  const { rows } = await tx.execute(sql`select public.campusos_student_relation(${actor.id}, ${studentId}, ${purpose}) as relation`)
  return rows[0]?.relation != null
}

/**
 * Refuses with 403 `not_your_student`, and logs the refusal (ids only). For a
 * module the host runs report-only (decision 196) it logs and allows instead.
 * Refusals are logged, not audited (decision 195): nothing changed, and an
 * audit row per refusal would let anyone grow the chain at will.
 */
export async function assertCanAccessStudent(tx: Executor, actor: Viewer, studentId: string, purpose: StudentPurpose): Promise<void> {
  if (await canAccessStudent(tx, actor, studentId, purpose)) return
  const reportOnly = actor.authzReportOnly === true && actor.role !== 'pending'
  console.error(JSON.stringify({
    event: reportOnly ? 'authz.would_refuse' : 'authz.refused',
    layer: 'student',
    actor: actor.id,
    role: actor.role,
    student: studentId,
    purpose,
  }))
  if (!reportOnly) throw new PluginError(403, 'not_your_student', 'you may not see this student’s record')
}
