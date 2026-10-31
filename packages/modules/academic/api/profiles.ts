import { assertCanAccessStudent, viewsOnBehalf, type StudentPurpose } from '@campusos/module-framework'
import { eq } from 'drizzle-orm'
import * as z from 'zod'
import { audit, consentGiven, users, withTenant } from '@campusos/db'
import { studentProfiles } from '../schema'
import { AcademicError, requireReader, requireWriter, type Actor } from './operations'

/**
 * A student's roll and registration numbers, phone and address. The office
 * keeps them; the student reads their own and is asked to confirm them before
 * an examination enrolment -- a mistake is theirs to report, not to edit, as
 * KIIT's portal has it.
 */

const MODULE = 'academic'

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)
const opt = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional())

export const studentProfileSchema = z
  .object({
    studentId: z.string().min(1),
    rollNo: opt(32),
    registrationNo: opt(32),
    phone: z.preprocess(blankToNull, z.string().trim().regex(/^[0-9+() -]{7,20}$/, 'a phone number').nullable().optional()),
    addressLine: opt(300),
    city: opt(80),
    state: opt(80),
    postalCode: opt(12),
    emergencyContact: opt(120),
    dateOfBirth: z.preprocess(blankToNull, z.iso.date().nullable().optional()),
    apaarId: z.preprocess(blankToNull, z.string().trim().regex(/^[0-9]{12}$/, 'twelve digits').nullable().optional()),
  })
  .meta({ id: 'AcademicStudentProfile' })

export interface StudentProfile {
  studentId: string
  name: string
  email: string | null
  rollNo: string | null
  registrationNo: string | null
  phone: string | null
  addressLine: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  emergencyContact: string | null
  /** YYYY-MM-DD, set by the office. */
  dateOfBirth: string | null
  /** As given, not verified with APAAR. Null for everyone but the student, a guardian and the office (D16). */
  apaarId: string | null
  /** One line, as an envelope or an admit card prints it. */
  address: string | null
  updatedAt: Date | null
}

/**
 * Contact details are the `profile` purpose (SEC-07): the student, a verified
 * guardian, the class teacher, the mentor, the HoD and the office. A module
 * that needs the profile for its own read (a grade report's name and roll
 * number, a demand letter's address) asks under that read's purpose.
 */
export async function studentProfile(actor: Actor, studentId: string, purpose: StudentPurpose = 'profile'): Promise<StudentProfile> {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    await assertCanAccessStudent(tx, actor, studentId, purpose)
    const [u] = await tx
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, dateOfBirth: users.dateOfBirth })
      .from(users)
      .where(eq(users.id, studentId))
    if (!u || u.role !== 'student') throw new AcademicError(404, 'no_such_student', 'no such student')
    const [p] = await tx.select().from(studentProfiles).where(eq(studentProfiles.studentId, studentId))
    const address = p
      ? [p.addressLine, p.city, p.state, p.postalCode].filter((x) => x && x.trim()).join(', ') || null
      : null
    return {
      studentId,
      name: u.name ?? u.email ?? studentId,
      email: u.email,
      rollNo: p?.rollNo ?? null,
      registrationNo: p?.registrationNo ?? null,
      phone: p?.phone ?? null,
      addressLine: p?.addressLine ?? null,
      city: p?.city ?? null,
      state: p?.state ?? null,
      postalCode: p?.postalCode ?? null,
      emergencyContact: p?.emergencyContact ?? null,
      dateOfBirth: u.dateOfBirth,
      // The ID is not for staff who read the profile for their own purpose (Supreme Court direction, D16).
      apaarId: actor.id === studentId || viewsOnBehalf(actor, studentId) || actor.role === 'institution_admin' || actor.role === 'super_admin' ? (p?.apaarId ?? null) : null,
      address,
      updatedAt: p?.updatedAt ?? null,
    }
  })
}

export async function setStudentProfile(actor: Actor, input: unknown) {
  const tenant = requireWriter(actor)
  const d = studentProfileSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [before] = await tx.select().from(studentProfiles).where(eq(studentProfiles.studentId, d.studentId))
    // A field left out is kept; an explicit null clears it. An API caller
    // correcting a phone number must not wipe the roll number by omission.
    const fields = ['rollNo', 'registrationNo', 'phone', 'addressLine', 'city', 'state', 'postalCode', 'emergencyContact'] as const
    const values: Partial<Record<(typeof fields)[number] | 'apaarId', string | null>> & { updatedBy: string } = { updatedBy: actor.id }
    for (const f of fields) if (d[f] !== undefined) values[f] = d[f] ?? null
    if (d.apaarId !== undefined) {
      values.apaarId = d.apaarId ?? null
      if (d.apaarId && !(await consentGiven(tx, d.studentId, 'apaar'))) {
        throw new AcademicError(409, 'apaar_needs_consent', 'record the parent’s or student’s consent to APAAR before saving the ID')
      }
    }
    try {
      await tx
        .insert(studentProfiles)
        .values({ institutionId: tenant, studentId: d.studentId, ...values })
        .onConflictDoUpdate({ target: studentProfiles.studentId, set: values })
    } catch (e) {
      const c = (e as { cause?: { constraint?: string } }).cause?.constraint
      if (c === 'academic_student_profile_student') throw new AcademicError(400, c, 'a profile is kept for a student')
      if (c === 'academic_student_profiles_roll') throw new AcademicError(409, c, 'that roll number is already somebody else’s')
      if (c === 'academic_student_profiles_registration') throw new AcademicError(409, c, 'that registration number is already somebody else’s')
      if (c === 'academic_student_profiles_apaar_unique') throw new AcademicError(409, c, 'that APAAR ID is already somebody else’s')
      if (c === 'academic_apaar_needs_consent') throw new AcademicError(409, 'apaar_needs_consent', 'record the parent’s or student’s consent to APAAR before saving the ID')
      throw e
    }
    const changed: string[] = [...fields, 'apaarId' as const].filter((k) => k in values && (before?.[k] ?? null) !== values[k])
    if (d.dateOfBirth !== undefined) {
      const [u] = await tx.select({ dob: users.dateOfBirth }).from(users).where(eq(users.id, d.studentId))
      if ((u?.dob ?? null) !== (d.dateOfBirth ?? null)) {
        try {
          await tx.update(users).set({ dateOfBirth: d.dateOfBirth ?? null }).where(eq(users.id, d.studentId))
        } catch (e) {
          if ((e as { cause?: { constraint?: string } }).cause?.constraint === 'users_date_of_birth_range') {
            throw new AcademicError(400, 'users_date_of_birth_range', 'a date of birth is in the past')
          }
          throw e
        }
        changed.push('dateOfBirth')
      }
    }
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      moduleId: MODULE,
      action: before ? 'update' : 'create',
      entity: 'academic_student_profiles',
      entityId: d.studentId,
      reason: changed.length ? `changed: ${changed.join(', ')}` : 'saved unchanged',
    })
    return { studentId: d.studentId, notice: changed.length ? `Saved: ${changed.join(', ')}.` : 'Nothing changed.' }
  })
}
