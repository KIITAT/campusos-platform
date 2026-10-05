import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor } from '@campusos/module-framework'
import { plugin } from './plugin'
import { companies } from './schema'

const SLUG = 'placement-import'
let tenant: string
let admin: PluginActor
let lecturer: PluginActor

const run = (actor: PluginActor, csv: string, apply = true) =>
  plugin.routes
    .find((r) => r.path === '/imports/run')!
    .handler(actor, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId: 'companies', csv, apply }) })) as Promise<{ created: number; skipped: number }>

before(async () => {
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Placement Import', allowedEmailDomains: [] }).returning()
  tenant = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { institutionId: tenant, email: 'office@placement-import.test', role: 'institution_admin' },
      { institutionId: tenant, email: 'rao@placement-import.test', role: 'faculty' },
    ])
    .returning()
  admin = { id: people[0]!.id, role: 'institution_admin', institutionId: tenant }
  lecturer = { id: people[1]!.id, role: 'faculty', institutionId: tenant }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('recruiters are imported by an administrator, not by a lecturer who is not a placement officer', async () => {
  const sheet = 'name,website\nTata Consultancy Services,https://www.tcs.com\nInfosys,\n'
  assert.equal((await run(admin, sheet)).created, 2)
  assert.equal((await run(admin, sheet.replace('Infosys', 'INFOSYS'))).skipped, 2)
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(companies))).length, 2)
  await assert.rejects(run(admin, 'name,website\nAcme,http://acme.example\n'), /HTTPS/)
  await assert.rejects(run(lecturer, 'name\nAcme\n'), /placement officer/)
})
