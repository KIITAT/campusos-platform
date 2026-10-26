import { and, desc, eq, sql } from 'drizzle-orm'
import { bigint, customType, jsonb, pgTable, text, timestamp, unique, uuid, index } from 'drizzle-orm/pg-core'
import { institutions, users } from './schema'
import { tenantPolicy } from './rls'
import { withTenant } from './client'

/**
 * The audit log, built once here rather than per module.
 *
 * The engineering standards call for one shared utility that every module
 * imports; this lives in packages/db because every module already depends on
 * it, and because an audit row has to be written in the same transaction as
 * the change it records. A separate service, or a write after commit, gives
 * you changes with no audit row on exactly the requests that failed halfway.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    /** Who did it. Nullable only so deleting a user does not erase the trail. */
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email'),
    /** Which module asked, so a per-module view is a plain filter. */
    moduleId: text('module_id').notNull(),
    /** Verb: 'mark.revised', 'attendance.override', 'fee.waived'. */
    action: text().notNull(),
    /** What was touched, as table plus id, so a row's history is one query. */
    entity: text().notNull(),
    entityId: text('entity_id').notNull(),
    /** Mandatory. An audit row without a reason answers nothing in a dispute. */
    reason: text().notNull(),
    /** Whatever the caller needs later: previous and new values, typically. */
    detail: jsonb().$type<Record<string, unknown>>(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /**
     * 32 random bytes, set by the database on insert whatever the caller sends.
     * The chain commits to who, why and the detail only through a digest salted
     * with this, so a lawful redaction can later remove the content and the salt
     * together without breaking the chain (P0-02, AUD-03). NULL on rows written
     * before the chain existed.
     */
    salt: bytea(),
  },
  (t) => [
    index('audit_log_entity').on(t.entity, t.entityId),
    index('audit_log_actor').on(t.actorId),
    index('audit_log_at').on(t.at),
    tenantPolicy('audit_log'),
  ],
)

/**
 * The hash chain over `audit_log`, one per institution (AUD-01).
 *
 * A side table rather than columns on `audit_log`, because a link can only be
 * computed once the previous one is known: doing it at insert would hold a
 * per-institution lock from a transaction's first audit row to its commit,
 * queueing every audited write behind the slowest and deadlocking against row
 * locks taken in the other order. Instead a deferred trigger seals each row as
 * its transaction commits (core migration 0008), so the chain is in commit order
 * and the lock lasts only as long as the seal. Written by that trigger alone;
 * the application role may read its own institution's links and nothing else.
 */
export const auditChain = pgTable(
  'audit_chain',
  {
    auditId: uuid('audit_id').primaryKey().references(() => auditLog.id),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    seq: bigint({ mode: 'number' }).notNull(),
    prevHash: bytea('prev_hash').notNull(),
    hash: bytea().notNull(),
    sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('audit_chain_institution_seq').on(t.institutionId, t.seq), tenantPolicy('audit_chain')],
)

/**
 * Events that belong to no institution: a plugin installed on the server, a
 * super admin appointed, an institution deleted, an anchor taken. Chained too,
 * in the row itself, since these are rare enough that holding the one platform
 * lock to commit costs nothing. `institution_id` is context, not a foreign key,
 * so the record that an institution was deleted outlives it. No tenant policy:
 * the application role has no grant here at all.
 */
export const platformAuditLog = pgTable(
  'platform_audit_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: uuid('institution_id'),
    actorId: text('actor_id'),
    actorEmail: text('actor_email'),
    moduleId: text('module_id').notNull(),
    action: text().notNull(),
    entity: text().notNull(),
    entityId: text('entity_id').notNull(),
    reason: text().notNull(),
    detail: jsonb().$type<Record<string, unknown>>(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    salt: bytea(),
    seq: bigint({ mode: 'number' }).notNull().unique('platform_audit_log_seq'),
    prevHash: bytea('prev_hash').notNull(),
    hash: bytea().notNull(),
  },
  (t) => [index('platform_audit_log_at').on(t.at)],
).enableRLS()

export interface AuditEntry {
  institutionId: string
  actorId: string | null
  actorEmail?: string | null
  moduleId: string
  action: string
  entity: string
  entityId: string
  reason: string
  detail?: Record<string, unknown>
}

/** Anything that can run a query: a transaction, or the db itself. */
type Executor = {
  insert: (table: typeof auditLog) => {
    values: (v: typeof auditLog.$inferInsert) => Promise<unknown>
  }
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>
}

/**
 * Records an audited change. Call it with the *same* transaction as the write
 * it describes, never afterwards.
 *
 * It also sets `app.audit_reason` for the remainder of the transaction, which
 * is what the guard trigger on protected tables checks. That is the mechanism
 * that makes a silent post-hoc edit impossible rather than merely discouraged:
 * an UPDATE on a locked row without a reason in scope is refused by Postgres,
 * not by whichever code path remembered to check.
 */
export async function audit<T extends Executor>(tx: T, entry: AuditEntry): Promise<void> {
  await tx.execute(
    sql`select set_config('app.audit_reason', ${entry.reason}, true)`,
  )
  await tx.insert(auditLog).values({
    institutionId: entry.institutionId,
    actorId: entry.actorId,
    actorEmail: entry.actorEmail ?? null,
    moduleId: entry.moduleId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    reason: entry.reason,
    detail: entry.detail ?? null,
  })
}

export type PlatformAuditEntry = Omit<AuditEntry, 'institutionId'> & {
  /** The institution the event concerns, if any. Context only: it outlives the institution. */
  institutionId?: string | null
}

/**
 * Records a platform event: one with no institution of its own. Same rule as
 * `audit`: call it with the transaction that makes the change.
 *
 * Plain SQL naming only the content columns, which is all the auth role may
 * insert. The sequence, the link, the hash and the salt are the database's.
 */
export async function platformAudit<T extends Executor>(tx: T, entry: PlatformAuditEntry): Promise<void> {
  await tx.execute(
    sql`select set_config('app.audit_reason', ${entry.reason}, true)`,
  )
  await tx.execute(sql`
    insert into platform_audit_log
      (institution_id, actor_id, actor_email, module_id, action, entity, entity_id, reason, detail)
    values (${entry.institutionId ?? null}, ${entry.actorId}, ${entry.actorEmail ?? null}, ${entry.moduleId},
            ${entry.action}, ${entry.entity}, ${entry.entityId}, ${entry.reason},
            ${entry.detail === undefined ? null : JSON.stringify(entry.detail)}::jsonb)`)
}

export interface TrailEntry {
  at: string
  who: string | null
  action: string
  reason: string
}

/**
 * One record's history, newest first, for the timeline beside a form view.
 *
 * The verb, who and why -- never `detail`, which holds before-and-after values
 * that were written for an investigator, not for whoever can open the record.
 */
export async function recordTrail(
  institutionId: string,
  entity: string,
  entityId: string,
  limit = 50,
): Promise<TrailEntry[]> {
  const rows = await withTenant(institutionId, (tx) =>
    tx
      .select({ at: auditLog.at, who: auditLog.actorEmail, action: auditLog.action, reason: auditLog.reason })
      .from(auditLog)
      .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)))
      .orderBy(desc(auditLog.at))
      .limit(limit),
  )
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }))
}
