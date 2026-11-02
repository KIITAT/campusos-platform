import * as z from 'zod'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import { ticked } from '@campusos/module-framework'
import { leads, lostReasons, stages, teamMembers, teams } from '../schema'
import { ADMIN, STAFF, CrmError, log, refuse, tenant, type Actor, type Tx } from './core'

export const stageSchema = z.object({ name: z.string().trim().min(1).max(60), seq: z.coerce.number().int().min(1).max(999) })
export const stageUpdateSchema = z.object({
  stageId: z.uuid(), name: z.string().trim().min(1).max(60).optional(), seq: z.preprocess(v => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(999).optional()),
  archived: z.preprocess(ticked, z.boolean()).optional(),
})
export const reasonSchema = z.object({ name: z.string().trim().min(2).max(120) })
export const reasonArchiveSchema = z.object({ reasonId: z.uuid() })
export const teamSchema = z.object({ name: z.string().trim().min(2).max(80), managerId: z.string().min(1) })
export const memberSchema = z.object({ teamId: z.uuid(), userId: z.string().min(1) })

/**
 * The visibility rule (decision 396), and the only place it lives.
 * `null` means everyone (an administrator); otherwise the people whose leads
 * the actor may see: themself and the members of every team they manage.
 */
export async function ownersOf(tx: Tx, actor: Actor): Promise<string[] | null> {
  if (ADMIN.includes(actor.role)) return null
  const mine = await tx.select({ id: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.userId, actor.id))
  const managed = await tx.select({ id: teams.id }).from(teams).where(eq(teams.managerId, actor.id))
  if (!mine.length && !managed.length) throw new CrmError(403, 'not_in_sales_team', 'Ask an administrator to add you to a sales team.')
  const reports = managed.length
    ? await tx.select({ id: teamMembers.userId }).from(teamMembers).innerJoin(teams, and(eq(teams.institutionId, teamMembers.institutionId), eq(teams.id, teamMembers.teamId))).where(eq(teams.managerId, actor.id))
    : []
  return [...new Set([actor.id, ...reports.map(row => row.id)])]
}
/** A member or a manager of a sales team. */
export async function isSalesperson(tx: Tx, userId: string): Promise<boolean> {
  const [member] = await tx.select({ id: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.userId, userId)).limit(1)
  if (member) return true
  const [team] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.managerId, userId)).limit(1)
  return !!team
}
/** The first lead in an institution brings the default stages and lost reasons. */
export async function ensureDefaults(tx: Tx, institutionId: string) {
  await tx.execute(sql`insert into crm_stages (institution_id, name, seq)
    select ${institutionId}::uuid, n, s from (values ('New', 10), ('Qualified', 20), ('Proposition', 30), ('Negotiation', 40)) v(n, s)
    where not exists (select 1 from crm_stages where institution_id = ${institutionId}::uuid) on conflict do nothing`)
  await tx.execute(sql`insert into crm_lost_reasons (institution_id, name)
    select ${institutionId}::uuid, n from (values ('Too expensive'), ('Not interested'), ('Chose a competitor')) v(n)
    where not exists (select 1 from crm_lost_reasons where institution_id = ${institutionId}::uuid) on conflict do nothing`)
}
async function staffPerson(tx: Tx, id: string) {
  const [user] = await tx.select().from(users).where(eq(users.id, id))
  if (!user || user.erasedAt) throw new CrmError(404, 'no_such_person', 'No matching person in this institution.')
  if (!STAFF.includes(user.role)) throw new CrmError(400, 'not_staff', 'Choose a member of staff.')
  return user
}
const run = async <T>(work: () => Promise<T>): Promise<T> => { try { return await work() } catch (error) { throw refuse(error) } }

