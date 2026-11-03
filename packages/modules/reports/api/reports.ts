import * as z from 'zod'
import { eq, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { withTenantRead } from '@campusos/db/replica'
import { ticked, type Role } from '@campusos/module-framework'
import { datasetById, datasets, type Dataset } from './catalog'
import { checkRoles, compile, specSchema } from './compile'
import { ADMIN, STAFF, isAdmin, loadReport, log, mustView, tenant, type Actor } from './core'
import { badReport, datasetUnavailable, reportArchived } from './errors'
import { DASHBOARD_MAX } from './limits'
import { istToday, nextRunAt, type Schedule } from './schedule'
import { reports } from '../schema'
import type { Row } from './runs'

const list = (v: unknown) => (v === undefined || v === '' || v === null ? [] : Array.isArray(v) ? v : [v])

export const reportSchema = z.object({
  name: z.string().trim().min(1).max(120),
  dataset: z.string().min(1).max(63),
  spec: specSchema,
  viewerRoles: z.preprocess(list, z.array(z.enum(STAFF as unknown as [Role, ...Role[]])).max(10)).default([]),
  onDashboard: z.preprocess(ticked, z.boolean()).default(false),
  schedule: z.enum(['none', 'daily', 'weekly', 'monthly']).default('none'),
})
export const updateSchema = reportSchema.extend({ id: z.uuid() })
export const idSchema = z.object({ id: z.uuid() })

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input)
  if (!r.success) throw badReport(r.error.issues[0]?.message ?? 'The report is not valid.')
  return r.data
}

export async function listDatasets(actor: Actor): Promise<Dataset[]> {
  const institutionId = tenant(actor, ADMIN)
  return withTenantRead(institutionId, (tx) => datasets(tx, institutionId))
}

/** The checks a definition must pass before it is saved: its dataset is available here, it compiles, its viewers may see the dataset. */
async function check(institutionId: string, data: z.infer<typeof reportSchema>): Promise<void> {
  const ds = datasetById(await withTenantRead(institutionId, (tx) => datasets(tx, institutionId)), data.dataset)
  if (!ds) throw datasetUnavailable()
  compile(data.spec, ds, istToday())
  checkRoles(data.viewerRoles, ds)
}

export async function createReport(actor: Actor, input: unknown): Promise<{ id: string }> {
  const institutionId = tenant(actor, ADMIN)
  const data = parse(reportSchema, input)
  await check(institutionId, data)
  return withTenant(institutionId, async (tx) => {
    const [r] = await tx.insert(reports).values({
      institutionId, name: data.name, dataset: data.dataset, spec: data.spec, viewerRoles: data.viewerRoles,
      onDashboard: data.onDashboard, schedule: data.schedule, nextRunAt: nextRunAt(data.schedule as Schedule, new Date()), createdBy: actor.id,
    }).returning({ id: reports.id })
    await log(tx, actor, 'report.created', r!.id, { name: data.name, dataset: data.dataset })
    return { id: r!.id }
  })
}

export async function updateReport(actor: Actor, input: unknown): Promise<{ id: string }> {
  const institutionId = tenant(actor, ADMIN)
  const data = parse(updateSchema, input)
  await check(institutionId, data)
  return withTenant(institutionId, async (tx) => {
    const current = await loadReport(tx, institutionId, data.id, true)
    if (current.archivedAt) throw reportArchived()
    await tx.update(reports).set({
      name: data.name, dataset: data.dataset, spec: data.spec, viewerRoles: data.viewerRoles, onDashboard: data.onDashboard,
      schedule: data.schedule, nextRunAt: nextRunAt(data.schedule as Schedule, new Date()), updatedAt: new Date(),
    }).where(eq(reports.id, data.id))
    await log(tx, actor, 'report.updated', data.id, { name: data.name, dataset: data.dataset })
    return { id: data.id }
  })
}

