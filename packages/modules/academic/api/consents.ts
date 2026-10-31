import { viewsOnBehalf } from '@campusos/module-framework'
import { eq } from 'drizzle-orm'
import * as z from 'zod'
import {
  ageStatus,
  CONSENT_PURPOSES,
  currentConsent,
  recordGuardianConsent,
  users,
  withTenant,
  type ConsentBasis,
  type ConsentPurpose,
} from '@campusos/db'
import { studentProfiles } from '../schema'
import { AcademicError, requireReader, type Actor } from './operations'

/**
 * The choices a guardian, an adult student or the office records about a
 * student: the privacy notice, counselling self-checks and the APAAR ID.
 * Academic owns this because it owns the profile and because care and parents
 * both depend on it. Core keeps the rows (`guardian_consents`); this module
 * knows who may record a choice for whom.
 */

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)

export const recordConsentSchema = z
  .object({
    studentId: z.string().min(1),
    purpose: z.enum(CONSENT_PURPOSES),
    decision: z.enum(['given', 'refused', 'withdrawn']),
    note: z.preprocess(blankToNull, z.string().trim().min(1).max(300).nullable().optional()),
  })
  .meta({ id: 'AcademicConsentChoice' })

export interface StudentConsent {
  purpose: ConsentPurpose
  decision: 'given' | 'refused' | 'withdrawn' | 'not asked'
  basis: ConsentBasis | null
  recordedAt: Date | null
}

const isOffice = (a: Actor) => a.role === 'institution_admin' || a.role === 'super_admin'

/** Records one choice. Who may, and on what basis, is decision D14 of plans/P1-08b.md. */
export async function recordStudentConsent(actor: Actor, input: unknown) {
  const tenant = requireReader(actor)
  const d = recordConsentSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    // Lock the student first, as setStudentProfile does: with no profile row yet
    // there is nothing else to serialise a refusal against a first save of the ID.
    // NO KEY UPDATE, because audit rows hold a key share on this row.
    const [u] = await tx.select({ role: users.role }).from(users).where(eq(users.id, d.studentId)).for('no key update')
    if (!u || u.role !== 'student') throw new AcademicError(404, 'no_such_student', 'no such student')
    const adult = (await ageStatus(tx, d.studentId)) === 'adult'

    let basis: ConsentBasis
    let guardianId: string | null = null
    if (isOffice(actor)) {
      if (!d.note) throw new AcademicError(400, 'note_required', 'say which form or letter records this choice')
      basis = 'office_record'
    } else if (actor.id === d.studentId) {
      if (!adult) throw new AcademicError(403, 'guardian_must_consent', 'a parent or guardian gives this consent for a student under 18')
      basis = 'student'
    } else if (viewsOnBehalf(actor, d.studentId)) {
      if (adult) throw new AcademicError(409, 'student_is_adult', 'this student is 18 or over and decides for themselves')
      basis = 'guardian'
      guardianId = actor.id
    } else {
      throw new AcademicError(403, 'not_permitted_consent', 'you may not record this choice for this student')
    }

    const { id } = await recordGuardianConsent(tx, {
      institutionId: tenant,
      studentId: d.studentId,
      purpose: d.purpose,
      decision: d.decision,
      basis,
      guardianId,
      recordedBy: actor.id,
      note: d.note ?? null,
    })
    // A refusal or withdrawal takes the ID with it.
    if (d.purpose === 'apaar' && d.decision !== 'given') {
      await tx.update(studentProfiles).set({ apaarId: null }).where(eq(studentProfiles.studentId, d.studentId))
    }
    return { id, notice: 'Choice recorded.' }
  })
}

/** The current decision per purpose: readable by the student, a guardian and the office. */
export async function studentConsents(actor: Actor, studentId: string): Promise<StudentConsent[]> {
  const tenant = requireReader(actor)
  if (!isOffice(actor) && actor.id !== studentId && !viewsOnBehalf(actor, studentId)) {
    throw new AcademicError(403, 'not_permitted_consent', 'you may not see these choices')
  }
  return withTenant(tenant, async (tx) =>
    Promise.all(
      CONSENT_PURPOSES.map(async (purpose) => {
        const c = await currentConsent(tx, studentId, purpose)
        return { purpose, decision: c?.decision ?? 'not asked', basis: (c?.basis as ConsentBasis | undefined) ?? null, recordedAt: c?.recordedAt ?? null }
      }),
    ),
  )
}
