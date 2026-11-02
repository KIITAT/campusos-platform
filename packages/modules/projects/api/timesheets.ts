import * as z from 'zod'
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import {
  cursorColumn, finishPage, keyset, orderKeys, readPage, searchAny,
  type Page, type PageRequest, type SortSpec,
} from '@campusos/module-framework'
import { localToday } from '@campusos/module-finance/api'
import { projects, tasks, timesheets } from '../schema'
import {
  ADMIN, OFFICE, ProjectsError, STAFF, hours, log, named, onProject, optional, optionalEnum, optionalId, projectFor, staffMember,
  tenant, text, type Actor, type Tx,
} from './core'

const logSchema = z.object({
  taskId: z.uuid(), userId: optional(64), workDate: z.iso.date(), minutes: z.coerce.number().int(), description: text(2, 500),
})
const editSchema = z.object({ lineId: z.uuid(), workDate: z.iso.date(), minutes: z.coerce.number().int(), description: text(2, 500) })
const lineSchema = z.object({ lineId: z.uuid() })
const decideSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200), decision: z.enum(['approved', 'rejected']), note: optional(300) })
const reopenSchema = z.object({ lineId: z.uuid(), reason: text(5, 300) })
const timesheetQuery = z.object({
  projectId: optionalId, taskId: optionalId, userId: optional(64),
  status: optionalEnum(['submitted', 'approved', 'rejected']), queue: optionalEnum(['approvals', 'reopenable']),
})

export const SHEET_SORTS: SortSpec = {
  workDate: {
    dir: 'desc',
    keys: [
      { sql: sql`${timesheets.workDate}`, type: 'date' },
      { sql: sql`${timesheets.createdAt}`, type: 'timestamptz' },
      { sql: sql`${timesheets.id}`, type: 'uuid' },
    ],
  },
}
export const sheetPage = (req: Request, prefix: string) => readPage(req, prefix, SHEET_SORTS, 'workDate', 50)

type ProjectRecord = Awaited<ReturnType<typeof projectFor>>['project']

async function checkDay(tx: Tx, institutionId: string, project: ProjectRecord, workDate: string, minutes: number) {
  if (minutes < 15 || minutes > 1440 || minutes % 15 !== 0) {
    throw new ProjectsError(400, 'bad_minutes', 'Minutes are 15 to 1440, in steps of 15.')
  }
  if (workDate > (await localToday(tx, institutionId))) throw new ProjectsError(400, 'future_date', 'Time is logged for today or earlier.')
  if (workDate < project.startsOn || (project.endsOn && workDate > project.endsOn)) {
    throw new ProjectsError(400, 'outside_project', "That day is outside the project's dates.")
  }
  if (project.status === 'closed') throw new ProjectsError(409, 'project_closed', 'That project is closed.')
}

export async function logTime(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = logSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const [task] = await tx.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, data.taskId))
    if (!task) throw new ProjectsError(404, 'no_such_task', 'No such task on this project.')
    const { project, canApprove } = await projectFor(tx, actor, task.projectId, 'read')
    const who = data.userId ?? actor.id
    if (who !== actor.id && !canApprove) throw new ProjectsError(403, 'not_for_others', 'You log only your own time.')
    await staffMember(tx, who)
    if (!(await onProject(tx, project, who))) throw new ProjectsError(409, 'not_a_member', 'That person is not on this project.')
    await checkDay(tx, institutionId, project, data.workDate, data.minutes)
    const [row] = await tx.insert(timesheets).values({
      institutionId, projectId: project.id, taskId: task.id, userId: who, workDate: data.workDate, minutes: data.minutes,
      description: data.description, enteredBy: actor.id,
    }).returning({ id: timesheets.id, status: timesheets.status, userId: timesheets.userId, enteredBy: timesheets.enteredBy })
    await log(tx, actor, 'timesheet.logged', 'projects_timesheets', row!.id, 'Time logged',
      { projectId: project.id, taskId: task.id, userId: who, workDate: data.workDate, minutes: data.minutes })
    return { ...row!, notice: `${hours(data.minutes)} h logged.` }
  }))
}

/** A line this actor may change: theirs, entered by them, or one they approve; not yet approved. */
async function ownLine(tx: Tx, actor: Actor, lineId: string) {
  const [line] = await tx.select().from(timesheets).where(eq(timesheets.id, lineId)).for('update')
  const missing = new ProjectsError(404, 'no_such_line', 'No such timesheet line.')
  if (!line) throw missing
  const { project, canApprove } = await projectFor(tx, actor, line.projectId, 'read')
  if (!(line.userId === actor.id || line.enteredBy === actor.id || canApprove)) throw missing
  if (line.status === 'approved') throw new ProjectsError(409, 'not_editable', 'Only time not yet approved can be changed.')
  return { line, project }
}

export async function updateTime(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = editSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const { line, project } = await ownLine(tx, actor, data.lineId)
    await checkDay(tx, institutionId, project, data.workDate, data.minutes)
    await tx.update(timesheets).set({
      workDate: data.workDate, minutes: data.minutes, description: data.description, status: 'submitted',
      decidedBy: null, decidedAt: null, decisionNote: null, updatedAt: new Date(),
    }).where(eq(timesheets.id, line.id))
    await log(tx, actor, 'timesheet.updated', 'projects_timesheets', line.id, 'Time changed', { workDate: data.workDate, minutes: data.minutes })
    return { id: line.id, notice: 'Time changed.' }
  }))
}

export async function deleteTime(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = lineSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const { line } = await ownLine(tx, actor, data.lineId)
    await tx.delete(timesheets).where(eq(timesheets.id, line.id))
    await log(tx, actor, 'timesheet.deleted', 'projects_timesheets', line.id, 'Time deleted',
      { projectId: line.projectId, workDate: line.workDate, minutes: line.minutes })
    return { id: line.id, notice: 'Time deleted.' }
  }))
}

