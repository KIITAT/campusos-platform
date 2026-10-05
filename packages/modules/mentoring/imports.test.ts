import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, isNull } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor } from '@campusos/module-framework'
import { plugin } from './plugin'
import { assignments } from './schema'

const SLUG = 'mentoring-import'
let tenant: string
let hod: PluginActor

const run = (actor: PluginActor, csv: string, apply = true) =>
  plugin.routes
    .find((r) => r.path === '/imports/run')!
    .handler(actor, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId: 'assignments', csv, apply }) })) as Promise<{ created: number; skipped: number }>

before(async () => {
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Mentoring Import', allowedEmailDomains: [] }).returning()
  tenant = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { institutionId: tenant, email: 'hod@mentoring-import.test', role: 'hod' },
      { institutionId: tenant, email: 'rao@mentoring-import.test', role: 'faculty' },
      { institutionId: tenant, email: 'kumar@mentoring-import.test', role: 'faculty' },
      { institutionId: tenant, email: 'aarav@mentoring-import.test', role: 'student' },
      { institutionId: tenant, email: 'dev@mentoring-import.test', role: 'student' },
    ])
    .returning()
  hod = { id: people[0]!.id, role: 'hod', institutionId: tenant }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('a whole intake is given mentors, and moving one keeps the history', async () => {
  const sheet = 'student_email,mentor_email,co_mentor_email\naarav@mentoring-import.test,rao@mentoring-import.test,\ndev@mentoring-import.test,rao@mentoring-import.test,kumar@mentoring-import.test\n'
  assert.equal((await run(hod, sheet)).created, 2)
  assert.equal((await run(hod, sheet)).skipped, 2)
  assert.equal((await run(hod, 'student_email,mentor_email\naarav@mentoring-import.test,kumar@mentoring-import.test\n')).created, 1)
  const all = await withTenant(tenant, (tx) => tx.select().from(assignments))
  assert.equal(all.length, 3)
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(assignments).where(isNull(assignments.toOn)))).length, 2)
  await assert.rejects(run(hod, 'student_email,mentor_email\nrao@mentoring-import.test,kumar@mentoring-import.test\n'), /is not a student/)
  await assert.rejects(run(hod, 'student_email,mentor_email\naarav@mentoring-import.test,dev@mentoring-import.test\n'), /not teaching staff/)
  await assert.rejects(run({ ...hod, role: 'faculty' }, sheet), /cannot import/)
})
