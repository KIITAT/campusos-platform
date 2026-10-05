import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, isNull } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor } from '@campusos/module-framework'
import { plugin } from './plugin'
import { allocations, rooms } from './schema'

const SLUG = 'hostel-import'
let tenant: string
let warden: PluginActor

const run = (importId: string, csv: string, apply = true) =>
  plugin.routes
    .find((r) => r.path === '/imports/run')!
    .handler(warden, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId, csv, apply }) })) as Promise<{ created: number; skipped: number }>

before(async () => {
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Hostel Import', allowedEmailDomains: [] }).returning()
  tenant = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { institutionId: tenant, email: 'warden@hostel-import.test', role: 'hostel_staff' },
      { institutionId: tenant, email: 'priya@hostel-import.test', role: 'student' },
      { institutionId: tenant, email: 'zoya@hostel-import.test', role: 'student' },
      { institutionId: tenant, email: 'meera@hostel-import.test', role: 'student' },
    ])
    .returning()
  warden = { id: people[0]!.id, role: 'hostel_staff', institutionId: tenant }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('blocks, rooms and who is in them, from the warden’s register', async () => {
  assert.equal((await run('blocks', 'code,name,kind,warden_email\nGH-1,Gargi Hall,womens,warden@hostel-import.test\n')).created, 1)
  assert.equal((await run('rooms', 'block,number,floor,beds\nGH-1,101,1,2\nGH-1,102,1,1\n')).created, 2)
  const sheet = 'email,block,room\npriya@hostel-import.test,gh-1,101\nzoya@hostel-import.test,GH-1,101\n'
  assert.equal((await run('allocations', sheet)).created, 2)
  assert.equal((await run('allocations', sheet)).skipped, 2)
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(rooms))).length, 2)
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(allocations).where(isNull(allocations.vacatedOn)))).length, 2)
})

test('a full room, a second bed and an unknown room are refused, and nothing of the file is kept', async () => {
  await assert.rejects(run('allocations', 'email,block,room\nmeera@hostel-import.test,GH-1,101\n'), /nothing was imported/)
  await assert.rejects(run('allocations', 'email,block,room\npriya@hostel-import.test,GH-1,102\n'), /already holds a room/)
  await assert.rejects(run('allocations', 'email,block,room\nmeera@hostel-import.test,GH-1,102\nmeera@hostel-import.test,GH-1,999\n'), /no room 999/)
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(allocations))).length, 2)
})