export async function decideTime(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = decideSchema.parse(input)
  if (data.decision === 'rejected' && (data.note ?? '').length < 5) throw new ProjectsError(400, 'note_required', 'Say why the time is rejected.')
  const ids = [...new Set(data.ids)]
  return withTenant(institutionId, (tx) => named(async () => {
    const lines = await tx.select().from(timesheets).where(inArray(timesheets.id, ids)).orderBy(timesheets.id).for('update')
    if (lines.length < ids.length) throw new ProjectsError(404, 'no_such_line', 'No such timesheet line.')
    const checked = new Set<string>()
    for (const line of lines) {
      if (!checked.has(line.projectId)) {
        await projectFor(tx, actor, line.projectId, 'approve')
        checked.add(line.projectId)
      }
      if (line.userId === actor.id) throw new ProjectsError(403, 'own_timesheet', 'Nobody approves their own time.')
      if (line.status !== 'submitted') throw new ProjectsError(409, 'not_pending', 'Only time waiting for approval can be decided.')
    }
    const rejected = data.decision === 'rejected'
    await tx.update(timesheets).set({
      status: data.decision, decidedBy: actor.id, decidedAt: new Date(), decisionNote: rejected ? data.note! : null, updatedAt: new Date(),
    }).where(inArray(timesheets.id, ids))
    for (const line of lines) {
      await log(tx, actor, rejected ? 'timesheet.rejected' : 'timesheet.approved', 'projects_timesheets', line.id,
        rejected ? 'Time rejected' : 'Time approved', { projectId: line.projectId, userId: line.userId, minutes: line.minutes })
    }
    return { decided: lines.length, notice: `${lines.length} line(s) ${data.decision}.` }
  }))
}

export async function reopenTime(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const data = reopenSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const [line] = await tx.select().from(timesheets).where(eq(timesheets.id, data.lineId)).for('update')
    if (!line) throw new ProjectsError(404, 'no_such_line', 'No such timesheet line.')
    await projectFor(tx, actor, line.projectId, 'approve')
    if (line.status !== 'approved') throw new ProjectsError(409, 'not_approved', 'Only approved time is reopened.')
    if (line.billingId || line.costingId) throw new ProjectsError(409, 'settled', 'That time is billed or costed; correct it in the books.')
    await tx.update(timesheets).set({
      status: 'submitted', decidedBy: null, decidedAt: null, decisionNote: null, updatedAt: new Date(),
    }).where(eq(timesheets.id, line.id))
    await log(tx, actor, 'timesheet.reopened', 'projects_timesheets', line.id, data.reason, { projectId: line.projectId })
    return { id: line.id, notice: 'Time reopened for correction.' }
  }))
}

export interface SheetRow {
  id: string
  projectId: string
  projectCode: string
  taskId: string
  taskTitle: string
  userId: string
  person: string | null
  workDate: string
  minutes: number
  hours: string
  description: string
  status: string
  decisionNote: string | null
  billed: boolean
  costed: boolean
}

export async function listTimesheets(
  actor: Actor,
  input: unknown = {},
  page: PageRequest = sheetPage(new Request('https://x/'), ''),
): Promise<Page<SheetRow>> {
  const institutionId = tenant(actor, STAFF)
  const data = timesheetQuery.parse(input)
  return withTenant(institutionId, async (tx) => {
    const keys = SHEET_SORTS[page.sort]!.keys
    const managed = tx.select({ id: projects.id }).from(projects).where(eq(projects.managerId, actor.id))
    const admin = ADMIN.includes(actor.role)
    const office = OFFICE.includes(actor.role)
    const filter = and(
      office ? undefined : or(eq(timesheets.userId, actor.id), eq(timesheets.enteredBy, actor.id), inArray(timesheets.projectId, managed)),
      data.projectId ? eq(timesheets.projectId, data.projectId) : undefined,
      data.taskId ? eq(timesheets.taskId, data.taskId) : undefined,
      data.userId ? eq(timesheets.userId, data.userId) : undefined,
      data.status ? eq(timesheets.status, data.status) : undefined,
      data.queue === 'approvals'
        ? and(eq(timesheets.status, 'submitted'), ne(timesheets.userId, actor.id), admin ? undefined : inArray(timesheets.projectId, managed))
        : undefined,
      data.queue === 'reopenable'
        ? and(eq(timesheets.status, 'approved'), isNull(timesheets.billingId), isNull(timesheets.costingId), admin ? undefined : inArray(timesheets.projectId, managed))
        : undefined,
      searchAny(page.q, [sql`${timesheets.description}`]),
    )
    const rows = await tx
      .select({
        id: timesheets.id, projectId: timesheets.projectId, projectCode: projects.code, taskId: timesheets.taskId, taskTitle: tasks.title,
        userId: timesheets.userId, person: users.name, workDate: timesheets.workDate, minutes: timesheets.minutes,
        description: timesheets.description, status: timesheets.status, decisionNote: timesheets.decisionNote,
        billed: sql<boolean>`${timesheets.billingId} is not null`, costed: sql<boolean>`${timesheets.costingId} is not null`, _cursor: cursorColumn(keys),
      })
      .from(timesheets)
      .innerJoin(projects, eq(projects.id, timesheets.projectId))
      .innerJoin(tasks, eq(tasks.id, timesheets.taskId))
      .innerJoin(users, eq(users.id, timesheets.userId))
      .where(and(filter, keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(timesheets).where(filter)
    return finishPage(rows.map((r) => ({ ...r, hours: hours(r.minutes) })), page, counted!.total)
  })
}
