import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import { authorizeRoute } from '@campusos/module-framework'
import { createTerm, listYears, setCurrentTerm, type Actor } from './api'
import { plugin } from './plugin'

/** P2-23 (W5): the terms an institution keeps, as the desktop's year selector reads them. */

const SLUG = 'acad-years-'
after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('years lists terms newest first and marks the current one', async () => {
  const [i] = await authDb.insert(institutions).values({ slug: `${SLUG}a`, name: 'Years', allowedEmailDomains: ['years.test'] }).returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@years.test', institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: 'stu@years.test', institutionId: id, role: 'student', name: 'Stu' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: people[0]!.id, email: 'adm@years.test', role: 'institution_admin', institutionId: id }
  const student: Actor = { id: people[1]!.id, email: 'stu@years.test', role: 'student', institutionId: id }
  const older = (await createTerm(admin, { code: 'T2025', name: 'Year 2025-26', startsOn: '2025-07-01', endsOn: '2026-03-31' })) as { id: string }
  const newer = (await createTerm(admin, { code: 'T2026', name: 'Year 2026-27', startsOn: '2026-07-01', endsOn: '2027-03-31' })) as { id: string }
  await setCurrentTerm(admin, { termId: newer.id })

  const route = plugin.routes.find((r) => r.method === 'GET' && r.path === '/years')!
  const rows = (await route.handler(student, new Request('http://x/years'))) as { id: string; label: string; current: boolean }[]
  assert.deepEqual(rows, [
    { id: newer.id, label: 'Year 2026-27', current: true },
    { id: older.id, label: 'Year 2025-26', current: false },
  ])
  assert.equal(authorizeRoute(plugin.manifest, route, 'student'), 'allow')
  assert.equal(authorizeRoute(plugin.manifest, route, 'parent'), 'deny')
  assert.deepEqual(plugin.manifest.academicYears, { route: '/years' })
})

test('listYears keeps its own role check for in-process callers', async () => {
  const [i] = await authDb.insert(institutions).values({ slug: `${SLUG}b`, name: 'Years B', allowedEmailDomains: ['yearsb.test'] }).returning({ id: institutions.id })
  const parent: Actor = { id: 'p', email: 'p@yearsb.test', role: 'parent', institutionId: i!.id }
  await assert.rejects(() => listYears(parent), { status: 403 })
})
