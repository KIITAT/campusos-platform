import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor } from '@campusos/module-framework'
import { plugin } from './plugin'
import { assignments, stops } from './schema'

const SLUG = 'transport-import'
let tenant: string
let admin: PluginActor

const run = (importId: string, csv: string, apply = true) =>
  plugin.routes
    .find((r) => r.path === '/imports/run')!
    .handler(admin, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId, csv, apply }) })) as Promise<{ created: number; skipped: number }>

before(async () => {
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Transport Import', allowedEmailDomains: [] }).returning()
  tenant = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { institutionId: tenant, email: 'office@transport-import.test', role: 'institution_admin' },
      { institutionId: tenant, email: 'dev@transport-import.test', role: 'student' },
      { institutionId: tenant, email: 'sana@transport-import.test', role: 'student' },
    ])
    .returning()
  admin = { id: people[0]!.id, role: 'institution_admin', institutionId: tenant }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('vehicles, routes, stops and seats arrive from CSV, and a rerun changes nothing', async () => {
  assert.equal((await run('vehicles', 'registration,seats\nka01ab1234,1\nKA02CD5678,40\n')).created, 2)
  assert.equal((await run('routes', 'name,vehicle\nRoute 4: Whitefield,KA01AB1234\n')).created, 1)
  assert.equal((await run('stops', 'route,stop,position\nRoute 4: Whitefield,Hope Farm,1\nroute 4: whitefield,ITPL,2\n')).created, 2)
  assert.equal((await run('seats', 'email,route,stop\ndev@transport-import.test,Route 4: Whitefield,ITPL\n')).created, 1)
  assert.equal((await run('seats', 'email,route,stop\ndev@transport-import.test,Route 4: Whitefield,itpl\n')).skipped, 1)
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(stops))).length, 2)
})

test('a full bus, a stop off the route and a vehicle on two routes are refused', async () => {
  await assert.rejects(run('seats', 'email,route,stop\nsana@transport-import.test,Route 4: Whitefield,Hope Farm\n'), /no seats available/)
  await assert.rejects(run('seats', 'email,route,stop\nsana@transport-import.test,Route 4: Whitefield,Majestic\n'), /has no stop Majestic/)
  await assert.rejects(run('routes', 'name,vehicle\nRoute 9,KA01AB1234\n'), /one route/)
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(assignments))).length, 1)
})
