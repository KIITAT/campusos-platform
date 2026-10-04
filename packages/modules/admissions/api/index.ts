import * as z from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { programs, studentPrograms, terms } from '@campusos/module-academic/schema'
import { enquiries, applications } from '../schema'
import { ADMIN, DomainError, log, person, tenant, type Actor } from './core'
export * from './core'

export const enquirySchema = z.object({ name: z.string().trim().min(2).max(150), email: z.email().max(200), phone: z.string().max(30).optional(), note: z.string().max(2000).optional() })
export const applySchema = z.object({ enquiryId: z.uuid(), programId: z.uuid(), termId: z.uuid() })
export const decisionSchema = z.object({ applicationId: z.uuid(), decision: z.enum(['offer', 'reject', 'withdraw']), reason: z.string().trim().min(5).max(1000) })
export const acceptSchema = z.object({ applicationId: z.uuid(), studentId: z.string().min(1) })

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
export const listApplications = (actor: Actor) => withTenant(tenant(actor, ADMIN), transaction => transaction.select({ id: applications.id, name: enquiries.name, email: enquiries.email, program: programs.name, term: terms.name, status: applications.status, studentId: applications.studentId, reason: applications.reason }).from(applications).innerJoin(enquiries, eq(enquiries.id, applications.enquiryId)).innerJoin(programs, eq(programs.id, applications.programId)).innerJoin(terms, eq(terms.id, applications.termId)).orderBy(desc(applications.createdAt)).limit(1000))

export async function apply(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = applySchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [enquiry] = await transaction.select().from(enquiries).where(eq(enquiries.id, data.enquiryId)).for('update')
    const [program] = await transaction.select().from(programs).where(eq(programs.id, data.programId))
    const [term] = await transaction.select().from(terms).where(eq(terms.id, data.termId))
    if (!enquiry || !program || !term) throw new DomainError(404, 'not_found', 'Choose an enquiry, programme and intake term in this institution.')
    const [row] = await transaction.insert(applications).values({ institutionId, ...data }).onConflictDoNothing().returning()
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
export async function acceptApplication(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = acceptSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [row] = await transaction.select().from(applications).where(eq(applications.id, data.applicationId)).for('update')
    if (!row) throw new DomainError(404, 'not_found', 'No such application.')
    if (row.status !== 'offered') throw new DomainError(409, 'not_offered', 'Only an offered application may be accepted.')
    await person(transaction, data.studentId, 'student')
    const existing = await transaction.select().from(studentPrograms).where(and(eq(studentPrograms.studentId, data.studentId), eq(studentPrograms.status, 'active')))
    let enrollment = existing.find(program => program.programId === row.programId)
    if (!enrollment) {
      const [created] = await transaction.insert(studentPrograms).values({ institutionId, studentId: data.studentId, programId: row.programId, isPrimary: !existing.some(program => program.isPrimary) }).returning()
      enrollment = created!
    }
    const [accepted] = await transaction.update(applications).set({ status: 'accepted', studentId: data.studentId, studentProgramId: enrollment.id, updatedAt: new Date() }).where(eq(applications.id, row.id)).returning()
    await log(transaction, actor, 'application.accepted', row.id, 'Offer accepted and linked to the academic student programme')
    return accepted!
  })
}
