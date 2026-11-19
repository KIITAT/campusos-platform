import * as z from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import { addressStatus, audit, INVITATION_MAX_DAYS, issueInvitation, normaliseEmail, users, withTenant } from '@campusos/db'
import { moduleEnabled } from '@campusos/module-framework'
import { programs, sectionMembers, sections, studentPrograms, studentProfiles, terms, STUDENT_CATEGORIES } from '@campusos/module-academic/schema'
import { formatPaise, issueStudentWithin, type Actor as FeesActor } from '@campusos/module-fees/api'
import { manifest as feesManifest } from '@campusos/module-fees/manifest'
import { manifest } from '../manifest'
import { enquiries, applications, rollCounters } from '../schema'
import { ADMIN, DomainError, log, person, tenant, type Actor, type Tx } from './core'
export * from './core'

export const enquirySchema = z.object({ name: z.string().trim().min(2).max(150), email: z.email().max(200), phone: z.string().max(30).optional(), note: z.string().max(2000).optional() })
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)
const today = () => new Date().toISOString().slice(0, 10)
export const applySchema = z.object({
  enquiryId: z.uuid(), programId: z.uuid(), termId: z.uuid(),
  applicantName: z.preprocess(blank, z.string().trim().min(2).max(150).optional()),
  applicantEmail: z.preprocess(blank, z.email().max(200).optional()),
  dateOfBirth: z.preprocess(blank, z.iso.date().refine(d => d >= '1900-01-01' && d <= today(), 'a date of birth is in the past').optional()),
  category: z.preprocess(blank, z.enum(STUDENT_CATEGORIES).optional()),
})
export const decisionSchema = z.object({ applicationId: z.uuid(), decision: z.enum(['offer', 'reject', 'withdraw']), reason: z.string().trim().min(5).max(1000) })
export const acceptSchema = z.object({ applicationId: z.uuid(), sectionId: z.uuid(), studentId: z.preprocess(blank, z.string().min(1).optional()) })

export async function addEnquiry(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = enquirySchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [row] = await transaction.insert(enquiries).values({ institutionId, ...data }).returning()
    await log(transaction, actor, 'enquiry.created', row!.id, 'Office recorded an admission enquiry')
    return row!
  })
}
export const listEnquiries = (actor: Actor) => withTenant(tenant(actor, ADMIN), transaction => transaction.select().from(enquiries).orderBy(desc(enquiries.createdAt)).limit(1000))
export const listApplications = (actor: Actor) => withTenant(tenant(actor, ADMIN), transaction => transaction.select({ id: applications.id, name: sql<string>`coalesce(${applications.applicantName}, ${enquiries.name})`, email: sql<string>`coalesce(${applications.applicantEmail}, ${enquiries.email})`, program: programs.name, term: terms.name, status: applications.status, studentId: applications.studentId, reason: applications.reason }).from(applications).innerJoin(enquiries, eq(enquiries.id, applications.enquiryId)).innerJoin(programs, eq(programs.id, applications.programId)).innerJoin(terms, eq(terms.id, applications.termId)).orderBy(desc(applications.createdAt)).limit(1000))

export async function apply(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = applySchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [enquiry] = await transaction.select().from(enquiries).where(eq(enquiries.id, data.enquiryId)).for('update')
    const [program] = await transaction.select().from(programs).where(eq(programs.id, data.programId))
    const [term] = await transaction.select().from(terms).where(eq(terms.id, data.termId))
    if (!enquiry || !program || !term) throw new DomainError(404, 'not_found', 'Choose an enquiry, programme and intake term in this institution.')
    const [row] = await transaction.insert(applications).values({ institutionId, ...data, applicantEmail: data.applicantEmail === undefined ? undefined : normaliseEmail(data.applicantEmail) }).onConflictDoNothing().returning()
    if (!row) throw new DomainError(409, 'already_applied', 'This enquiry already has an application for this programme and term.')
    await log(transaction, actor, 'application.submitted', row.id, 'Enquiry converted to an application')
    return row
  })
}
export async function decide(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = decisionSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [row] = await transaction.select().from(applications).where(eq(applications.id, data.applicationId)).for('update')
    if (!row) throw new DomainError(404, 'not_found', 'No such application.')
    const permitted = data.decision === 'offer' ? row.status === 'submitted' : ['submitted', 'offered'].includes(row.status)
    if (!permitted) throw new DomainError(409, 'invalid_transition', 'This decision is not available in the current state.')
    const status = { offer: 'offered', reject: 'rejected', withdraw: 'withdrawn' }[data.decision]
    const [updated] = await transaction.update(applications).set({ status, reason: data.reason, updatedAt: new Date() }).where(eq(applications.id, row.id)).returning()
    await log(transaction, actor, `application.${status}`, row.id, data.reason)
    return updated!
  })
}
/** A constraint the database refused, mapped to the office's words (D15 of plans/P1-12a.md). */
function userConstraint(e: unknown): never {
  const c = (e as { cause?: { constraint?: string } }).cause?.constraint
  if (c === 'users_email_unique') throw new DomainError(409, 'address_just_taken', 'Another request has just used this address. Try again.')
  if (c === 'users_date_of_birth_range') throw new DomainError(400, 'date_of_birth_range', 'A date of birth is in the past.')
  throw e
}

