import { sql, type SQL } from 'drizzle-orm'

/**
 * The log of who opened a sensitive record (AUD-07, P1-08c).
 *
 * A subpath export (`@campusos/db/sensitive-reads`), not part of the package
 * index, so a plugin archive that does not use it stays unchanged. Plain SQL
 * throughout: the insert trigger fills the chain columns the caller must not
 * choose (core 0015).
 */

/** What both `db` and a transaction offer. */
type Executor = { execute: (q: SQL) => Promise<unknown> }
type Rows<T> = { rows: T[] }

export type SensitiveReadKind =
  | 'care.result'
  | 'care.case'
  | 'mentoring.mentee'
  | 'mentoring.leave_document'
  | 'parents.child_overview'

export type SensitiveRead = {
  institutionId: string
  readerId: string
  subjectId: string
  moduleId: string
  kind: SensitiveReadKind
  entity: string
  entityId: string
  purpose: string
}

export type SensitiveReadRow = {
  at: Date
  readerId: string | null
  readerName: string | null
  subjectId: string | null
  subjectName: string | null
  kind: string
  entity: string
  entityId: string
  purpose: string
}

export const KIND_LABELS: Record<SensitiveReadKind, string> = {
  'care.result': 'A self-check result shared with a counsellor',
  'care.case': 'A counselling case',
  'mentoring.mentee': 'A mentee’s whole record',
  'mentoring.leave_document': 'A leave application’s document',
  'parents.child_overview': 'A child’s overview, opened by the office',
}

/** One row, in the read's own transaction; a failure to log fails the read. */
export async function logSensitiveRead(tx: Executor, r: SensitiveRead): Promise<void> {
  await tx.execute(sql`
    insert into sensitive_reads (institution_id, reader_id, subject_id, module_id, kind, entity, entity_id, purpose)
    values (${r.institutionId}, ${r.readerId}, ${r.subjectId}, ${r.moduleId}, ${r.kind}, ${r.entity}, ${r.entityId}, ${r.purpose})`)
}

/** The user who reads the log for this institution, or null until one is named. */
export async function privacyOfficerOf(tx: Executor, institutionId: string): Promise<string | null> {
  const r = (await tx.execute(sql`select user_id from privacy_officers where institution_id = ${institutionId}`)) as Rows<{ user_id: string }>
  return r.rows[0]?.user_id ?? null
}

/** Newest first, at most 500. `from` and `to` are YYYY-MM-DD dates in Asia/Kolkata, inclusive. */
export async function readSensitiveLog(
  tx: Executor,
  institutionId: string,
  q: { from?: string; to?: string; subjectId?: string },
): Promise<SensitiveReadRow[]> {
  const r = (await tx.execute(sql`
    select r.at, r.reader_id, ru.name as reader_name, r.subject_id, su.name as subject_name,
           r.kind, r.entity, r.entity_id, r.purpose
      from sensitive_reads r
      left join users ru on ru.id = r.reader_id
      left join users su on su.id = r.subject_id
     where r.institution_id = ${institutionId}
       ${q.subjectId ? sql`and r.subject_id = ${q.subjectId}` : sql``}
       ${q.from ? sql`and r.at >= (${q.from}::date)::timestamp at time zone 'Asia/Kolkata'` : sql``}
       ${q.to ? sql`and r.at < ((${q.to}::date + 1))::timestamp at time zone 'Asia/Kolkata'` : sql``}
     order by r.at desc, r.seq desc
     limit 500`)) as Rows<{
    at: Date; reader_id: string | null; reader_name: string | null; subject_id: string | null; subject_name: string | null
    kind: string; entity: string; entity_id: string; purpose: string
  }>
  return r.rows.map((x) => ({
    at: x.at, readerId: x.reader_id, readerName: x.reader_name, subjectId: x.subject_id, subjectName: x.subject_name,
    kind: x.kind, entity: x.entity, entityId: x.entity_id, purpose: x.purpose,
  }))
}
