import { sql } from 'drizzle-orm'
import { jsonb, pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core'
import { institutions, users } from './schema'
import { tenantPolicy } from './rls'

/**
 * The audit log, built once here rather than per module.
 *
 * The engineering standards call for one shared utility that every module
 * imports; this lives in packages/db because every module already depends on
 * it, and because an audit row has to be written in the same transaction as
 * the change it records. A separate service, or a write after commit, gives
 * you changes with no audit row on exactly the requests that failed halfway.
 */
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
  },
  (t) => [
    index('audit_log_entity').on(t.entity, t.entityId),
    index('audit_log_actor').on(t.actorId),
    index('audit_log_at').on(t.at),
    tenantPolicy('audit_log'),
  ],
)

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
