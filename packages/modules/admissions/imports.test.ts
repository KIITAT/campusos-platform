import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor } from '@campusos/module-framework'
import { plugin } from './plugin'
import { enquiries } from './schema'

const SLUG = 'admissions-import'
let tenant: string
let admin: PluginActor

const run = (actor: PluginActor, csv: string, apply = true) =>
  plugin.routes
    .find((r) => r.path === '/imports/run')!
    .handler(actor, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId: 'enquiries', csv, apply }) })) as Promise<{ created: number; skipped: number }>

before(async () => {
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Admissions Import', allowedEmailDomains: [] }).returning()
  tenant = row!.id
  const [person] = await authDb.insert(users).values({ institutionId: tenant, email: 'office@admissions-import.test', role: 'institution_admin' }).returning()
  admin = { id: person!.id, role: 'institution_admin', institutionId: tenant }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('a fair’s sign-up sheet becomes enquiries once, however often it is uploaded', async () => {
  const sheet = 'name,email,phone,note\nRiya Kapoor,riya@example.test,+91 98450 12345,"B.Tech CS, hostel"\nArjun Rao,arjun@example.test,,\n'
  assert.equal((await run(admin, sheet, false)).created, 2)
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(enquiries))).length, 0)
  assert.equal((await run(admin, sheet)).created, 2)
  assert.equal((await run(admin, sheet.replace('riya@', 'RIYA@'))).skipped, 2)
  await assert.rejects(run(admin, 'name,email\nXavier,not-an-email\n'), /line 2: email: Invalid email/)
  await assert.rejects(run({ ...admin, role: 'faculty' }, sheet), /cannot import/)
})
