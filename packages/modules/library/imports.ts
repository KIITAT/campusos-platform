import { and, eq, isNull, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import type { ImportSpec, PluginActor } from '@campusos/module-framework'
import { copies, titles } from './schema'
import { addCopies, createTitle } from './api'

/**
 * The accession register, as a library already keeps it: one row per copy on
 * the shelves. The first row for a book catalogues it -- matched by ISBN, or
 * by title and author when there is none -- and every row adds its copy. A
 * copy whose accession number is already here is left as it is.
 */

const tenantOf = (actor: PluginActor) => actor.institutionId!
const blank = (v: string | undefined) => (v ? v : undefined)

async function titleFor(actor: PluginActor, v: Record<string, string>): Promise<string> {
  const isbn = v.isbn?.replace(/[\s-]/g, '')
  const [found] = await withTenant(tenantOf(actor), (tx) =>
    tx
      .select({ id: titles.id })
      .from(titles)
      .where(
        isbn
          ? eq(titles.isbn, isbn)
          : and(isNull(titles.isbn), sql`lower(${titles.title}) = ${v.title!.toLowerCase()}`, sql`lower(${titles.author}) = ${v.author!.toLowerCase()}`),
      )
      .limit(1),
  )
  if (found) return found.id
  const created = (await createTitle(actor, {
    isbn: blank(isbn), title: v.title, author: v.author, publisher: blank(v.publisher), year: blank(v.year), category: blank(v.category),
  })) as { id: string }
  return created.id
}

export const imports: ImportSpec[] = [
  {
    id: 'copies',
    title: 'Books and copies',
    note: 'The accession register: one row per copy. Rows for the same book share its ISBN, or its title and author.',
    roles: ['library_staff', 'institution_admin', 'super_admin'],
    columns: [
      { name: 'accession_no', required: true, note: 'Stamped inside the copy; unique here', example: 'ACC-004512' },
      { name: 'title', required: true, note: 'The book’s title', example: 'Introduction to Algorithms' },
      { name: 'author', required: true, note: 'The first author, or the editor', example: 'Cormen, Leiserson, Rivest, Stein' },
      { name: 'isbn', note: 'ISBN-10 or ISBN-13; recommended', example: '9780262046305' },
      { name: 'publisher', note: 'Optional', example: 'MIT Press' },
      { name: 'year', note: 'Year of publication', example: '2022' },
      { name: 'category', note: 'Optional: a subject or collection', example: 'Computer science' },
      { name: 'shelf', note: 'Where it lives', example: 'CS-3' },
      { name: 'replacement', note: 'Replacement cost in rupees, charged if it is lost', example: '4500' },
    ],
    row: async (actor, { values: v }) => {
      const [existing] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: copies.id }).from(copies).where(eq(copies.accessionNo, v.accession_no!)))
      if (existing) return 'skipped'
      const titleId = await titleFor(actor, v)
      await addCopies(actor, { titleId, accessionNos: [v.accession_no], shelf: blank(v.shelf), replacement: blank(v.replacement) })
      return 'created'
    },
  },
]
