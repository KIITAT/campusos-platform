import { eq, sql } from 'drizzle-orm'
import { audit } from './audit'
import { authDb, db, withTenant } from './client'
import { EXPORT_POLICY, exportableRow, type ExportRule } from './dpdp-policy'
import { users } from './schema'

/**
 * Digital Personal Data Protection Act obligations, in one place.
 *
 * Three of them are mechanical and belong here rather than in any module:
 * recording consent, handing somebody a copy of what is held about them, and
 * erasing them on request.
 *
 * The interesting one is erasure. A college cannot simply delete a person: a
 * fee receipt, an examination mark and an attendance register are the
 * institution's own records with their own retention obligations, and several
 * are required by a regulator long after the student has left. So erasure here
 * is anonymisation -- the identifying fields go, the rows that reference them
 * stay and become unattributable. That is the lawful outcome and the honest
 * one; offering a "delete everything" button that quietly does not would be
 * worse than offering nothing.
 */

/** Bump when the privacy notice changes materially. Stored on each consent. */
export const CONSENT_VERSION = '2026-09-01'

export async function recordConsent(
  institutionId: string,
  userId: string,
  version = CONSENT_VERSION,
): Promise<void> {
  await withTenant(institutionId, async (tx) => {
    const [before] = await tx
      .select({ version: users.consentVersion })
      .from(users)
      .where(eq(users.id, userId))
      .for('update')
    if (!before) return
    await tx
      .update(users)
      .set({ consentedAt: new Date(), consentVersion: version })
      .where(eq(users.id, userId))
    // Consent is evidence the institution may have to produce (NEW-10).
    await audit(tx, {
      institutionId, actorId: userId, moduleId: 'core', action: 'dpdp.consented',
      entity: 'users', entityId: userId, reason: 'the person agreed to the privacy notice',
      detail: { before: { version: before.version }, after: { version } },
    })
  })
}

/** Whether this person has agreed to the notice currently in force. */
export async function consentCurrent(
  institutionId: string,
  userId: string,
): Promise<boolean> {
  return withTenant(institutionId, async (tx) => {
    const [row] = await tx
      .select({ at: users.consentedAt, version: users.consentVersion })
      .from(users)
      .where(eq(users.id, userId))
    return row?.at !== null && row?.version === CONSENT_VERSION
  })
}

export interface ExportBundle {
  exportedAt: string
  subject: {
    id: string
    name: string | null
    email: string | null
    role: string
    joinedAt: string
    consentedAt: string | null
    consentVersion: string | null
  }
  /** table -> rows, everything in this institution that names them. */
  records: Record<string, unknown[]>
}

/**
 * Everything held about one person, as JSON.
 *
 * Discovered from the catalogue rather than from a hand-written list: any
 * table with a column referencing `users.id` is found, so a module added next
 * year is not missed. Found is not the same as handed over, though: a table
 * is exported only as `EXPORT_POLICY` classifies it, and credentials never are
 * (SEC-01). An unclassified table is left out, and CI names it.
 */
export async function exportSubject(
  institutionId: string,
  userId: string,
): Promise<ExportBundle> {
  // Inside the tenant transaction: `users` is RLS-scoped, so a plain read with
  // no institution set returns nothing at all rather than the wrong person.
  const [subject] = await withTenant(institutionId, (tx) =>
    tx.select().from(users).where(eq(users.id, userId)),
  )
  if (!subject) throw new Error('no such user in this institution')

  const columns = await db.execute<{ table_name: string; column_name: string }>(sql`
    select c.relname as table_name, a.attname as column_name
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
      join pg_class ref on ref.oid = con.confrelid
     where con.contype = 'f'
       and ref.relname = 'users'
       and c.relnamespace = 'public'::regnamespace
     order by 1, 2
  `)

  const records: Record<string, unknown[]> = {}
  const keep = (table: string, column: string, rows: Record<string, unknown>[]) => {
    if (rows.length > 0) records[`${table}.${column}`] = rows.map((row) => exportableRow(table, row))
  }
  const select = (rule: ExportRule) =>
    typeof rule === 'object' && 'only' in rule
      ? sql.join(rule.only.map((c) => sql.identifier(c)), sql`, `)
      : sql`*`
  const throughAuth = (rule: ExportRule) => typeof rule === 'object' && 'through' in rule

  const classified = columns.rows.filter(
    ({ table_name }) => table_name !== 'users' && (EXPORT_POLICY[table_name] ?? 'exclude') !== 'exclude',
  )
  await withTenant(institutionId, async (tx) => {
    for (const { table_name, column_name } of classified) {
      const rule = EXPORT_POLICY[table_name]!
      if (throughAuth(rule)) continue
      const rows = await tx.execute<Record<string, unknown>>(
        sql`select ${select(rule)} from ${sql.identifier(table_name)}
             where ${sql.identifier(column_name)} = ${userId}
             limit 5000`,
      )
      keep(table_name, column_name, rows.rows)
    }
  })
  // Tables with no row-level security, which only the auth role may read
  // (SEC-05): the institution is named explicitly instead.
  for (const { table_name, column_name } of classified) {
    const rule = EXPORT_POLICY[table_name]!
    if (!throughAuth(rule)) continue
    const rows = await authDb.execute<Record<string, unknown>>(
      sql`select ${select(rule)} from ${sql.identifier(table_name)}
           where ${sql.identifier(column_name)} = ${userId}
             and institution_id = ${institutionId}
           limit 5000`,
    )
    keep(table_name, column_name, rows.rows)
  }

  return {
    exportedAt: new Date().toISOString(),
    subject: {
      id: subject.id,
      name: subject.name,
      email: subject.email,
      role: subject.role,
      joinedAt: subject.createdAt.toISOString(),
      consentedAt: subject.consentedAt?.toISOString() ?? null,
      consentVersion: subject.consentVersion,
    },
    records,
  }
}

export interface ErasureResult {
  userId: string
  erasedAt: string
  /** Rows left in place, unattributable. Reported so the subject can be told. */
  retained: Record<string, number>
}

/**
 * Erase a person while leaving the institution's records standing.
 *
 * The email is replaced rather than nulled, because it is unique and a second
 * erasure would otherwise collide; the replacement is derived from the id, so
 * it is stable and obviously not an address. `emailVerified` is cleared so the
 * account cannot be signed into again.
 */
export async function eraseSubject(
  institutionId: string,
  userId: string,
  by: { actorId: string; actorEmail?: string | null; reason: string },
): Promise<ErasureResult> {
  if (by.reason.trim().length < 5) {
    throw new Error('erasure requires a reason')
  }

  const bundle = await exportSubject(institutionId, userId)
  const retained = Object.fromEntries(
    Object.entries(bundle.records).map(([k, v]) => [k, v.length]),
  )

  const erasedAt = new Date()
  await withTenant(institutionId, async (tx) => {
    // The audit row names the subject id, never the erased identity: it has to
    // prove the erasure happened without re-storing what was erased.
    await audit(tx, {
      institutionId,
      actorId: by.actorId,
      actorEmail: by.actorEmail ?? null,
      moduleId: 'core',
      action: 'dpdp.erased',
      entity: 'users',
      entityId: userId,
      reason: by.reason,
      detail: { retained },
    })

    await tx
      .update(users)
      .set({
        name: null,
        email: `erased+${userId}@invalid`,
        emailVerified: null,
        image: null,
        erasedAt,
      })
      .where(eq(users.id, userId))
  })

  return { userId, erasedAt: erasedAt.toISOString(), retained }
}
