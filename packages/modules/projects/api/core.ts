import * as z from 'zod'
import { and, eq } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import { ADMIN, OFFICE, STAFF, type PluginActor, type Role } from '@campusos/module-framework'
import { parseDecimal } from '@campusos/module-finance/api'
import { members, projects } from '../schema'

export type Actor = PluginActor
export type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
export { ADMIN, OFFICE, STAFF }

export class ProjectsError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string, readonly detail?: Record<string, unknown>) { super(message) }
}

export function tenant(actor: Actor, roles: readonly Role[]): string {
  if (!actor.institutionId) throw new ProjectsError(400, 'no_institution', 'An institution is required.')
  if (!roles.includes(actor.role)) throw new ProjectsError(403, 'forbidden', 'Your role cannot do this.')
  return actor.institutionId
}

const REFUSALS: Record<string, [400 | 409, string, string]> = {
  projects_projects_code: [409, 'code_taken', 'That project code is taken.'],
  projects_projects_cost_center: [409, 'cost_center_taken', 'Another project already uses that cost centre.'],
  projects_projects_dates: [400, 'bad_dates', 'A project ends on or after the day it starts.'],
  projects_members_person: [409, 'already_member', 'That person is already on the project.'],
  projects_stages_name: [409, 'stage_exists', 'The project already has a stage of that name.'],
  projects_milestones_name: [409, 'milestone_exists', 'The project already has a milestone of that name.'],
  projects_cost_rates_day: [409, 'rate_exists', 'That person already has a cost rate from that day.'],
  projects_timesheets_kept: [409, 'timesheet_kept', 'That time is approved, billed or costed, and is kept as it was.'],
  projects_billings_kept: [409, 'record_kept', 'Billings and costings are kept as they were made.'],
  projects_costings_kept: [409, 'record_kept', 'Billings and costings are kept as they were made.'],
}

/** Run `fn`; a refusal the database names becomes a ProjectsError. Errors that already carry a status pass. */
export async function named<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    if (typeof (e as { status?: unknown }).status === 'number') throw e
    const constraint = (e as { cause?: { constraint?: string } }).cause?.constraint
    const known = constraint ? REFUSALS[constraint] : undefined
    if (known) throw new ProjectsError(known[0], known[1], known[2])
    throw e
  }
}

export const optional = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined))
export const optionalId = z.uuid().optional().or(z.literal('').transform(() => undefined))
export const optionalDate = z.iso.date().optional().or(z.literal('').transform(() => undefined))
export const text = (min: number, max: number) => z.string().trim().min(min).max(max)

/** Rupees as typed, to paise; anything else is a 400. */
export function paiseOf(input: string): number {
  const v = parseDecimal(input, 2)
  if (v === null || v <= 0) throw new ProjectsError(400, 'bad_amount', 'That is not an amount.')
  return v
}
export const hours = (minutes: number) => (minutes / 60).toFixed(2)

/** An optional enum filter from a query string, where '' means absent. */
export const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values).optional().or(z.literal('').transform(() => undefined))

export async function staffMember(tx: Tx, userId: string) {
  const [u] = await tx.select({ id: users.id, name: users.name, email: users.email, role: users.role, erasedAt: users.erasedAt }).from(users).where(eq(users.id, userId))
  if (!u || u.erasedAt) throw new ProjectsError(404, 'no_such_person', 'No such person in this institution.')
  if (!STAFF.includes(u.role)) throw new ProjectsError(400, 'not_staff', 'Choose a member of staff.')
  return u
}

export type Need = 'read' | 'manage' | 'approve'

/** The project, if this actor may see it; 404 otherwise, 403 for a right they lack. */
export async function projectFor(tx: Tx, actor: Actor, projectId: string, need: Need, lock = false) {
  const query = tx.select().from(projects).where(eq(projects.id, projectId))
  const [project] = lock ? await query.for('update') : await query
  const notFound = new ProjectsError(404, 'no_such_project', 'No such project.')
  if (!project) throw notFound
  const manager = project.managerId === actor.id
  const office = OFFICE.includes(actor.role)
  const member = manager || office ||
    (await tx.select({ id: members.id }).from(members).where(and(eq(members.projectId, project.id), eq(members.userId, actor.id)))).length > 0
  if (!member) throw notFound
  const canManage = manager || office
  const canApprove = manager || ADMIN.includes(actor.role)
  if (need === 'manage' && !canManage) throw new ProjectsError(403, 'not_manager', 'Only the project manager or the accounts office can do this.')
  if (need === 'approve' && !canApprove) throw new ProjectsError(403, 'not_approver', 'Only the project manager or an administrator approves time.')
  return { project, canManage, canApprove }
}

/** Is this person on the project (a member or its manager)? */
export async function onProject(tx: Tx, project: { id: string; managerId: string }, userId: string) {
  if (project.managerId === userId) return true
  return (await tx.select({ id: members.id }).from(members).where(and(eq(members.projectId, project.id), eq(members.userId, userId)))).length > 0
}

export const log = (tx: Tx, actor: Actor, action: string, entity: string, entityId: string, reason: string, detail?: Record<string, unknown>) =>
  audit(tx, { institutionId: actor.institutionId!, actorId: actor.id, actorEmail: actor.email ?? null, moduleId: 'projects', action, entity, entityId, reason, detail })
