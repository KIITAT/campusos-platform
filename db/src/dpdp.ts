import { eq, sql } from 'drizzle-orm'
import { audit } from './audit'
import { db, withTenant } from './client'
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
    await tx
      .update(users)
      .set({ consentedAt: new Date(), consentVersion: version })
      .where(eq(users.id, userId))
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
 * table with a column referencing `users.id` is included automatically, so a
 * module added next year is covered without anybody remembering to edit this.
 * A hand-maintained list is a compliance gap with a code review attached.
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
  await withTenant(institutionId, async (tx) => {
    for (const { table_name, column_name } of columns.rows) {
      if (table_name === 'users') continue
      const rows = await tx.execute(
        sql`select * from ${sql.identifier(table_name)}
             where ${sql.identifier(column_name)} = ${userId}
             limit 5000`,
      )
      if (rows.rows.length > 0) {
        records[`${table_name}.${column_name}`] = rows.rows
      }
    }
  })

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
