import * as z from 'zod'
import { and, asc, eq, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import {
  cursorColumn, finishPage, keyset, orderKeys, readPage, searchAny, ticked,
  type Page, type PageRequest, type SortSpec,
} from '@campusos/module-framework'
import { localToday } from '@campusos/module-finance/api'
import { milestones, stages, tasks } from '../schema'
import {
  ProjectsError, STAFF, log, named, onProject, optional, optionalDate, optionalId, projectFor, staffMember, tenant, text,
  type Actor, type Tx,
} from './core'

export const stageSchema = z.object({
  projectId: z.uuid(),
  name: text(1, 60),
  seq: z.coerce.number().int().min(1).max(999),
  closes: z.preprocess(ticked, z.boolean()).default(false),
})
export const milestoneSchema = z.object({ projectId: z.uuid(), name: text(2, 120), dueOn: optionalDate })
export const taskSchema = z.object({
  projectId: z.uuid(),
  title: text(2, 200),
  description: optional(4000),
  stageId: optionalId,
  assigneeId: optional(64),
  deadline: optionalDate,
  milestoneId: optionalId,
})
export const taskUpdateSchema = taskSchema.omit({ projectId: true }).extend({ taskId: z.uuid(), stageId: z.uuid() })

export const reachSchema = z.object({ milestoneId: z.uuid() })

export async function addStage(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = stageSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const { project } = await projectFor(tx, actor, data.projectId, 'manage')
    const [row] = await tx.insert(stages).values({ institutionId, projectId: project.id, name: data.name, seq: data.seq, closes: data.closes }).returning({ id: stages.id })
    await log(tx, actor, 'stage.created', 'projects_stages', row!.id, 'Stage added', { projectId: project.id })
    return { id: row!.id, notice: 'Stage added.' }
  }))
}

export async function addMilestone(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = milestoneSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const { project } = await projectFor(tx, actor, data.projectId, 'manage')
    const [row] = await tx.insert(milestones).values({ institutionId, projectId: project.id, name: data.name, dueOn: data.dueOn ?? null }).returning({ id: milestones.id })
    await log(tx, actor, 'milestone.created', 'projects_milestones', row!.id, 'Milestone added', { projectId: project.id })
    return { id: row!.id, notice: 'Milestone added.' }
  }))
}

export async function reachMilestone(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = reachSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const [milestone] = await tx.select().from(milestones).where(eq(milestones.id, data.milestoneId)).for('update')
    if (!milestone) throw new ProjectsError(404, 'no_such_milestone', 'No such milestone on this project.')
    await projectFor(tx, actor, milestone.projectId, 'manage')
    if (milestone.reachedOn) throw new ProjectsError(409, 'already_reached', 'That milestone is already reached.')
    await tx.update(milestones).set({ reachedOn: await localToday(tx, institutionId), reachedBy: actor.id }).where(eq(milestones.id, milestone.id))
    await log(tx, actor, 'milestone.reached', 'projects_milestones', milestone.id, 'Milestone reached', { projectId: milestone.projectId })
    return { id: milestone.id, notice: 'Milestone reached.' }
  }))
}

/** The stage, milestone and assignee a task names, each checked to belong to its project. */
async function placed(
  tx: Tx,
  project: { id: string; managerId: string },
  data: { stageId?: string; milestoneId?: string; assigneeId?: string },
) {
  let stageId = data.stageId
  if (stageId) {
    const [s] = await tx.select({ id: stages.id }).from(stages).where(and(eq(stages.id, stageId), eq(stages.projectId, project.id)))
    if (!s) throw new ProjectsError(404, 'no_such_stage', 'No such stage on this project.')
  } else {
    const [first] = await tx.select({ id: stages.id }).from(stages).where(eq(stages.projectId, project.id)).orderBy(asc(stages.seq)).limit(1)
    if (!first) throw new ProjectsError(404, 'no_such_stage', 'No such stage on this project.')
    stageId = first.id
  }
  if (data.milestoneId) {
    const [m] = await tx.select({ id: milestones.id }).from(milestones).where(and(eq(milestones.id, data.milestoneId), eq(milestones.projectId, project.id)))
    if (!m) throw new ProjectsError(404, 'no_such_milestone', 'No such milestone on this project.')
  }
  if (data.assigneeId) {
    await staffMember(tx, data.assigneeId)
    if (!(await onProject(tx, project, data.assigneeId))) throw new ProjectsError(409, 'not_a_member', 'That person is not on this project.')
  }
  return { stageId, milestoneId: data.milestoneId ?? null, assigneeId: data.assigneeId ?? null }
}

