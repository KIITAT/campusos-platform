import { and, desc, eq, sql } from 'drizzle-orm'
import { audit } from './audit'
import { CONSENT_VERSION } from './dpdp'
import type { withTenant } from './client'
import { guardianConsents } from './schema'

/** The transaction `withTenant` hands its callback. */
export type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export const CONSENT_PURPOSES = ['privacy_notice', 'care_self_checks', 'apaar'] as const
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number]
export type ConsentDecision = 'given' | 'refused' | 'withdrawn'
export type ConsentBasis = 'guardian' | 'office_record' | 'student'
export type AgeStatus = 'adult' | 'minor' | 'unknown'

/** Thrown when a student under 18 (or of unknown age) tries to give a consent that is a guardian's to give. */
export class GuardianConsentRequiredError extends Error {
  readonly status = 403
  readonly code = 'guardian_must_consent'
  constructor() {
    super('a parent or guardian gives this consent for a student under 18')
  }
}

/**
 * The only age rule: under 18 on today's date in India is a minor (DPDP Act
 * s.2(j)). A missing person or date of birth is 'unknown'; callers decide
 * what that means for them. The rule itself lives in SQL (core 0014).
 */
export async function ageStatus(tx: Tx, who: string): Promise<AgeStatus> {
  const r = await tx.execute<{ s: AgeStatus }>(sql`select public.campusos_age_status(${who}) as s`)
  return r.rows[0]!.s
}

export async function currentConsent(tx: Tx, studentId: string, purpose: ConsentPurpose) {
  const [row] = await tx
    .select({ decision: guardianConsents.decision, basis: guardianConsents.basis, recordedAt: guardianConsents.recordedAt })
    .from(guardianConsents)
    .where(and(eq(guardianConsents.studentId, studentId), eq(guardianConsents.purpose, purpose)))
    .orderBy(desc(guardianConsents.recordedAt), desc(guardianConsents.id))
    .limit(1)
  return row ? { ...row, decision: row.decision as ConsentDecision } : null
}

export async function consentGiven(tx: Tx, studentId: string, purpose: ConsentPurpose): Promise<boolean> {
  return (await currentConsent(tx, studentId, purpose))?.decision === 'given'
}

/**
 * Appends a decision and audits it in the same transaction. Does not check who
 * may record it: the calling module knows the people.
 */
export async function recordGuardianConsent(
  tx: Tx,
  r: {
    institutionId: string
    studentId: string
    purpose: ConsentPurpose
    decision: ConsentDecision
    basis: ConsentBasis
    guardianId: string | null
    recordedBy: string
    note: string | null
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(guardianConsents)
    .values({
      institutionId: r.institutionId,
      studentId: r.studentId,
      purpose: r.purpose,
      decision: r.decision,
      basis: r.basis,
      guardianId: r.guardianId,
      recordedBy: r.recordedBy,
      note: r.note,
      noticeVersion: CONSENT_VERSION,
    })
    .returning({ id: guardianConsents.id })
  await audit(tx, {
    institutionId: r.institutionId,
    actorId: r.recordedBy,
    moduleId: 'core',
    action: 'dpdp.guardian_consent',
    entity: 'guardian_consents',
    entityId: row!.id,
    reason: `${r.purpose}: ${r.decision} (${r.basis})`,
    detail: { studentId: r.studentId, purpose: r.purpose, decision: r.decision, basis: r.basis },
  })
  return { id: row!.id }
}