export async function archiveReport(actor: Actor, input: unknown): Promise<{ id: string }> {
  const institutionId = tenant(actor, ADMIN)
  const { id } = parse(idSchema, input)
  return withTenant(institutionId, async (tx) => {
    const current = await loadReport(tx, institutionId, id, true)
    if (current.archivedAt) throw reportArchived()
    await tx.update(reports).set({ archivedAt: new Date(), schedule: 'none', nextRunAt: null, updatedAt: new Date() }).where(eq(reports.id, id))
    await log(tx, actor, 'report.archived', id, { name: current.name, dataset: current.dataset })
    return { id }
  })
}

export interface ReportRow {
  id: string
  name: string
  dataset: string
  schedule: string
  nextRunAt: Date | null
  onDashboard: boolean
  lastRunAt: Date | null
  lastStatus: string | null
  lastRowCount: number | null
}

export async function listReports(actor: Actor): Promise<ReportRow[]> {
  const institutionId = tenant(actor, STAFF)
  const admin = isAdmin(actor)
  return withTenant(institutionId, async (tx) => {
    const res = await tx.execute(sql`
      select r.id, r.name, r.dataset, r.schedule, r.next_run_at, r.on_dashboard, l.started_at, l.status, l.row_count
        from reports_reports r
        left join lateral (select started_at, status, row_count from reports_runs where report_id = r.id order by started_at desc, id desc limit 1) l on true
       where r.archived_at is null and (${admin} or ${actor.role} = any(r.viewer_roles))
       order by r.name, r.id`)
    return (res.rows as Record<string, unknown>[]).map((x) => ({
      id: x.id as string, name: x.name as string, dataset: x.dataset as string, schedule: x.schedule as string,
      nextRunAt: x.next_run_at ? new Date(x.next_run_at as string) : null, onDashboard: x.on_dashboard as boolean,
      lastRunAt: x.started_at ? new Date(x.started_at as string) : null, lastStatus: (x.status as string | null) ?? null,
      lastRowCount: x.row_count === null ? null : Number(x.row_count),
    }))
  })
}

export async function reportDetail(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, STAFF)
  const { id } = parse(idSchema, input)
  const { report, run } = await withTenant(institutionId, async (tx) => {
    const report = await loadReport(tx, institutionId, id)
    mustView(actor, report)
    const res = await tx.execute(sql`
      select id, trigger, started_at, status, error_code, row_count, truncated, on_replica, data_as_of, columns, rows
        from reports_runs where report_id = ${id} order by started_at desc, id desc limit 1`)
    return { report, run: (res.rows[0] as Record<string, unknown> | undefined) ?? null }
  })
  const ds = datasetById(await withTenantRead(institutionId, (tx) => datasets(tx, institutionId)), report.dataset)
  return { report, datasetLabel: ds?.label ?? null, run }
}

export interface DashboardItem {
  id: string
  name: string
  chart: string
  columns: { key: string; label: string; kind: string }[]
  rows: Row[]
  runAt: Date | null
}

/** The reader's dashboard: each shared report marked for it, from its latest good run (decision 445). */
export async function dashboard(actor: Actor): Promise<DashboardItem[]> {
  const institutionId = tenant(actor, STAFF)
  const admin = isAdmin(actor)
  return withTenant(institutionId, async (tx) => {
    const res = await tx.execute(sql`
      select r.id, r.name, r.spec->>'chart' as chart, l.started_at, l.columns, l.rows
        from reports_reports r
        left join lateral (select started_at, columns, rows from reports_runs where report_id = r.id and status = 'ok' order by started_at desc, id desc limit 1) l on true
       where r.archived_at is null and r.on_dashboard and (${admin} or ${actor.role} = any(r.viewer_roles))
       order by r.updated_at desc, r.id limit ${DASHBOARD_MAX}`)
    return (res.rows as Record<string, unknown>[]).map((x) => ({
      id: x.id as string, name: x.name as string, chart: (x.chart as string | null) ?? 'none',
      columns: (x.columns as DashboardItem['columns'] | null) ?? [], rows: (x.rows as Row[] | null) ?? [],
      runAt: x.started_at ? new Date(x.started_at as string) : null,
    }))
  })
}

