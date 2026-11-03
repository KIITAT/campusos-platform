import { and, asc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm'
import { users } from '@campusos/db'
import { notify } from '@campusos/module-notices/api'
import type { Role } from '@campusos/module-framework'
import type { Actor, Tx } from './core'
import { DUE_PER_RUN, MAX_RECIPIENTS } from './limits'
import { runInto } from './runs'
import { nextRunAt, type Schedule } from './schedule'
import { reports, type Report } from '../schema'

/** Who hears that a scheduled run finished: the report's viewer roles and its creator, once each (decision 445). */
async function recipients(tx: Tx, institutionId: string, report: Report): Promise<string[]> {
  const viewers = report.viewerRoles.length === 0
    ? []
    : await tx.select({ id: users.id }).from(users).where(and(eq(users.institutionId, institutionId), inArray(users.role, report.viewerRoles as Role[]), isNull(users.erasedAt)))
  return [...new Set([report.createdBy, ...viewers.map((v) => v.id)])].slice(0, MAX_RECIPIENTS)
}

/** Run the reports that are due, at most three, skipping any another worker holds. */
export async function runDue(actor: Actor, tx: Tx): Promise<{ ran: number; failed: number }> {
  const institutionId = actor.institutionId!
  const due = await tx.select().from(reports)
    .where(and(isNull(reports.archivedAt), ne(reports.schedule, 'none'), lte(reports.nextRunAt, sql`now()`)))
    .orderBy(asc(reports.nextRunAt), asc(reports.id))
    .limit(DUE_PER_RUN)
    .for('update', { skipLocked: true })
  let ran = 0
  let failed = 0
  for (const report of due) {
    const started = new Date()
    const result = await runInto(tx, institutionId, report, 'schedule', null)
    await tx.update(reports).set({ nextRunAt: nextRunAt(report.schedule as Schedule, started) }).where(eq(reports.id, report.id))
    if (result.status === 'failed') { failed += 1; continue }
    ran += 1
    await notify(tx, institutionId, {
      userIds: await recipients(tx, institutionId, report),
      moduleId: 'reports',
      title: 'Report ready: ' + report.name.slice(0, 80),
      body: `The scheduled run finished with ${result.rowCount} rows.`,
      link: '/m/reports/report?id=' + report.id,
    })
  }
  return { ran, failed }
}
