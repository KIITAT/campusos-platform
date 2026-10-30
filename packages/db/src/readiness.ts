import { sql, type SQL } from 'drizzle-orm'
import journal from '../migrations/meta/_journal.json' with { type: 'json' }
import { db } from './client'

/** The newest core migration this build was made with: drizzle records its `when` as `created_at`. */
export const CORE_MIGRATED_AT: number = journal.entries[journal.entries.length - 1]!.when

/** A queue whose oldest due job has waited longer than this is lagging (decision D10). */
export const JOB_LAG_LIMIT_SECONDS = 900

export type Readiness = {
  status: 'ok' | 'degraded' | 'down'
  checks: { database: 'ok' | 'fail'; migrations: 'ok' | 'behind' | 'unknown'; jobs: 'ok' | 'lagging' | 'unknown' }
}

type Executor = { execute(query: SQL): Promise<{ rows: unknown[] }> }

/**
 * What /api/health answers (REL-02). Down when the database cannot be reached
 * or its schema is older than this build; degraded, not down, when only the
 * job queue lags, so a stalled worker never takes the web tier out of rotation.
 */
export async function readiness(options: { database?: Executor; expectedMigratedAt?: number; jobLagLimitSeconds?: number } = {}): Promise<Readiness> {
  const database = options.database ?? db
  try {
    const { rows } = await database.execute(sql`select core_migrated_at, oldest_due_job_seconds from campusos_readiness()`)
    const row = rows[0] as { core_migrated_at: string | null; oldest_due_job_seconds: number }
    const jobs = row.oldest_due_job_seconds > (options.jobLagLimitSeconds ?? JOB_LAG_LIMIT_SECONDS) ? 'lagging' : 'ok'
    if (Number(row.core_migrated_at ?? 0) < (options.expectedMigratedAt ?? CORE_MIGRATED_AT)) {
      return { status: 'down', checks: { database: 'ok', migrations: 'behind', jobs } }
    }
    return { status: jobs === 'ok' ? 'ok' : 'degraded', checks: { database: 'ok', migrations: 'ok', jobs } }
  } catch (e) {
    // 42883: the function does not exist yet, so the schema predates this build.
    const code = (e as { cause?: { code?: unknown } }).cause?.code ?? (e as { code?: unknown }).code
    if (code === '42883') return { status: 'down', checks: { database: 'ok', migrations: 'behind', jobs: 'unknown' } }
    return { status: 'down', checks: { database: 'fail', migrations: 'unknown', jobs: 'unknown' } }
  }
}
