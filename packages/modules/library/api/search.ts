import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import type { LookupResult, Role } from '@campusos/module-framework'
import { lookupQuery, lookupTimeout } from '@campusos/module-academic/api'
import { LibraryError, type Actor } from './operations'

/**
 * Finding a book (UX-04, P1-09c, decisions 1000 to 1004): by ISBN, exact title
 * or author, or a literal part of either. Only bibliographic fields are read,
 * never a copy or a borrower, for exactly the roles that see the catalogue.
 */

const READERS: readonly Role[] = ['institution_admin', 'super_admin', 'library_staff', 'faculty', 'student']

export async function searchLibraryBooks(actor: Actor, req: Request): Promise<LookupResult> {
  if (!actor.institutionId) throw new LibraryError(400, 'no_institution', 'no institution for this session')
  if (!READERS.includes(actor.role)) throw new LibraryError(403, 'forbidden', 'not permitted')
  const tenant = actor.institutionId
  const { q, like } = lookupQuery(req)
  // An ISBN is ten or thirteen characters once spaces and hyphens are taken out.
  const squeezed = q.replace(/[\s-]/g, '')
  const isbn = /^([0-9]{9}[0-9Xx]|[0-9]{13})$/.test(squeezed) ? squeezed : null
  const conditions = [sql`lower(title) = lower(${q})`, sql`lower(author) = lower(${q})`]
  if (isbn) conditions.push(sql`isbn in (${isbn}, ${isbn.toUpperCase()}, ${isbn.toLowerCase()})`)
  if (like) conditions.push(sql`lower(title) like lower(${like}) escape '!'`, sql`lower(author) like lower(${like}) escape '!'`)
  const rows = await withTenant(tenant, async (tx) => {
    await lookupTimeout(tx)
    const { rows } = await tx.execute<{ id: string; title: string; author: string }>(sql`
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
  })
  return {
    hits: rows.map((r) => ({ id: r.id, title: r.title, detail: r.author, href: `/m/library/catalogue?titleId=${encodeURIComponent(r.id)}` })),
  }
}
