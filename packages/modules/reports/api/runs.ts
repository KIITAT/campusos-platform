import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { readFacts, withTenantRead, type ReadTx } from '@campusos/db/replica'
import { datasetById, datasets } from './catalog'
import { compile, specSchema, type OutColumn } from './compile'
import { loadReport, mustView, tenant, STAFF, type Actor, type Tx } from './core'
import { ReportsError, datasetUnavailable, reportArchived, reportStale, reportTimeout } from './errors'
import { KEEP_RUNS } from './limits'
import { istToday } from './schedule'
import { runs, type Report } from '../schema'

export type Row = Record<string, string | number | boolean | null>
export interface RunResult {
  runId: string
  status: 'ok' | 'failed'
  errorCode: string | null
  rowCount: number
  truncated: boolean
  onReplica: boolean
  dataAsOf: Date | null
  columns: OutColumn[]
  rows: Row[]
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

/** Run `query` and key every value by its position, so two unnamed columns of one name (two sums) never collide. */
export async function execRows(tx: ReadTx, query: ReturnType<typeof sql>, columns: OutColumn[]): Promise<Row[]> {
  const names = sql.join(columns.map((_, i) => sql.identifier('c' + i)), sql`, `)
  const res = await tx.execute(sql`select * from (${query}) as q(${names})`)
  return (res.rows as Record<string, unknown>[]).map((raw) => {
    const row: Row = {}
    columns.forEach((c, i) => {
      const v = raw['c' + i]
      row[c.key] = c.kind === 'money' || c.kind === 'number' ? num(v) : (v as string | boolean | null) ?? null
    })
    return row
  })
}

const timedOut = (e: unknown) => (e as { code?: string }).code === '57014' || (e as { cause?: { code?: string } }).cause?.code === '57014'

/** Read the report's data on the report pool, in a read-only transaction (decision 438). Throws ReportsError. */
export async function read(institutionId: string, report: Report, today = istToday()) {
  const spec = specSchema.safeParse(report.spec)
  if (!spec.success) throw reportStale(spec.error.issues[0]?.message ?? 'The report definition is not valid.')
  try {
    return await withTenantRead(institutionId, async (tx) => {
      const ds = datasetById(await datasets(tx, institutionId), report.dataset)
      if (!ds) throw datasetUnavailable()
      let compiled
      try { compiled = compile(spec.data, ds, today) } catch (e) {
        if (e instanceof ReportsError && e.code === 'bad_report') throw reportStale(e.message)
        throw e
      }
      const facts = await readFacts(tx)
      const rows = await execRows(tx, compiled.query, compiled.columns)
      const truncated = rows.length > spec.data.limit
      return { columns: compiled.columns, rows: truncated ? rows.slice(0, spec.data.limit) : rows, truncated, ...facts }
    })
  } catch (e) {
    if (timedOut(e)) throw reportTimeout()
    throw e
  }
}

const FAILED = new Set(['report_stale', 'report_timeout', 'dataset_unavailable'])

/**
 * Run a report and store the result in `tx` (the primary). A manual run that fails throws; a scheduled run
 * stores a failed run and returns it, so the job can go on (decision 444).
 */
export async function runInto(tx: Tx, institutionId: string, report: Report, trigger: 'manual' | 'schedule', runBy: string | null): Promise<RunResult> {
  const startedAt = new Date()
  let out: Awaited<ReturnType<typeof read>> | null = null
  let errorCode: string | null = null
  try { out = await read(institutionId, report) } catch (e) {
    if (trigger === 'manual') throw e
    errorCode = e instanceof ReportsError && FAILED.has(e.code) ? e.code : 'failed'
  }
  const [run] = await tx.insert(runs).values({
    institutionId, reportId: report.id, trigger, runBy, startedAt, finishedAt: new Date(),
    status: out ? 'ok' : 'failed', errorCode,
    rowCount: out?.rows.length ?? 0, truncated: out?.truncated ?? false, onReplica: out?.onReplica ?? false, dataAsOf: out?.dataAsOf ?? null,
    columns: out?.columns ?? [], rows: out?.rows ?? [],
  }).returning({ id: runs.id })
  await tx.execute(sql`
    delete from reports_runs where report_id = ${report.id}
       and id not in (select id from reports_runs where report_id = ${report.id} order by started_at desc, id desc limit ${KEEP_RUNS})`)
  return {
    runId: run!.id, status: out ? 'ok' : 'failed', errorCode, rowCount: out?.rows.length ?? 0, truncated: out?.truncated ?? false,
    onReplica: out?.onReplica ?? false, dataAsOf: out?.dataAsOf ?? null, columns: out?.columns ?? [], rows: out?.rows ?? [],
  }
}

export async function runReport(actor: Actor, input: { id: string }, trigger: 'manual' | 'schedule' = 'manual'): Promise<RunResult> {
  const institutionId = tenant(actor, STAFF)
  return withTenant(institutionId, async (tx) => {
    const report = await loadReport(tx, institutionId, input.id)
    mustView(actor, report)
    if (report.archivedAt) throw reportArchived()
    return runInto(tx, institutionId, report, trigger, actor.id)
  })
}
