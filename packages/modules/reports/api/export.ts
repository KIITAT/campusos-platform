import * as z from 'zod'
import { eq } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { withTenantRead, type ReadTx } from '@campusos/db/replica'
import { csvCell } from '@campusos/module-framework'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { datasetById, datasets, type Dataset } from './catalog'
import { compile, specSchema, type OutColumn, type Spec } from './compile'
import { ADMIN, STAFF, loadReport, log, mustView, tenant, type Actor } from './core'
import { datasetUnavailable, exportTooLarge, reportArchived, reportStale, runNotFound } from './errors'
import { PARQUET_MAX_ROWS } from './limits'
import { istToday } from './schedule'
import { execRows, type Row } from './runs'
import { runs } from '../schema'

/** A cell a spreadsheet would run as a formula is made text (decision 498). */
export const safeCell = (s: string) => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s)

/** Paise as rupees with two decimals, by integer arithmetic. */
export function rupees(p: number): string {
  const a = Math.abs(p)
  return (p < 0 ? '-' : '') + Math.trunc(a / 100) + '.' + String(a % 100).padStart(2, '0')
}

const cell = (v: Row[string], kind: OutColumn['kind']): string => {
  if (v === null || v === undefined) return ''
  if (kind === 'money') return rupees(Number(v))
  if (kind === 'bool') return v ? 'yes' : 'no'
  return safeCell(String(v))
}

/** CSV of a stored run, for anyone who may view its report. */
export async function runCsv(actor: Actor, input: unknown): Promise<Response> {
  const institutionId = tenant(actor, STAFF)
  const id = z.uuid().safeParse((input as { id?: unknown })?.id)
  if (!id.success) throw runNotFound()
  const { run } = await withTenant(institutionId, async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, id.data))
    if (!run) throw runNotFound()
    mustView(actor, await loadReport(tx, institutionId, run.reportId))
    return { run }
  })
  const columns = run.columns as OutColumn[]
  const lines = [columns.map((c) => csvCell(c.label)).join(',')]
  for (const row of run.rows as Row[]) lines.push(columns.map((c) => csvCell(cell(row[c.key] ?? null, c.kind))).join(','))
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="report-${istToday(run.startedAt)}.csv"`,
    },
  })
}

/** The report's rows with no page limit but a cap; more than the cap is refused (decision 498). */
export async function parquetRows(tx: ReadTx, ds: Dataset, spec: Spec, today: string, cap: number) {
  const { query, columns } = compile(spec, ds, today, { cap })
  const rows = await execRows(tx, query, columns)
  if (rows.length > cap) throw exportTooLarge()
  return { columns, rows }
}

const PARQUET_TYPE = { text: 'STRING', date: 'STRING', money: 'INT64', number: 'DOUBLE', bool: 'BOOLEAN' } as const

/** Parquet of a report, run fresh on the report pool; administrators only, audited. */
export async function exportParquet(actor: Actor, input: unknown): Promise<Response> {
  const institutionId = tenant(actor, ADMIN)
  const id = z.uuid().safeParse((input as { id?: unknown })?.id)
  if (!id.success) throw runNotFound()
  const report = await withTenant(institutionId, (tx) => loadReport(tx, institutionId, id.data))
  if (report.archivedAt) throw reportArchived()
  const spec = specSchema.safeParse(report.spec)
  if (!spec.success) throw reportStale(spec.error.issues[0]?.message ?? 'The report definition is not valid.')
  const today = istToday()
  const { columns, rows } = await withTenantRead(institutionId, async (tx) => {
    const ds = datasetById(await datasets(tx, institutionId), report.dataset)
    if (!ds) throw datasetUnavailable()
    return parquetRows(tx, ds, spec.data, today, PARQUET_MAX_ROWS)
  })
  const file = parquetWriteBuffer({
    columnData: columns.map((c) => ({
      name: c.key,
      type: PARQUET_TYPE[c.kind],
      data: rows.map((r) => {
        const v = r[c.key] ?? null
        return v === null ? null : c.kind === 'money' ? BigInt(v as number) : v
      }),
    })),
  })
  await withTenant(institutionId, (tx) => log(tx, actor, 'report.exported', report.id, { dataset: report.dataset, rows: rows.length, format: 'parquet' }))
  return new Response(file, {
    headers: {
      'content-type': 'application/vnd.apache.parquet',
      'content-disposition': `attachment; filename="${report.dataset}-${today}.parquet"`,
    },
  })
}