const exhausted = () => new DomainError(409, 'roll_numbers_exhausted', 'No free roll number for this programme and year. Set the roll number by hand on the student profile.')

/**
 * The next free roll number, `<intake year><programme code><4 digits>` (D9).
 * The counter row's lock serialises acceptances in one programme and year;
 * a number somebody typed by hand is skipped.
 */
async function nextRollNo(tx: Tx, institutionId: string, programId: string, programCode: string, intakeYear: number): Promise<string> {
  const code = programCode.toUpperCase().replace(/[^A-Z0-9]/g, '')
  for (let tries = 0; tries < 50; tries++) {
    let n: number
    try {
      const [counter] = await tx.insert(rollCounters).values({ institutionId, programId, intakeYear, lastValue: 1 })
        .onConflictDoUpdate({ target: [rollCounters.institutionId, rollCounters.programId, rollCounters.intakeYear], set: { lastValue: sql`${rollCounters.lastValue} + 1` } })
        .returning({ lastValue: rollCounters.lastValue })
      n = counter!.lastValue
    } catch (e) {
      if ((e as { cause?: { constraint?: string } }).cause?.constraint === 'admissions_roll_counters_value') throw exhausted()
      throw e
    }
    const roll = `${intakeYear}${code}${String(n).padStart(4, '0')}`
    if (roll.length > 32) throw new DomainError(409, 'roll_too_long', 'The roll number would be longer than 32 characters. Shorten the programme code or set the roll number by hand.')
    const [used] = await tx.select({ id: studentProfiles.studentId }).from(studentProfiles).where(eq(studentProfiles.rollNo, roll))
    if (!used) return roll
  }
  throw exhausted()
}

/**
 * Accept an offer and enrol the applicant (FUNC-04, FUNC-02's admission half):
 * the student's account (created with a sign-in invitation, or reused), the
 * programme declaration, the section seat, the roll number and category on
 * the profile, and, when Fees is on, the term's invoice -- one transaction.
 */
