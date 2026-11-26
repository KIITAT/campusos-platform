import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import { authorizeRoute } from '@campusos/module-framework'
import { plugin } from './plugin'
import { setStudentProfile, type Actor } from './api'

/**
 * UX-04, P1-09c: finding a student by roll, registration or name through the
 * ordinary GET /record-search route, under the same roles and tenant isolation
 * as every other Academic route.
 */

const SLUG = 'acad-search-'
let n = 0

type Hit = { id: string; title: string; detail: string | null; href: string | null }

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Search College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Office' },
      { email: `t@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Rao' },
      { email: `h@${tag}.test`, institutionId: id, role: 'hod', name: 'Head' },
      { email: `a@${tag}.test`, institutionId: id, role: 'student', name: 'Asha Verma' },
      { email: `b@${tag}.test`, institutionId: id, role: 'student', name: 'Room 7 Bilal' },
      { email: `p@${tag}.test`, institutionId: id, role: 'pending', name: 'Pending' },
    ])
    .returning({ id: users.id })
  const [adm, t, h, asha, bilal, pending] = people.map((p) => p.id) as [string, string, string, string, string, string]
  const actor = (uid: string, role: string) => ({ id: uid, role, institutionId: id }) as Actor
  const admin = actor(adm, 'institution_admin')
  const student = async (name: string | null, email: string, extra: Partial<typeof users.$inferInsert> = {}) => {
    const [u] = await authDb
      .insert(users)
      .values({ email: `${email}@${tag}.test`, institutionId: id, role: 'student', name, ...extra })
      .returning({ id: users.id })
    return u!.id
  }
  return {
    id,
    tag,
    admin,
    teacher: actor(t, 'faculty'),
    hod: actor(h, 'hod'),
    asha: actor(asha, 'student'),
    pending: actor(pending, 'pending'),
    ashaId: asha,
    bilalId: bilal,
    student,
  }
}

const route = () => {
  const r = plugin.routes.find((x) => x.method === 'GET' && x.path === '/record-search')
  assert.ok(r, 'Academic declares GET /record-search')
  return r
}

async function search(actor: Actor, q: string | null, raw?: string): Promise<{ hits: Hit[] }> {
  const url = raw ?? `http://x/record-search${q === null ? '' : `?q=${encodeURIComponent(q)}`}`
  return (await route().handler(actor as never, new Request(url))) as { hits: Hit[] }
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

test('the route is declared as the global lookup for admins only', () => {
  const r = route()
  assert.equal(r.lookup, 'global')
  assert.deepEqual([...(r.roles ?? [])].sort(), ['institution_admin', 'super_admin'])
  for (const role of ['faculty', 'hod', 'student', 'parent', 'pending', 'accounts_staff'] as const)
    assert.equal(authorizeRoute(plugin.manifest, r, role), 'deny', role)
})

test('a one-character roll finds the exact pupil', async () => {
  const c = await campus()
  const other = await campus()
  await setStudentProfile(c.admin, { studentId: c.ashaId, rollNo: '7', registrationNo: 'REG/2026/0007' })
  const otherAsha = await other.student('Another Seven', 'x')
  await setStudentProfile(other.admin, { studentId: otherAsha, rollNo: '7' })
  const erased = await c.student('Erased Pupil', 'e', { erasedAt: new Date() })

  const found = await search(c.admin, '7')
  // The exact roll leads; the name that merely contains 7 follows, tenant B and the erased pupil are absent.
  assert.equal(found.hits[0]?.id, c.ashaId)
  assert.equal(found.hits[0]?.title, 'Asha Verma')
  assert.equal(found.hits[0]?.detail, 'Roll 7')
  assert.equal(found.hits[0]?.href, `/m/academic/record?studentId=${encodeURIComponent(c.ashaId)}`)
  assert.ok(!found.hits.some((h) => h.id === otherAsha || h.id === erased))
  assert.deepEqual(Object.keys(found.hits[0]!).sort(), ['detail', 'href', 'id', 'title'])
})

test('registration is matched without regard to case, and names by exact or literal substring', async () => {
  const c = await campus()
  await setStudentProfile(c.admin, { studentId: c.ashaId, rollNo: 'A-12', registrationNo: 'Reg/26/0042' })
  assert.deepEqual((await search(c.admin, 'reg/26/0042')).hits.map((h) => h.id), [c.ashaId])
  assert.equal((await search(c.admin, 'a-12')).hits[0]?.detail, 'Roll A-12')
  // Exact name needs no trigram; a two-letter fragment is not a substring search.
  assert.deepEqual((await search(c.admin, 'asha verma')).hits.map((h) => h.id), [c.ashaId])
  assert.deepEqual((await search(c.admin, 'sh')).hits, [])
  // Three letters or more is a literal contains.
  assert.deepEqual((await search(c.admin, 'verm')).hits.map((h) => h.id), [c.ashaId])
})

test('an Indic name is found, and wildcard characters are literal', async () => {
  const c = await campus()
  const indic = await c.student('आशा शर्मा', 'indic')
  const plain = await c.student('Ashaxyz', 'plain')
  const literal = await c.student('Asha%_!x', 'literal')
  assert.deepEqual((await search(c.admin, 'शर्मा')).hits.map((h) => h.id), [indic])
  const hits = (await search(c.admin, 'Asha%_!')).hits.map((h) => h.id)
  assert.deepEqual(hits, [literal])
  assert.ok(!hits.includes(plain))
})

test('twenty matches come back as twelve, in a stable order', async () => {
  const c = await campus()
  for (let i = 0; i < 20; i++) await c.student(`Matchname ${String(i).padStart(2, '0')}`, `m${i}`)
  const one = (await search(c.admin, 'matchname')).hits
  const two = (await search(c.admin, 'matchname')).hits
  assert.equal(one.length, 12)
  assert.deepEqual(one, two)
  assert.deepEqual(
    one.map((h) => h.title),
    [...one.map((h) => h.title)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
  )
})

test('only the office may call it, and a bad query is refused', async () => {
  const c = await campus()
  for (const who of [c.teacher, c.hod, c.asha, c.pending]) assert.equal(await code(search(who, 'asha')), 'forbidden', who.role)
  for (const q of ['', '   ', 'x'.repeat(101), 'bad\u0007char', 'a\u0000b']) assert.equal(await code(search(c.admin, q)), 'invalid_search', JSON.stringify(q))
  assert.equal(await code(search(c.admin, null)), 'invalid_search')
  assert.equal(await code(search(c.admin, null, 'http://x/record-search?q=a&q=b')), 'invalid_search')
  // 100 code points, even astral ones, is allowed.
  assert.equal(await code(search(c.admin, '𝔸'.repeat(100))), 'resolved')
})