export async function createTask(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = taskSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const { project } = await projectFor(tx, actor, data.projectId, 'manage')
    if (project.status === 'closed') throw new ProjectsError(409, 'project_closed', 'That project is closed.')
    const where = await placed(tx, project, data)
    const [row] = await tx.insert(tasks).values({
      institutionId, projectId: project.id, ...where, title: data.title, description: data.description ?? null,
      deadline: data.deadline ?? null, createdBy: actor.id,
    }).returning({ id: tasks.id })
    await log(tx, actor, 'task.created', 'projects_tasks', row!.id, 'Task added',
      { projectId: project.id, stageId: where.stageId, assigneeId: where.assigneeId })
    return { id: row!.id, notice: 'Task added.', next: `/m/projects/task?id=${row!.id}` }
  }))
}

export async function updateTask(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = taskUpdateSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, data.taskId)).for('update')
    if (!task) throw new ProjectsError(404, 'no_such_task', 'No such task on this project.')
    const { project } = await projectFor(tx, actor, task.projectId, 'manage')
    if (project.status === 'closed') throw new ProjectsError(409, 'project_closed', 'That project is closed.')
    const where = await placed(tx, project, data)
    await tx.update(tasks).set({
      ...where, title: data.title, description: data.description ?? null, deadline: data.deadline ?? null, updatedAt: new Date(),
    }).where(eq(tasks.id, task.id))
    await log(tx, actor, 'task.updated', 'projects_tasks', task.id, 'Task changed', { stageId: where.stageId, assigneeId: where.assigneeId })
    return { id: task.id, notice: 'Task updated.' }
  }))
}

export const TASK_SORTS: SortSpec = {
  createdAt: { dir: 'desc', keys: [{ sql: sql`${tasks.createdAt}`, type: 'timestamptz' }, { sql: sql`${tasks.id}`, type: 'uuid' }] },
  title: { dir: 'asc', keys: [{ sql: sql`${tasks.title}`, type: 'text' }, { sql: sql`${tasks.id}`, type: 'uuid' }] },
}
export const taskPage = (req: Request, prefix: string) => readPage(req, prefix, TASK_SORTS, 'createdAt', 50)

export interface TaskRow {
  id: string
  title: string
  stageId: string
  stageName: string
  closes: boolean
  assigneeId: string | null
  assigneeName: string | null
  deadline: string | null
  milestoneName: string | null
  createdAt: string
}

export async function listTasks(
  actor: Actor,
  input: unknown,
  page: PageRequest = taskPage(new Request('https://x/'), ''),
): Promise<Page<TaskRow>> {
  const institutionId = tenant(actor, STAFF)
  const { projectId } = z.object({ projectId: z.uuid() }).parse(input)
  return withTenant(institutionId, async (tx) => {
    await projectFor(tx, actor, projectId, 'read')
    const keys = TASK_SORTS[page.sort]!.keys
    const filter = and(eq(tasks.projectId, projectId), searchAny(page.q, [sql`${tasks.title}`]))
    const rows = await tx
      .select({
        id: tasks.id, title: tasks.title, stageId: tasks.stageId, stageName: stages.name, closes: stages.closes,
        assigneeId: tasks.assigneeId, assigneeName: users.name, deadline: tasks.deadline, milestoneName: milestones.name,
        createdAt: tasks.createdAt, _cursor: cursorColumn(keys),
      })
      .from(tasks)
      .innerJoin(stages, eq(stages.id, tasks.stageId))
      .leftJoin(users, eq(users.id, tasks.assigneeId))
      .leftJoin(milestones, eq(milestones.id, tasks.milestoneId))
      .where(and(filter, keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(tasks).where(filter)
    return finishPage(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), page, counted!.total)
  })
}

/** One task for its page; not a route. */
export async function taskDetail(actor: Actor, taskId: string) {
  const institutionId = tenant(actor, STAFF)
  const id = z.uuid().parse(taskId)
  return withTenant(institutionId, async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, id))
    if (!task) throw new ProjectsError(404, 'no_such_task', 'No such task on this project.')
    const { project, canManage, canApprove } = await projectFor(tx, actor, task.projectId, 'read')
    const [row] = await tx
      .select({
        id: tasks.id, title: tasks.title, description: tasks.description, stageId: tasks.stageId, stageName: stages.name, closes: stages.closes,
        assigneeId: tasks.assigneeId, assigneeName: users.name, deadline: tasks.deadline, milestoneId: tasks.milestoneId,
        milestoneName: milestones.name, createdAt: tasks.createdAt,
      })
      .from(tasks)
      .innerJoin(stages, eq(stages.id, tasks.stageId))
      .leftJoin(users, eq(users.id, tasks.assigneeId))
      .leftJoin(milestones, eq(milestones.id, tasks.milestoneId))
      .where(eq(tasks.id, id))
    return {
      task: { ...row!, createdAt: row!.createdAt.toISOString() },
      project: { id: project.id, code: project.code, name: project.name, status: project.status },
      canManage,
      canApprove,
    }
  })
}
