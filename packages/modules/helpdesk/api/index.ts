import * as z from 'zod'
import { asc, desc, eq, or } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import { ticked } from '@campusos/module-framework'
import { cases, messages } from '../schema'
import { ADMIN, STAFF, DomainError, log, person, tenant, type Actor, type Tx } from './core'
export * from './core'

export const caseSchema = z.object({ subject: z.string().trim().min(5).max(200), description: z.string().trim().min(10).max(10000), kind: z.enum(['helpdesk', 'grievance']), confidential: z.preprocess(ticked, z.boolean()).default(false) })
export const assignmentSchema = z.object({ caseId: z.uuid(), assigneeId: z.string().min(1) })
export const messageSchema = z.object({ caseId: z.uuid(), body: z.string().trim().min(1).max(10000) })
export const resolutionSchema = z.object({ caseId: z.uuid(), resolution: z.string().trim().min(5).max(5000) })
export const reopenSchema = z.object({ caseId: z.uuid(), reason: z.string().trim().min(5).max(5000) })

async function visible(transaction: Tx, actor: Actor, caseId: string) {
  const [row] = await transaction.select().from(cases).where(eq(cases.id, z.uuid().parse(caseId))).for('update')
  if (!row || (!ADMIN.includes(actor.role) && row.reporterId !== actor.id && !(STAFF.includes(actor.role) && row.assigneeId === actor.id))) throw new DomainError(404, 'not_found', 'No accessible case.')
  return row
}
export async function createCase(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = caseSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    await person(transaction, actor.id)
    const [row] = await transaction.insert(cases).values({ institutionId, reporterId: actor.id, ...data, confidential: data.kind === 'grievance' || data.confidential }).returning()
    await log(transaction, actor, 'case.created', row!.id, 'New support case submitted')
    return row!
  })
}
export const listCases = (actor: Actor) => withTenant(tenant(actor), transaction => transaction.select().from(cases).where(ADMIN.includes(actor.role) ? undefined : or(eq(cases.reporterId, actor.id), STAFF.includes(actor.role) ? eq(cases.assigneeId, actor.id) : undefined)).orderBy(desc(cases.updatedAt)).limit(1000))
export async function caseDetail(actor: Actor, caseId: string) {
  return withTenant(tenant(actor), async transaction => {
    const issue = await visible(transaction, actor, caseId)
    const discussion = await transaction.select({ id: messages.id, author: users.name, body: messages.body, createdAt: messages.createdAt }).from(messages).innerJoin(users, eq(users.id, messages.authorId)).where(eq(messages.caseId, issue.id)).orderBy(asc(messages.createdAt))
    return { case: issue, messages: discussion }
  })
}
export async function assignCase(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = assignmentSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const issue = await visible(transaction, actor, data.caseId)
    if (issue.status === 'resolved') throw new DomainError(409, 'resolved', 'Reopen the case before assigning it.')
    const assignee = await person(transaction, data.assigneeId)
    if (!STAFF.includes(assignee.role)) throw new DomainError(400, 'not_staff', 'Choose a staff member as assignee.')
    const [updated] = await transaction.update(cases).set({ assigneeId: assignee.id, status: 'assigned', updatedAt: new Date() }).where(eq(cases.id, issue.id)).returning()
    await log(transaction, actor, 'case.assigned', issue.id, 'Case assigned to a staff member')
    return updated!
  })
}
export async function postMessage(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = messageSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const issue = await visible(transaction, actor, data.caseId)
    if (issue.status === 'resolved') throw new DomainError(409, 'resolved', 'Reopen the case before continuing the discussion.')
    const [message] = await transaction.insert(messages).values({ institutionId, caseId: issue.id, authorId: actor.id, body: data.body }).returning()
    await transaction.update(cases).set({ updatedAt: new Date() }).where(eq(cases.id, issue.id))
    await log(transaction, actor, 'case.message', issue.id, 'A case participant added a message')
    return message!
  })
}
export async function resolveCase(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = resolutionSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const issue = await visible(transaction, actor, data.caseId)
    if (!ADMIN.includes(actor.role) && !(STAFF.includes(actor.role) && issue.assigneeId === actor.id)) throw new DomainError(403, 'not_assigned', 'Only the assigned officer or an administrator resolves this case.')
    if (issue.status === 'resolved') throw new DomainError(409, 'already_resolved', 'This case is already resolved.')
    const [updated] = await transaction.update(cases).set({ status: 'resolved', resolution: data.resolution, updatedAt: new Date() }).where(eq(cases.id, issue.id)).returning()
    await log(transaction, actor, 'case.resolved', issue.id, 'Assigned officer recorded a resolution')
    return updated!
  })
}
export async function reopenCase(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = reopenSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const issue = await visible(transaction, actor, data.caseId)
    if (!ADMIN.includes(actor.role) && issue.reporterId !== actor.id) throw new DomainError(403, 'not_reporter', 'Only the reporter or administrator can reopen.')
    if (issue.status !== 'resolved') throw new DomainError(409, 'not_resolved', 'Only a resolved case can be reopened.')
    const [updated] = await transaction.update(cases).set({ status: 'open', resolution: null, updatedAt: new Date() }).where(eq(cases.id, issue.id)).returning()
    await transaction.insert(messages).values({ institutionId, caseId: issue.id, authorId: actor.id, body: data.reason })
    await log(transaction, actor, 'case.reopened', issue.id, 'Reporter requested further work on the case')
    return updated!
  })
}
