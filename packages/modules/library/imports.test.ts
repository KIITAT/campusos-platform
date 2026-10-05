import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor } from '@campusos/module-framework'
import { plugin } from './plugin'
import { copies, titles } from './schema'

const SLUG = 'lib-import'
let tenant: string
let librarian: PluginActor

const run = (actor: PluginActor, csv: string, apply = true) =>
  plugin.routes
    .find((r) => r.path === '/imports/run')!
    .handler(actor, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId: 'copies', csv, apply }) })) as Promise<{ created: number; skipped: number }>

before(async () => {
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Library Import', allowedEmailDomains: [] }).returning()
  tenant = row!.id
  const [person] = await authDb.insert(users).values({ institutionId: tenant, email: 'desk@lib-import.test', role: 'library_staff' }).returning()
  librarian = { id: person!.id, role: 'library_staff', institutionId: tenant }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

const REGISTER =
  'accession_no,title,author,isbn,publisher,year,shelf,replacement\n' +
  'ACC-1,Introduction to Algorithms,"Cormen, Thomas",978-0262046305,MIT Press,2022,CS-3,4500\n' +
  'ACC-2,Introduction to Algorithms,"Cormen, Thomas",9780262046305,MIT Press,2022,CS-3,4500\n' +
  'ACC-3,Godan,Premchand,,,1936,HI-1,\n'

test('an accession register becomes titles and their copies, and a rerun adds nothing', async () => {
  assert.equal((await run(librarian, REGISTER)).created, 3)
  assert.equal((await run(librarian, REGISTER)).skipped, 3)
  const books = await withTenant(tenant, (tx) => tx.select().from(titles))
  assert.deepEqual(books.map((b) => b.title).sort(), ['Godan', 'Introduction to Algorithms'])
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(copies))).length, 3)
})

test('a copy the form would refuse is refused here, and a student cannot catalogue', async () => {
  await assert.rejects(run(librarian, 'accession_no,title,author,year\nACC-9,Old Book,Anon,1066\n'), /line 2: year/)
  await assert.rejects(run({ ...librarian, role: 'student' }, REGISTER), /cannot import/)
})
