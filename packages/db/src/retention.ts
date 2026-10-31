import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { audit, platformAudit } from './audit'
import { chainHeads, readsBatch, tenantBatch } from './audit-chain'
import { authDb } from './client'
import { institutions } from './schema'

/**
 * Retention purges, the offboarding export (AUD-08, NEW-09; P1-08d).
 *
 * The purge runs as the database owner, from the `audit purge` ops command:
 * the worker runs as the application role, which cannot touch `sessions` or
 * `"verificationToken"`. Core's rules are in `campusos_purge_expired` and
 * `campusos_purge_platform` (core 0016); each module adds
 * `dpdp_retention.purge_<module>(inst uuid)` in its own migration.
 *
 * Not exported from the package index, so plugin archives are unchanged.
 */

/** The schedule, in words. The SQL is the rule; this is its label (`audit purge --dry-run` prints it). */
export const RETENTION_SCHEDULE: readonly { table: string; module: string; rule: string }[] = [
  { table: 'sessions', module: 'core', rule: 'expired more than a day ago' },
  { table: 'verificationToken', module: 'core', rule: 'expired more than a day ago' },
  { table: 'background_jobs', module: 'core', rule: 'finished more than 90 days ago' },
  { table: 'notifications', module: 'notices', rule: 'older than 365 days' },
  { table: 'admissions_enquiries', module: 'admissions', rule: 'no accepted application and no activity for 365 days; anonymised' },
  { table: 'hr_job_applicants', module: 'hr', rule: 'not hired, opening closed more than 365 days ago; anonymised' },
  { table: 'attendance_devices', module: 'attendance', rule: 'the person was erased' },
]

export interface PurgeReport {
  dryRun: boolean
  institutions: { id: string; slug: string; purged: Record<string, number> }[]
  platform: Record<string, number>
}

class DryRun extends Error {}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0)

/** Runs `work` in a transaction; on a dry run the transaction is rolled back after `work` returns. */
async function inTransaction<T>(dryRun: boolean, work: (tx: Parameters<Parameters<typeof authDb.transaction>[0]>[0]) => Promise<T>): Promise<T> {
  let out!: T
  try {
    await authDb.transaction(async (tx) => {
      out = await work(tx)
      if (dryRun) throw new DryRun()
    })
  } catch (e) {
    if (!(e instanceof DryRun)) throw e
  }
  return out
}

export async function purgeExpired(opts: { dryRun?: boolean; institutionId?: string } = {}): Promise<PurgeReport> {
  const dryRun = opts.dryRun ?? false
  const all = await authDb
    .select({ id: institutions.id, slug: institutions.slug })
    .from(institutions)
    .where(opts.institutionId ? eq(institutions.id, opts.institutionId) : undefined)
    .orderBy(institutions.id)
  const report: PurgeReport = { dryRun, institutions: [], platform: {} }
  for (const inst of all) {
    const purged = await inTransaction(dryRun, async (tx) => {
      const r = await tx.execute<{ purged: Record<string, number> }>(sql`select public.campusos_purge_expired(${inst.id}) as purged`)
      const counts = r.rows[0]!.purged
      if (total(counts) > 0) {
        await audit(tx, {
          institutionId: inst.id, actorId: null, actorEmail: 'retention purge', moduleId: 'core',
          action: 'dpdp.retention_purged', entity: 'institutions', entityId: inst.id,
          reason: 'the retention schedule', detail: { purged: counts },
        })
      }
      return counts
    })
    report.institutions.push({ id: inst.id, slug: inst.slug, purged })
  }
  const touched = report.institutions.filter((i) => total(i.purged) > 0).length
  report.platform = await inTransaction(dryRun, async (tx) => {
    const r = await tx.execute<{ purged: Record<string, number> }>(sql`select public.campusos_purge_platform() as purged`)
    const counts = r.rows[0]!.purged
    await platformAudit(tx, {
      actorId: null, actorEmail: 'retention purge', moduleId: 'core', action: 'dpdp.retention_run',
      entity: 'institutions', entityId: randomUUID(), reason: 'the retention schedule',
      detail: { institutions: touched, platform: counts },
    })
    return counts
  })
  return report
}

const BATCH = 5000
const hex = (v: unknown) => (Buffer.isBuffer(v) ? v.toString('hex') : v)
const plain = (row: object) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, hex(v)]))

/**
 * Everything the verifier hashes for one institution, one object per line: a
 * header (with the chain heads), every audit link with its row, then every
 * sensitive-read row, in seq order. Salts and hashes are lowercase hex, so
 * `rowHash` can be recomputed offline.
 */
export async function* trailExport(institutionId: string): AsyncGenerator<Record<string, unknown>> {
  const [inst] = await authDb
    .select({ id: institutions.id, slug: institutions.slug, name: institutions.name })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
  if (!inst) throw new Error(`no institution ${institutionId}`)
  yield { kind: 'header', format: 'campusos-trail-export/1', institution: inst, exportedAt: new Date().toISOString(), heads: await chainHeads({ institutionId }) }
  for (const [kind, batch] of [['audit', tenantBatch], ['read', readsBatch]] as const) {
    let after = 0
    for (;;) {
      const rows = (await batch(institutionId, after)).rows
      for (const row of rows) yield { kind, ...plain(row) }
      if (rows.length < BATCH) break
      after = Number(rows[rows.length - 1]!.seq)
    }
  }
}

/** Notes the export on the platform trail and, with `delete`, removes the institution (the cascade follows). */
export async function recordOffboarding(
  institutionId: string,
  file: { name: string; sha256: string; lines: number },
  opts: { delete: boolean },
): Promise<void> {
  await authDb.transaction(async (tx) => {
    await platformAudit(tx, {
      institutionId, actorId: null, actorEmail: 'offboarding', moduleId: 'core',
      action: 'institution.trail_exported', entity: 'institutions', entityId: institutionId,
      reason: 'the trail was exported before offboarding', detail: { file: file.name, sha256: file.sha256, lines: file.lines },
    })
    if (opts.delete) await tx.delete(institutions).where(eq(institutions.id, institutionId))
  })
}