export async function acceptApplication(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = acceptSchema.parse(input)
  const feesOn = await moduleEnabled([manifest, feesManifest], 'fees', institutionId)
  return withTenant(institutionId, async transaction => {
    const [row] = await transaction.select().from(applications).where(eq(applications.id, data.applicationId)).for('update')
    if (!row) throw new DomainError(404, 'not_found', 'No such application.')
    if (row.status !== 'offered') throw new DomainError(409, 'not_offered', 'Only an offered application may be accepted.')
    const [enquiry] = await transaction.select({ name: enquiries.name, email: enquiries.email }).from(enquiries).where(eq(enquiries.id, row.enquiryId))
    const [term] = await transaction.select({ code: terms.code, startsOn: terms.startsOn }).from(terms).where(eq(terms.id, row.termId))
    const [program] = await transaction.select({ code: programs.code }).from(programs).where(eq(programs.id, row.programId))
    const [section] = await transaction.select({ programId: sections.programId, label: sections.label }).from(sections).where(eq(sections.id, data.sectionId))
    if (!section || section.programId !== row.programId) throw new DomainError(409, 'section_not_in_programme', "Choose a section of this application's programme.")

    let studentId: string
    let name: string
    let link: string | null = null
    if (data.studentId) {
      const student = await person(transaction, data.studentId, 'student')
      studentId = student.id
      name = student.name ?? enquiry!.name
    } else {
      const address = normaliseEmail(row.applicantEmail ?? enquiry!.email)
      const status = await addressStatus(transaction, address)
      if (status.kind === 'taken') throw new DomainError(409, 'address_taken', "That address belongs to an account at another institution. Record the applicant's own address on the application.")
      if (status.kind === 'member') {
        if (status.role !== 'student') throw new DomainError(409, 'member_address', "That address is already an account here with another role. Record the applicant's own address on the application, or link an existing student.")
        const student = await person(transaction, status.userId, 'student')
        studentId = student.id
        name = student.name ?? enquiry!.name
      } else {
        name = row.applicantName ?? enquiry!.name
        const [created] = await transaction.insert(users).values({ institutionId, email: address, name, role: 'student', dateOfBirth: row.dateOfBirth }).returning({ id: users.id }).catch(userConstraint)
        studentId = created!.id
        await audit(transaction, { institutionId, actorId: actor.id, actorEmail: actor.email, moduleId: 'admissions', action: 'application.account_created', entity: 'users', entityId: studentId, reason: 'an account was created for an accepted applicant', detail: { applicationId: row.id, role: 'student' } })
        const issued = await issueInvitation(transaction, { institutionId, email: address, role: 'student', createdBy: actor.id, days: INVITATION_MAX_DAYS })
        await audit(transaction, { institutionId, actorId: actor.id, actorEmail: actor.email, moduleId: 'admissions', action: 'application.student_invited', entity: 'invitations', entityId: issued.invitation.id, reason: 'sign-in invitation for an accepted applicant', detail: { applicationId: row.id, studentId } })
        link = `/invite/${issued.token}`
      }
    }
    // A reused account keeps a date of birth it already has (D13).
    if (!link && row.dateOfBirth) {
      await transaction.update(users).set({ dateOfBirth: row.dateOfBirth }).where(and(eq(users.id, studentId), sql`${users.dateOfBirth} is null`)).catch(userConstraint)
    }

    const existing = await transaction.select().from(studentPrograms).where(and(eq(studentPrograms.studentId, studentId), eq(studentPrograms.status, 'active')))
    let enrollment = existing.find(program => program.programId === row.programId)
    if (!enrollment) {
      const [created] = await transaction.insert(studentPrograms).values({ institutionId, studentId, programId: row.programId, isPrimary: !existing.some(program => program.isPrimary) }).returning()
      enrollment = created!
    }
    await transaction.insert(sectionMembers).values({ institutionId, sectionId: data.sectionId, userId: studentId }).onConflictDoNothing()

    const [profile] = await transaction.select({ rollNo: studentProfiles.rollNo, category: studentProfiles.category }).from(studentProfiles).where(eq(studentProfiles.studentId, studentId))
    const rollNo = profile?.rollNo ?? await nextRollNo(transaction, institutionId, row.programId, program!.code, Number(term!.startsOn.slice(0, 4)))
    if (!profile) {
      await transaction.insert(studentProfiles).values({ institutionId, studentId, rollNo, category: row.category, updatedBy: actor.id })
    } else {
      await transaction.update(studentProfiles).set({
        ...(profile.rollNo ? {} : { rollNo }),
        ...(!profile.category && row.category ? { category: row.category } : {}),
        updatedBy: actor.id, updatedAt: new Date(),
      }).where(eq(studentProfiles.studentId, studentId))
    }

    const [accepted] = await transaction.update(applications).set({ status: 'accepted', studentId, studentProgramId: enrollment.id, updatedAt: new Date() }).where(eq(applications.id, row.id)).returning()
    await log(transaction, actor, 'application.accepted', row.id, `Offer accepted; enrolled as ${rollNo} in section ${section.label}`)

    const invoice = feesOn ? await issueStudentWithin(transaction, actor as unknown as FeesActor, row.termId, studentId) : null
    const notice = `${name} is enrolled as ${rollNo} in ${program!.code} section ${section.label}.`
      + (feesOn ? (invoice ? ` ${term!.code} fees of ${formatPaise(invoice.chargedPaise)} invoiced.` : ` Nothing new to invoice for ${term!.code}.`) : '')
      + (link ? ' Send the student this sign-in invitation link, valid for 30 days. It is shown only now.' : '')
    return { ...accepted!, rollNo, invoiceId: invoice?.invoiceId ?? null, link, notice }
  })
}
