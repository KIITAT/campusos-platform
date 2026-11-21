import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { authorizeRoute } from '@campusos/module-framework'
import { plugin } from './plugin'
import { titles } from './schema'
import type { Actor } from './api'

/**
 * UX-04, P1-09c: a book found by title, author or ISBN through GET
 * /record-search, with bibliographic fields only: never a borrower.
 */

const SLUG = 'lib-search-'
let n = 0

type Hit = { id: string; title: string; detail: string | null; href: string | null }

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Library College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values(
      (['institution_admin', 'library_staff', 'faculty', 'student', 'accounts_staff', 'hod', 'hostel_staff', 'parent'] as const).map((role) => ({
        email: `${role}@${tag}.test`,
        institutionId: id,
        role,
        name: role,
      })),
    )
    .returning({ id: users.id, role: users.role })
  const as = (role: string) => ({ id: people.find((p) => p.role === role)!.id, role, institutionId: id }) as Actor
  const book = (title: string, author: string, isbn: string | null = null) =>
    withTenant(id, async (tx) => {
      const [t] = await tx.insert(titles).values({ institutionId: id, title, author, isbn }).returning({ id: titles.id })
      return t!.id
    })
  return { id, as, book }
}

const route = () => {
  const r = plugin.routes.find((x) => x.method === 'GET' && x.path === '/record-search')
  assert.ok(r, 'Library declares GET /record-search')
  return r
}
const search = async (actor: Actor, q: string | null, raw?: string): Promise<{ hits: Hit[] }> =>
  (await route().handler(actor as never, new Request(raw ?? `http://x/record-search${q === null ? '' : `?q=${encodeURIComponent(q)}`}`))) as { hits: Hit[] }
const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return (e as { code?: string }).code
  }
  return 'resolved'
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('the route is the global lookup for exactly the catalogue readers', () => {
  const r = route()
  assert.equal(r.lookup, 'global')
  assert.deepEqual([...(r.roles ?? [])].sort(), ['faculty', 'hod', 'institution_admin', 'library_staff', 'student', 'super_admin'])
  for (const role of ['accounts_staff', 'hostel_staff', 'parent', 'pending'] as const) assert.equal(authorizeRoute(plugin.manifest, r, role), 'deny', role)
})

test('book match returns title data and no borrowers', async () => {
  const c = await campus()
  const other = await campus()
  const algo = await c.book('Introduction to Algorithms', 'Cormen', '9780262033848')
  const dune = await c.book('Dune', 'Frank Herbert')
  await other.book('Introduction to Algorithms', 'Cormen', '9780262033848')

  const byIsbn = (await search(c.as('student'), '978-0-262-03384-8')).hits
  assert.deepEqual(byIsbn.map((h) => h.id), [algo])
  assert.equal(byIsbn[0]!.title, 'Introduction to Algorithms')
  assert.equal(byIsbn[0]!.detail, 'Cormen')
  assert.equal(byIsbn[0]!.href, `/m/library/catalogue?titleId=${encodeURIComponent(algo)}`)
  assert.deepEqual(Object.keys(byIsbn[0]!).sort(), ['detail', 'href', 'id', 'title'])
  assert.deepEqual((await search(c.as('library_staff'), 'algorithms')).hits.map((h) => h.id), [algo])
  assert.deepEqual((await search(c.as('faculty'), 'herbert')).hits.map((h) => h.id), [dune])
  assert.deepEqual((await search(c.as('institution_admin'), 'DUNE')).hits.map((h) => h.id), [dune])
  // Two letters is not a substring search, and wildcards are literal.
  assert.deepEqual((await search(c.as('student'), 'du')).hits, [])
  assert.deepEqual((await search(c.as('student'), 'Intro%')).hits, [])
})

test('other roles, malformed queries and a second q are refused', async () => {
  const c = await campus()
  for (const role of ['accounts_staff', 'hostel_staff', 'parent']) assert.equal(await code(search(c.as(role), 'dune')), 'forbidden', role)
  const ok = c.as('student')
  for (const q of ['', ' ', 'x'.repeat(101), 'a\u0007b']) assert.equal(await code(search(ok, q)), 'invalid_search', JSON.stringify(q))
  assert.equal(await code(search(ok, null)), 'invalid_search')
  assert.equal(await code(search(ok, null, 'http://x/record-search?q=a&q=b')), 'invalid_search')
})
