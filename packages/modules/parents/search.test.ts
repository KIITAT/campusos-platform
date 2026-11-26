import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import { authorizeRoute } from '@campusos/module-framework'
import { plugin } from './plugin'
import type { Actor } from './api'

/**
 * UX-04 DATA-01, P1-09c: the guardian invitation picks a child by search, so a
 * child beyond the old 2,000-row cap can be chosen.
 */

const SLUG = 'par-search-'
let n = 0

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Parents College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `par@${tag}.test`, institutionId: id, role: 'parent', name: 'Parent' },
    ])
    .returning({ id: users.id, role: users.role })
  const as = (role: string) => ({ id: people.find((p) => p.role === role)!.id, role, institutionId: id }) as Actor
  return { id, tag, admin: as('institution_admin'), parent: as('parent') }
}

const route = () => {
  const r = plugin.routes.find((x) => x.method === 'GET' && x.path === '/student-choices')
  assert.ok(r, 'Parents declares GET /student-choices')
  return r
}
const pick = async (actor: Actor, q: string | null, raw?: string) =>
  (await route().handler(actor as never, new Request(raw ?? `http://x/student-choices${q === null ? '' : `?q=${encodeURIComponent(q)}`}`))) as {
    hits: { id: string; title: string; detail: string | null; href: string | null }[]
  }
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

test('the route is the picker lookup for the administrators only', () => {
  const r = route()
  assert.equal(r.lookup, 'picker')
  assert.deepEqual([...(r.roles ?? [])].sort(), ['institution_admin', 'super_admin'])
  for (const role of ['parent', 'student', 'faculty', 'pending'] as const) assert.equal(authorizeRoute(plugin.manifest, r, role), 'deny', role)
})

test('a child beyond the former cap can be chosen', async () => {
  const c = await campus()
  // 2,000 earlier names, then the one wanted last in name order.
  await authDb.execute(sql`insert into users (id, email, institution_id, role, name)
    select 'bulk-' || ${c.tag} || '-' || g, 'bulk' || g || '@' || ${c.tag} || '.test', ${c.id}, 'student', 'Aaa Bulk ' || lpad(g::text, 5, '0')
    from generate_series(1, 2000) g`)
  const [last] = await authDb
    .insert(users)
    .values({ email: `zed@${c.tag}.test`, institutionId: c.id, role: 'student', name: 'Zzyzx Lastchild' })
    .returning({ id: users.id })
  const hits = (await pick(c.admin, 'zzyzx')).hits
  assert.deepEqual(hits.map((h) => h.id), [last!.id])
  assert.equal(hits[0]!.title, 'Zzyzx Lastchild')
  assert.equal(hits[0]!.href, null)
  assert.equal((await pick(c.admin, 'aaa bulk')).hits.length, 12)
})

test('a guardian, an empty query and a second q are refused', async () => {
  const c = await campus()
  assert.equal(await code(pick(c.parent, 'zed')), 'forbidden')
  for (const q of ['', ' ', 'x'.repeat(101), 'a\u0007b']) assert.equal(await code(pick(c.admin, q)), 'invalid_search', JSON.stringify(q))
  assert.equal(await code(pick(c.admin, null)), 'invalid_search')
  assert.equal(await code(pick(c.admin, null, 'http://x/student-choices?q=a&q=b')), 'invalid_search')
})

test('the guardian page no longer preloads students and its child field is a lookup', async () => {
  const c = await campus()
  const page = (await import('./pages')).pages.find((p) => p.path === '/guardians')!
  const data = (await page.load!(c.admin as never, new Request('http://x/guardians'))) as Record<string, unknown>
  assert.equal('studentOptions' in data, false)
  const form = page.sections(data as never).find((s) => s.kind === 'form' && s.path === '/guardians/invite') as { fields: { name: string; kind?: string; lookup?: { path: string } }[] }
  const child = form.fields.find((f) => f.name === 'studentId')!
  assert.equal(child.kind ?? 'text', 'text')
  assert.deepEqual(child.lookup, { path: '/student-choices' })
})
