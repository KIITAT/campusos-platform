import * as z from 'zod'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import {
  cursorColumn, finishPage, keyset, orderKeys, readPage, searchAny, ticked,
  type Page, type PageRequest, type SortSpec,
} from '@campusos/module-framework'
import { partyWithin } from '@campusos/module-finance/api'
import { costCenters, funds, taxTemplates } from '@campusos/module-finance/schema'
import { members, milestones, projects, stages } from '../schema'
import {
  OFFICE, ProjectsError, STAFF, log, named, optional, optionalDate, optionalEnum, optionalId, paiseOf, projectFor, staffMember,
  tenant, text, type Actor, type Tx,
} from './core'

export const projectSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,20}$/),
  name: text(2, 200),
  description: optional(4000),
  managerId: text(1, 64),
  costCenter: text(1, 40),
  startsOn: z.iso.date(),
  endsOn: optionalDate,
  billable: z.preprocess(ticked, z.boolean()).default(false),
  partyId: optionalId,
  billingRate: optional(24),
  taxTemplateId: optionalId,
  fundId: optionalId,
})
export const projectUpdateSchema = projectSchema.omit({ code: true, costCenter: true, startsOn: true }).extend({ projectId: z.uuid() })
export const statusSchema = z.object({ projectId: z.uuid(), status: z.enum(['active', 'closed']) })
export const memberSchema = z.object({ projectId: z.uuid(), userId: text(1, 64) })
const listSchema = z.object({ status: optionalEnum(['active', 'closed']) })

export const PROJECT_SORTS: SortSpec = {
  code: { dir: 'asc', keys: [{ sql: sql`${projects.code}`, type: 'text' }, { sql: sql`${projects.id}`, type: 'uuid' }] },
  name: { dir: 'asc', keys: [{ sql: sql`${projects.name}`, type: 'text' }, { sql: sql`${projects.id}`, type: 'uuid' }] },
}
export const projectPage = (req: Request, prefix: string) => readPage(req, prefix, PROJECT_SORTS, 'code', 50)

/** The finance references a project names, checked under the tenant's row level security. */
async function money(tx: Tx, data: { billable: boolean; partyId?: string; fundId?: string; taxTemplateId?: string; billingRate?: string }) {
  if (data.partyId) {
    const party = await partyWithin(tx, data.partyId)
    if (!party.isCustomer) throw new ProjectsError(400, 'not_customer', 'That party is not a customer.')
    if (party.archivedAt) throw new ProjectsError(409, 'party_archived', 'That party is archived.')
  }
  if (data.fundId) {
    const [fund] = await tx.select({ id: funds.id }).from(funds).where(eq(funds.id, data.fundId))
    if (!fund) throw new ProjectsError(404, 'no_such_fund', 'No such fund.')
  }
  if (data.taxTemplateId) {
    const [template] = await tx.select({ id: taxTemplates.id }).from(taxTemplates).where(eq(taxTemplates.id, data.taxTemplateId))
    if (!template) throw new ProjectsError(404, 'no_such_tax_template', 'No such tax template.')
  }
  const billingRatePaise = data.billingRate ? paiseOf(data.billingRate) : null
  if (data.billable && (!data.partyId || billingRatePaise === null)) {
    throw new ProjectsError(400, 'billing_needs_customer_and_rate', 'A billable project needs a customer and an hourly rate.')
  }
  return { partyId: data.partyId ?? null, fundId: data.fundId ?? null, taxTemplateId: data.taxTemplateId ?? null, billingRatePaise }
}

export async function createProject(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, OFFICE)
  const data = projectSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    await staffMember(tx, data.managerId)
    const [centre] = await tx.select({ archivedAt: costCenters.archivedAt }).from(costCenters).where(eq(costCenters.code, data.costCenter))
    if (!centre) throw new ProjectsError(404, 'no_such_cost_center', 'No such cost centre in the books.')
    if (centre.archivedAt) throw new ProjectsError(409, 'cost_center_archived', 'That cost centre is closed in the books.')
    const ref = await money(tx, data)
    const [row] = await tx.insert(projects).values({
      institutionId, code: data.code, name: data.name, description: data.description ?? null, managerId: data.managerId,
      costCenter: data.costCenter, billable: data.billable, ...ref, startsOn: data.startsOn, endsOn: data.endsOn ?? null, createdBy: actor.id,
    }).returning({ id: projects.id })
    const id = row!.id
    await tx.insert(stages).values([
      { institutionId, projectId: id, name: 'To do', seq: 1 },
      { institutionId, projectId: id, name: 'In progress', seq: 2 },
      { institutionId, projectId: id, name: 'Done', seq: 3, closes: true },
    ])
    await log(tx, actor, 'project.created', 'projects_projects', id, 'Project created',
      { code: data.code, costCenter: data.costCenter, managerId: data.managerId, billable: data.billable })
    return { id, notice: `Project ${data.code} created.`, next: `/m/projects/project?id=${id}` }
  }))
}

