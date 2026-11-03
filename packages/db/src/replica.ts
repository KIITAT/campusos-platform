import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { corePool } from './client'
import * as schema from './schema'

/**
 * Report reads (P2-05, decision 438). The host publishes a second pool on the reporting replica
 * (REPORTS_DATABASE_URL, the campusos_app role); a plugin's copy of this file finds it here.
 * Without one, reads go to the primary. Either way the transaction is read-only and short.
 */
type Global = { __campusosReportPool?: Pool }
const g = globalThis as Global

export function publishReportPool(url: string): void {
  g.__campusosReportPool ??= new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 30000, application_name: 'campusos-reports' })
}

/** Whether the host published a report pool; without one, report reads share the primary pool. */
export const reportPoolPublished = (): boolean => g.__campusosReportPool !== undefined

let cached: { pool: Pool; db: ReturnType<typeof drizzle<typeof schema>> } | null = null
const readDb = () => {
  const pool = g.__campusosReportPool ?? corePool
  if (cached?.pool !== pool) cached = { pool, db: drizzle(pool, { schema }) }
  return cached.db
}

export type ReadTx = Parameters<Parameters<ReturnType<typeof readDb>['transaction']>[0]>[0]

export function withTenantRead<T>(institutionId: string, fn: (tx: ReadTx) => Promise<T>): Promise<T> {
  return readDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.institution_id', ${institutionId}, true), set_config('statement_timeout', '25000', true)`)
    return fn(tx)
  }, { accessMode: 'read only' })
}

export async function readFacts(tx: ReadTx): Promise<{ onReplica: boolean; dataAsOf: Date }> {
  const [r] = (await tx.execute(sql`select pg_is_in_recovery() as on_replica, coalesce(pg_last_xact_replay_timestamp(), now()) as data_as_of`)).rows as { on_replica: boolean; data_as_of: string | Date }[]
  return { onReplica: r!.on_replica, dataAsOf: new Date(r!.data_as_of) }
}
