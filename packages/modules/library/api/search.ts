import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import type { LookupResult, Role } from '@campusos/module-framework'
import { lookupQuery, lookupTimeout, type LookupQuery } from '@campusos/module-academic/api'
import { LibraryError, type Actor } from './operations'

/**
 * Finding a book (UX-04, P1-09c, decisions 1000 to 1004): by ISBN, exact title
 * or author, or a literal part of either. Only bibliographic fields are read,
 * never a copy or a borrower, for exactly the roles that see the catalogue.
 */

const READERS: readonly Role[] = ['institution_admin', 'super_admin', 'library_staff', 'faculty', 'student']

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
type Row = { id: string; title: string; author: string }

/** Titles of one tenant matching the query: ISBN, then exact title or author, then a part of either. */
export async function findBooksWithin(tx: Tx, tenant: string, { q, like }: LookupQuery): Promise<Row[]> {
  // An ISBN is ten or thirteen characters once spaces and hyphens are taken out.
  const squeezed = q.replace(/[\s-]/g, '')
  const isbn = /^([0-9]{9}[0-9Xx]|[0-9]{13})$/.test(squeezed) ? squeezed : null
  const conditions = [sql`lower(title) = lower(${q})`, sql`lower(author) = lower(${q})`]
  if (isbn) conditions.push(sql`isbn in (${isbn}, ${isbn.toUpperCase()}, ${isbn.toLowerCase()})`)
  if (like) conditions.push(sql`lower(title) like lower(${like}) escape '!'`, sql`lower(author) like lower(${like}) escape '!'`)
  const { rows } = await tx.execute<Row>(sql`
    select id, title, author from library_titles
     where institution_id = ${tenant} and (${sql.join(conditions, sql` or `)})
     order by case
                when ${isbn ? sql`isbn in (${isbn}, ${isbn.toUpperCase()}, ${isbn.toLowerCase()})` : sql`false`} then 0
                when lower(title) = lower(${q}) or lower(author) = lower(${q}) then 1
                when ${like ? sql`lower(title) like lower(${like}) escape '!'` : sql`false`} then 2
                else 3
              end, lower(title), id
     limit 12`)
  return rows
}

export async function searchLibraryBooks(actor: Actor, req: Request): Promise<LookupResult> {
  if (!actor.institutionId) throw new LibraryError(400, 'no_institution', 'no institution for this session')
  if (!READERS.includes(actor.role)) throw new LibraryError(403, 'forbidden', 'not permitted')
  const tenant = actor.institutionId
  const query = lookupQuery(req)
  const rows = await withTenant(tenant, async (tx) => {
    await lookupTimeout(tx)
    return findBooksWithin(tx, tenant, query)
  })
  return {
    hits: rows.map((r) => ({ id: r.id, title: r.title, detail: r.author, href: `/m/library/catalogue?titleId=${encodeURIComponent(r.id)}` })),
  }
}