export async function createStage(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = stageSchema.parse(input)
  return withTenant(institutionId, tx => run(async () => {
    const [row] = await tx.insert(stages).values({ institutionId, ...data }).returning({ id: stages.id })
    await log(tx, actor, 'stage.created', row!.id, 'Pipeline stage added')
    return { id: row!.id, notice: 'Saved.' }
  }))
}
export async function updateStage(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = stageUpdateSchema.parse(input)
  return withTenant(institutionId, tx => run(async () => {
    const [row] = await tx.select().from(stages).where(eq(stages.id, data.stageId)).for('update')
    if (!row) throw new CrmError(404, 'not_found', 'No such stage.')
    await tx.update(stages).set({ ...(data.name ? { name: data.name } : {}), ...(data.seq ? { seq: data.seq } : {}), ...(data.archived === undefined ? {} : { archivedAt: data.archived ? new Date() : null }) }).where(eq(stages.id, row.id))
    await log(tx, actor, 'stage.updated', row.id, 'Pipeline stage changed')
    return { id: row.id, notice: 'Saved.' }
  }))
}
export async function createLostReason(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = reasonSchema.parse(input)
  return withTenant(institutionId, tx => run(async () => {
    const [row] = await tx.insert(lostReasons).values({ institutionId, name: data.name }).returning({ id: lostReasons.id })
    await log(tx, actor, 'lost_reason.created', row!.id, 'Lost reason added')
    return { id: row!.id, notice: 'Saved.' }
  }))
}
export async function archiveLostReason(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = reasonArchiveSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const [row] = await tx.update(lostReasons).set({ archivedAt: new Date() }).where(and(eq(lostReasons.id, data.reasonId), isNull(lostReasons.archivedAt))).returning({ id: lostReasons.id })
    if (!row) throw new CrmError(404, 'not_found', 'No such active lost reason.')
    await log(tx, actor, 'lost_reason.archived', row.id, 'Lost reason archived')
    return { id: row.id, notice: 'Saved.' }
  })
}
export async function createTeam(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = teamSchema.parse(input)
  return withTenant(institutionId, tx => run(async () => {
    await staffPerson(tx, data.managerId)
    const [row] = await tx.insert(teams).values({ institutionId, name: data.name, managerId: data.managerId }).returning({ id: teams.id })
    await log(tx, actor, 'team.created', row!.id, 'Sales team created')
    return { id: row!.id, notice: 'Saved.' }
  }))
}
export async function addTeamMember(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = memberSchema.parse(input)
  return withTenant(institutionId, tx => run(async () => {
    const [team] = await tx.select().from(teams).where(eq(teams.id, data.teamId))
    if (!team) throw new CrmError(404, 'not_found', 'No such team.')
    await staffPerson(tx, data.userId)
    await tx.insert(teamMembers).values({ institutionId, teamId: data.teamId, userId: data.userId })
    await log(tx, actor, 'team.member_added', data.teamId, 'Member added to a sales team')
    return { id: data.teamId, notice: 'Saved.' }
  }))
}
export async function removeTeamMember(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = memberSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const [open] = await tx.select({ id: leads.id }).from(leads).where(and(eq(leads.ownerId, data.userId), eq(leads.status, 'open'))).limit(1)
    if (open) throw new CrmError(409, 'owns_open_leads', "Reassign this person's open leads first.")
    const removed = await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, data.teamId), eq(teamMembers.userId, data.userId))).returning({ id: teamMembers.userId })
    if (!removed.length) throw new CrmError(404, 'not_found', 'That person is not in this team.')
    await log(tx, actor, 'team.member_removed', data.teamId, 'Member removed from a sales team')
    return { id: data.teamId, notice: 'Saved.' }
  })
}
/** Stages, lost reasons and teams. A person outside every team is refused (administrators excepted). */
export async function settings(actor: Actor) {
  return withTenant(tenant(actor), async tx => {
    await ownersOf(tx, actor)
    const [stageRows, reasonRows, teamRows, memberRows] = await Promise.all([
      tx.select({ id: stages.id, name: stages.name, seq: stages.seq, archived: sql<boolean>`${stages.archivedAt} is not null` }).from(stages).orderBy(asc(stages.seq)),
      tx.select({ id: lostReasons.id, name: lostReasons.name, archived: sql<boolean>`${lostReasons.archivedAt} is not null` }).from(lostReasons).orderBy(asc(lostReasons.name)),
      tx.select({ id: teams.id, name: teams.name, managerId: teams.managerId, managerName: users.name }).from(teams).innerJoin(users, eq(users.id, teams.managerId)).orderBy(asc(teams.name)),
      tx.select({ teamId: teamMembers.teamId, userId: teamMembers.userId, name: users.name }).from(teamMembers).innerJoin(users, eq(users.id, teamMembers.userId)).orderBy(asc(users.name)),
    ])
    return { stages: stageRows, reasons: reasonRows, teams: teamRows.map(team => ({ ...team, members: memberRows.filter(m => m.teamId === team.id).map(m => ({ userId: m.userId, name: m.name })) })) }
  })
}

/** Who a lead may be given to: the actor's owners set, or for an administrator every salesperson and themself. */
export async function ownerChoices(actor: Actor): Promise<{ value: string; label: string }[]> {
  return withTenant(tenant(actor), async tx => {
    const owners = await ownersOf(tx, actor)
    const ids = owners ?? [...new Set([actor.id, ...(await tx.select({ id: teamMembers.userId }).from(teamMembers)).map(r => r.id), ...(await tx.select({ id: teams.managerId }).from(teams)).map(r => r.id)])]
    if (!ids.length) return []
    const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(and(inArray(users.id, ids), isNull(users.erasedAt))).orderBy(asc(users.name))
    return rows.map(r => ({ value: r.id, label: r.name ?? r.id }))
  })
}
/** Staff who can be a team manager or member. */
export async function staffChoices(actor: Actor): Promise<{ value: string; label: string }[]> {
  return withTenant(tenant(actor, ADMIN), async tx => {
    const rows = await tx.select({ id: users.id, name: users.name, role: users.role }).from(users).where(isNull(users.erasedAt)).orderBy(asc(users.name))
    return rows.filter(r => STAFF.includes(r.role)).map(r => ({ value: r.id, label: `${r.name ?? r.id} · ${r.role.replaceAll('_', ' ')}` }))
  })
}