export async function updateProject(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, OFFICE)
  const data = projectUpdateSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const { project } = await projectFor(tx, actor, data.projectId, 'manage', true)
    await staffMember(tx, data.managerId)
    const ref = await money(tx, data)
    const next = {
      name: data.name, description: data.description ?? null, managerId: data.managerId, billable: data.billable,
      ...ref, endsOn: data.endsOn ?? null,
    }
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== project[k])
    await tx.update(projects).set({ ...next, updatedAt: new Date() }).where(eq(projects.id, project.id))
    await log(tx, actor, 'project.updated', 'projects_projects', project.id, 'Project details changed', { changed })
    return { id: project.id, notice: 'Project updated.' }
  }))
}

export async function setProjectStatus(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, OFFICE)
  const data = statusSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const { project } = await projectFor(tx, actor, data.projectId, 'manage', true)
    if (project.status === data.status) throw new ProjectsError(409, 'no_change', `The project is already ${data.status}.`)
    await tx.update(projects).set({ status: data.status, updatedAt: new Date() }).where(eq(projects.id, project.id))
    await log(tx, actor, 'project.status', 'projects_projects', project.id, `Project ${data.status}`)
    return { id: project.id, notice: data.status === 'closed' ? 'Project closed.' : 'Project reopened.' }
  }))
}

export async function addMember(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = memberSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const { project } = await projectFor(tx, actor, data.projectId, 'manage')
    await staffMember(tx, data.userId)
    if (data.userId === project.managerId) throw new ProjectsError(409, 'already_member', 'That person is already on the project.')
    const [row] = await tx.insert(members).values({ institutionId, projectId: project.id, userId: data.userId, addedBy: actor.id }).returning({ id: members.id })
    await log(tx, actor, 'member.added', 'projects_members', row!.id, 'Member added to a project', { projectId: project.id, userId: data.userId })
    return { id: row!.id, notice: 'Member added.' }
  }))
}

export async function removeMember(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = memberSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const { project } = await projectFor(tx, actor, data.projectId, 'manage')
    const [row] = await tx.delete(members).where(and(eq(members.projectId, project.id), eq(members.userId, data.userId))).returning({ id: members.id })
    if (!row) throw new ProjectsError(409, 'not_a_member', 'That person is not on this project.')
    await log(tx, actor, 'member.removed', 'projects_members', row.id, 'Member removed from a project', { projectId: project.id, userId: data.userId })
    return { id: row.id, notice: 'Member removed.' }
  }))
}

export interface ProjectRow {
  id: string
  code: string
  name: string
  status: string
  startsOn: string
  endsOn: string | null
  costCenter: string
  billable: boolean
  managerName: string | null
}

export async function listProjects(
  actor: Actor,
  input: unknown = {},
  page: PageRequest = projectPage(new Request('https://x/'), ''),
): Promise<Page<ProjectRow>> {
  const institutionId = tenant(actor, STAFF)
  const data = listSchema.parse(input)
  return withTenant(institutionId, async (tx) => {
    const keys = PROJECT_SORTS[page.sort]!.keys
    const scope = OFFICE.includes(actor.role)
      ? undefined
      : or(eq(projects.managerId, actor.id), inArray(projects.id, tx.select({ id: members.projectId }).from(members).where(eq(members.userId, actor.id))))
    const filter = and(
      scope,
      data.status ? eq(projects.status, data.status) : undefined,
      searchAny(page.q, [sql`${projects.code}`, sql`${projects.name}`]),
    )
    const rows = await tx
      .select({
        id: projects.id, code: projects.code, name: projects.name, status: projects.status, startsOn: projects.startsOn,
        endsOn: projects.endsOn, costCenter: projects.costCenter, billable: projects.billable, managerName: users.name,
        _cursor: cursorColumn(keys),
      })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.managerId))
      .where(and(filter, keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(projects).where(filter)
    return finishPage(rows, page, counted!.total)
  })
}

export async function projectDetail(actor: Actor, projectId: string) {
  const institutionId = tenant(actor, STAFF)
  const id = z.uuid().parse(projectId)
  return withTenant(institutionId, async (tx) => {
    const { project, canManage, canApprove } = await projectFor(tx, actor, id, 'read')
    const [manager] = await tx.select({ name: users.name }).from(users).where(eq(users.id, project.managerId))
    const people = await tx
      .select({ userId: members.userId, name: users.name, role: users.role, addedAt: members.addedAt })
      .from(members).innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.projectId, project.id)).orderBy(asc(users.name))
    const stageRows = await tx.select().from(stages).where(eq(stages.projectId, project.id)).orderBy(asc(stages.seq))
    const milestoneRows = await tx.select().from(milestones).where(eq(milestones.projectId, project.id))
      .orderBy(sql`${milestones.dueOn} asc nulls last`, asc(milestones.name))
    return { project, managerName: manager?.name ?? null, members: people, stages: stageRows, milestones: milestoneRows, canManage, canApprove }
  })
}
