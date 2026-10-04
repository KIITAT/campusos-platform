import { and, eq, sql } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { withTenant } from './client'
import { institutions, institutionModules, users } from './schema'
import { tenantPolicy } from './rls'

export const jobs = pgTable('background_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  result: jsonb('result'),
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  leaseToken: uuid('lease_token'),
  workerId: text('worker_id'),
  errorCode: text('error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('background_jobs_dedupe').on(table.institutionId, table.dedupeKey),
  index('background_jobs_due').on(table.institutionId, table.status, table.runAfter),
  check('background_jobs_status', sql`${table.status} in ('queued','running','succeeded','dead')`),
  check('background_jobs_attempts', sql`${table.maxAttempts} between 1 and 10 and ${table.attempts} between 0 and ${table.maxAttempts}`),
  tenantPolicy('background_jobs'),
]).enableRLS()

export type JobTransaction = Parameters<Parameters<typeof withTenant>[1]>[0]
export type BackgroundJob = typeof jobs.$inferSelect
type Role = typeof users.$inferSelect.role

export async function enqueueJob(tx: JobTransaction, input: {
  institutionId: string; actorId: string; kind: string; dedupeKey: string
  payload: Record<string, unknown>; runAfter?: Date; maxAttempts?: number
}): Promise<BackgroundJob> {
  if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(input.kind) || input.dedupeKey.length < 1 || input.dedupeKey.length > 200 || Buffer.byteLength(JSON.stringify(input.payload)) > 65536) throw new Error('invalid job')
  const [inserted] = await tx.insert(jobs).values(input).onConflictDoNothing({ target: [jobs.institutionId, jobs.dedupeKey] }).returning()
  if (inserted) return inserted
  const [existing] = await tx.select().from(jobs).where(and(eq(jobs.institutionId, input.institutionId), eq(jobs.dedupeKey, input.dedupeKey)))
  if (!existing || existing.kind !== input.kind || existing.actorId !== input.actorId || !isDeepStrictEqual(existing.payload, input.payload)) throw new Error('job dedupe conflict')
  return existing
}

export async function claimJob(tenant: string, workerId: string, leaseSeconds = 120): Promise<BackgroundJob | null> {
  if (!workerId || workerId.length > 100 || !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new Error('invalid lease')
  return withTenant(tenant, async (tx) => {
    await tx.execute(sql`with expired as (select id from background_jobs where status='running' and lease_until < now() and attempts >= max_attempts for update skip locked) update background_jobs set status='dead', completed_at=now(), error_code='lease_exhausted', lease_token=null, lease_until=null from expired where background_jobs.id=expired.id`)
    const result = await tx.execute<{ id: string }>(sql`with candidate as (
      select id from background_jobs where attempts < max_attempts and
      ((status='queued' and run_after <= now()) or (status='running' and lease_until < now()))
      order by run_after, created_at for update skip locked limit 1
    ) update background_jobs set status='running', attempts=attempts+1,
      lease_until=now()+${leaseSeconds}*interval '1 second', lease_token=gen_random_uuid(), worker_id=${workerId}
      from candidate where background_jobs.id=candidate.id returning background_jobs.id`)
    const id = result.rows[0]?.id
    if (!id) return null
    const [claimed] = await tx.select().from(jobs).where(eq(jobs.id, id))
    return claimed!
  })
}

export async function runClaimedJob<T>(tenant: string, id: string, leaseToken: string, handler: (tx: JobTransaction, job: BackgroundJob) => Promise<T>): Promise<T> {
  return withTenant(tenant, async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update')
    if (!job || job.status !== 'running' || job.leaseToken !== leaseToken || !job.leaseUntil || job.leaseUntil.getTime() <= Date.now()) throw new Error('job lease lost')
    const result = await handler(tx, job)
    await tx.update(jobs).set({ status: 'succeeded', result: result ?? null, completedAt: new Date(), leaseToken: null, leaseUntil: null, errorCode: null }).where(eq(jobs.id, id))
    return result
  })
}

export async function failJob(tenant: string, id: string, leaseToken: string, errorCode: string): Promise<BackgroundJob> {
  return withTenant(tenant, async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update')
    if (!job || job.status !== 'running' || job.leaseToken !== leaseToken) throw new Error('job lease lost')
    const dead = job.attempts >= job.maxAttempts
    const [failed] = await tx.update(jobs).set({ status: dead ? 'dead' : 'queued', completedAt: dead ? new Date() : null, leaseToken: null, leaseUntil: null, errorCode: /^[a-z_]{1,64}$/.test(errorCode) ? errorCode : 'handler_failed', runAfter: new Date(Date.now() + Math.min(3600, 5 * 2 ** (job.attempts - 1)) * 1000) }).where(eq(jobs.id, id)).returning()
    return failed!
  })
}

export async function jobActor(tx: JobTransaction, tenant: string, actorId: string | null, moduleId: string, roles: readonly Role[], alwaysEnabled = false) {
  const [institution] = await tx.select().from(institutions).where(eq(institutions.id, tenant)).for('share')
  if (!institution || institution.suspendedAt || !actorId) throw new Error('job actor not authorized')
  const [actor] = await tx.select({ id: users.id, institutionId: users.institutionId, email: users.email, role: users.role, erasedAt: users.erasedAt }).from(users).where(and(eq(users.id, actorId), eq(users.institutionId, tenant))).for('share')
  if (!actor || actor.erasedAt || !roles.includes(actor.role)) throw new Error('job actor not authorized')
  if (!alwaysEnabled) {
    const [entitlement] = await tx.select().from(institutionModules).where(and(eq(institutionModules.institutionId, tenant), eq(institutionModules.moduleId, moduleId))).for('share')
    if (!entitlement?.enabled) throw new Error('job module not enabled')
  }
  return actor
}
