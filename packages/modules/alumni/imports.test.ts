import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor } from '@campusos/module-framework'
import { plugin } from './plugin'
import { profiles } from './schema'

const SLUG = 'alumni-import'
let tenant: string
let admin: PluginActor

const run = (actor: PluginActor, csv: string, apply = true) =>
  plugin.routes
    .find((r) => r.path === '/imports/run')!
    .handler(actor, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId: 'profiles', csv, apply }) })) as Promise<{ created: number; updated: number }>

before(async () => {
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Alumni Import', allowedEmailDomains: [] }).returning()
  tenant = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { institutionId: tenant, email: 'office@alumni-import.test', role: 'institution_admin' },
      { institutionId: tenant, email: 'kavya@alumni-import.test', role: 'student' },
    ])
    .returning()
  admin = { id: people[0]!.id, role: 'institution_admin', institutionId: tenant }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('graduates’ profiles are imported private, and a later file updates them', async () => {
  const sheet = 'email,graduation_year,qualification,employer,contact_email\nkavya@alumni-import.test,2024,B.Tech CS,Infosys,kavya@example.test\n'
  assert.equal((await run(admin, sheet)).created, 1)
  assert.equal((await run(admin, sheet.replace('Infosys', 'Wipro'))).updated, 1)
  const [profile] = await withTenant(tenant, (tx) => tx.select().from(profiles))
  assert.equal(profile!.employer, 'Wipro')
  assert.equal(profile!.publishProfile, false)
  await assert.rejects(run(admin, 'email,graduation_year,qualification\nghost@alumni-import.test,2024,BA\n'), /nobody here has the email/)
})
