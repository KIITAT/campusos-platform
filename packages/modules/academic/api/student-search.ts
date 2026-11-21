import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { PluginError, type LookupHit, type LookupResult } from '@campusos/module-framework'
import { requireWriter, type Actor } from './operations'

/**
 * Finding a student by roll, registration or name (UX-04, P1-09c, decisions
 * 1003 and 1004). The one reader the Fees and Parents pickers share: each
 * caller checks its own role first, then passes its tenant here.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export type LookupQuery = { q: string; like: string | null }

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const INVALID = 'Enter a search between 1 and 100 characters.'
const invalid = () => new PluginError(400, 'invalid_search', INVALID)

/**
 * `q` exactly once, trimmed, 1 to 100 code points, no control character and no
 * lone surrogate. A contains pattern (`!` escapes `!`, `%` and `_`) only when the
 * query holds a run of three letters, marks or digits: shorter text matches
 * identifiers exactly and nothing else.
 */
export function lookupQuery(req: Request): LookupQuery {
  const all = new URL(req.url).searchParams.getAll('q')
  if (all.length !== 1) throw invalid()
  const raw = all[0]!
  if (LONE_SURROGATE.test(raw) || /\p{Cc}/u.test(raw)) throw invalid()
  const q = raw.trim()
  const length = [...q].length
  if (length < 1 || length > 100) throw invalid()
  const like = /[\p{L}\p{M}\p{N}]{3}/u.test(q) ? `%${q.replace(/[!%_]/g, '!$&')}%` : null
  return { q, like }
}

const LIMIT = 12

/** Every lookup runs under a short statement timeout, local to its transaction. */
export const lookupTimeout = (tx: Tx) => tx.execute(sql`select set_config('statement_timeout', '750ms', true)`)

type Row = { id: string; name: string | null; email: string | null; roll_no: string | null; registration_no: string | null }

/**
 * Students of one tenant matching the query, best first: an exact roll or
 * registration, then an exact name, then a name containing it. A picker also
 * takes an exact e-mail address (and shows it only for a student with no name).
 * Erased students never appear.
 */
export async function findStudentChoicesWithin(tx: Tx, tenant: string, query: LookupQuery, picker: boolean): Promise<LookupHit[]> {
  const { q, like } = query
  const lowerName = sql`lower(coalesce(name, ''))`
  const branches = [
    sql`select student_id as id, 0 as rank from academic_student_profiles
        where institution_id = ${tenant} and (lower(roll_no) = lower(${q}) or lower(registration_no) = lower(${q}))`,
    sql`select id, 1 as rank from users
        where institution_id = ${tenant} and role = 'student' and erased_at is null and ${lowerName} = lower(${q})`,
  ]
  if (like)
    branches.push(sql`select id, 2 as rank from users
        where institution_id = ${tenant} and role = 'student' and erased_at is null and ${lowerName} like lower(${like}) escape '!'`)
  if (picker && q.includes('@'))
    branches.push(sql`select id, 0 as rank from users
        where institution_id = ${tenant} and role = 'student' and erased_at is null and (email = lower(${q}) or email = ${q})`)
  const { rows } = await tx.execute<Row>(sql`
    with cand as (${sql.join(branches, sql` union all `)})
    select u.id, u.name, ${picker ? sql`u.email` : sql`null::text`} as email, p.roll_no, p.registration_no
      from (select id, min(rank) as rank from cand group by id) c
      join users u on u.id = c.id and u.institution_id = ${tenant} and u.role = 'student' and u.erased_at is null
      left join academic_student_profiles p on p.student_id = u.id and p.institution_id = ${tenant}
     order by c.rank, lower(coalesce(u.name, '')), u.id
     limit ${LIMIT}`)
  return rows.map((r) => ({
    id: r.id,
    title: r.name?.trim() || (picker && r.email) || 'Student',
    detail: r.roll_no ? `Roll ${r.roll_no}` : r.registration_no ? `Registration ${r.registration_no}` : null,
    href: picker ? null : `/m/academic/record?studentId=${encodeURIComponent(r.id)}`,
  }))
}

/** The portal's global search: students of this institution, for the office. */
export async function searchAcademicRecords(actor: Actor, req: Request): Promise<LookupResult> {
  const tenant = requireWriter(actor)
  const query = lookupQuery(req)
  return {
    hits: await withTenant(tenant, async (tx) => {
      await lookupTimeout(tx)
      return findStudentChoicesWithin(tx, tenant, query, false)
    }),
  }
}
