import { getTableColumns, getTableName, sql, type SQL } from 'drizzle-orm'
import { text, timestamp, uuid, type PgTable } from 'drizzle-orm/pg-core'
import { audit } from './audit'
import type { withTenant } from './client'

/**
 * Draft, submitted, cancelled.
 *
 * Some records are not rows to edit but acts to record: a journal entry, a
 * purchase order, a payroll entry, a fee schedule. Once one has taken effect,
 * changing it in place rewrites history, and the only honest correction is to
 * cancel it -- with a reason -- and issue a replacement that says which one it
 * replaces. That lifecycle is the same everywhere it applies, so it is built
 * once: the rules live in a database function (campusos_docstatus_guard, core
 * migration 0002) that a module attaches to its table, and these helpers make
 * the moves and write the audit rows.
 *
 * The trigger is the guarantee. The helpers check first so that a caller is
 * told what is wrong by name instead of by a failed query.
 */

export type DocStatusValue = 'draft' | 'submitted' | 'cancelled'

/** Spread into a table's columns. The trigger reads these names. */
export const docStatusColumns = () => ({
  docstatus: text('docstatus').$type<DocStatusValue>().notNull().default('draft'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedBy: text('submitted_by'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: text('cancelled_by'),
  cancelReason: text('cancel_reason'),
  /** The cancelled record this draft replaces. */
  amendedFrom: uuid('amended_from'),
})

/** The check and trigger a migration adds for a table opting in. */
export const docStatusDdl = (table: string) =>
  [
    `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'))`,
    `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "${table}"("id") ON DELETE restrict`,
    `CREATE TRIGGER "${table}_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard()`,
  ].join(';\n--> statement-breakpoint\n') + ';'

export class DocStatusError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code:
      | 'no_such_record'
      | 'not_a_draft'
      | 'not_submitted'
      | 'not_cancelled'
      | 'already_amended',
    message: string,
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
type Row = Record<string, unknown>

interface Who {
  institutionId: string
  actorId: string
  actorEmail?: string | null
  moduleId: string
}

const LIFECYCLE = new Set(['docstatus', 'submitted_at', 'submitted_by', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'amended_from'])

const ident = (table: PgTable) => sql.identifier(getTableName(table))

async function current(tx: Tx, table: PgTable, id: string): Promise<Row> {
  const res = await tx.execute(sql`select * from ${ident(table)} where id = ${id} for update`)
  const row = res.rows[0] as Row | undefined
  if (!row) throw new DocStatusError(404, 'no_such_record', 'no such record')
  return row
}

/** Submit a draft. From here it cannot change; only be cancelled. */
export async function submitDocument(tx: Tx, table: PgTable, id: string, who: Who): Promise<Row> {
  const row = await current(tx, table, id)
  if (row.docstatus !== 'draft') {
    throw new DocStatusError(409, 'not_a_draft', `this record is ${String(row.docstatus)}, not a draft`)
  }
  const res = await tx.execute(
    sql`update ${ident(table)} set docstatus = 'submitted', submitted_at = now(), submitted_by = ${who.actorId}
        where id = ${id} returning *`,
  )
  await audit(tx, {
    institutionId: who.institutionId,
    actorId: who.actorId,
    actorEmail: who.actorEmail ?? null,
    moduleId: who.moduleId,
    action: `${who.moduleId}.submitted`,
    entity: getTableName(table),
    entityId: id,
    reason: 'submitted',
  })
  return res.rows[0] as Row
}

/** Cancel a submitted record, with a reason. Final. */
export async function cancelDocument(
  tx: Tx,
  table: PgTable,
  id: string,
  who: Who & { reason: string },
): Promise<Row> {
  const row = await current(tx, table, id)
  if (row.docstatus !== 'submitted') {
    throw new DocStatusError(
      409,
      'not_submitted',
      row.docstatus === 'draft' ? 'a draft is deleted, not cancelled' : 'this record is already cancelled',
    )
  }
  const res = await tx.execute(
    sql`update ${ident(table)} set docstatus = 'cancelled', cancelled_at = now(), cancelled_by = ${who.actorId},
        cancel_reason = ${who.reason} where id = ${id} returning *`,
  )
  await audit(tx, {
    institutionId: who.institutionId,
    actorId: who.actorId,
    actorEmail: who.actorEmail ?? null,
    moduleId: who.moduleId,
    action: `${who.moduleId}.cancelled`,
    entity: getTableName(table),
    entityId: id,
    reason: who.reason,
  })
  return res.rows[0] as Row
}

/**
 * Amend a cancelled record: a new draft, a copy of it, naming it. Only once --
 * a second amendment of the same record would be two replacements for one
 * thing. `overrides` sets columns on the copy (a new number, say), by column
 * name as the database spells it.
 */
export async function amendDocument(
  tx: Tx,
  table: PgTable,
  id: string,
  who: Who,
  overrides: Record<string, unknown> = {},
): Promise<Row> {
  const row = await current(tx, table, id)
  if (row.docstatus !== 'cancelled') {
    throw new DocStatusError(409, 'not_cancelled', 'only a cancelled record is amended')
  }
  const again = await tx.execute(sql`select id from ${ident(table)} where amended_from = ${id} limit 1`)
  if (again.rows.length > 0) throw new DocStatusError(409, 'already_amended', 'this record was already amended')

  const names = Object.values(getTableColumns(table))
    .map((c) => c.name)
    // created_at keeps its default on the copy: the amendment is made now.
    .filter((n) => n !== 'id' && n !== 'created_at' && !LIFECYCLE.has(n))
  const cols: SQL[] = []
  const vals: SQL[] = []
  for (const n of names) {
    cols.push(sql`${sql.identifier(n)}`)
    vals.push(n in overrides ? sql`${overrides[n]}` : sql`${sql.identifier(n)}`)
  }
  const res = await tx.execute(
    sql`insert into ${ident(table)} (${sql.join(cols, sql`, `)}, docstatus, amended_from)
        select ${sql.join(vals, sql`, `)}, 'draft', id from ${ident(table)} where id = ${id}
        returning *`,
  )
  const made = res.rows[0] as Row
  await audit(tx, {
    institutionId: who.institutionId,
    actorId: who.actorId,
    actorEmail: who.actorEmail ?? null,
    moduleId: who.moduleId,
    action: `${who.moduleId}.amended`,
    entity: getTableName(table),
    entityId: String(made.id),
    reason: `amends ${id}`,
    detail: { amendedFrom: id },
  })
  return made
}
