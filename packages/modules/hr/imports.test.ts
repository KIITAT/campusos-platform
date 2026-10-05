import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor } from '@campusos/module-framework'
import { plugin } from './plugin'
import { staff } from './schema'

const SLUG = 'hr-import'
let tenant: string
let admin: PluginActor
let raoLogin: string

const run = (actor: PluginActor, csv: string, apply = true) =>
  plugin.routes
    .find((r) => r.path === '/imports/run')!
    .handler(actor, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId: 'staff', csv, apply }) })) as Promise<{ created: number; skipped: number }>

before(async () => {
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'HR Import', allowedEmailDomains: [] }).returning()
  tenant = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { institutionId: tenant, email: 'office@hr-import.test', role: 'institution_admin' },
      { institutionId: tenant, email: 'rao@hr-import.test', role: 'faculty' },
    ])
    .returning()
  admin = { id: people[0]!.id, role: 'institution_admin', institutionId: tenant }
  raoLogin = people[1]!.id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

const SHEET =
  'employee_code,name,designation,department,employment,joined_on,email\n' +
  'EMP-1,Dr Anita Rao,Assistant Professor,CSE,permanent,2019-07-01,RAO@hr-import.test\n' +
  'EMP-2,"Menon, Ravi",Warden,Hostel,contract,2022-01-10,\n'

test('the staff register is imported, joined to logins by email, and a rerun changes nothing', async () => {
  assert.equal((await run(admin, SHEET)).created, 2)
  assert.equal((await run(admin, SHEET)).skipped, 2)
  const rows = await withTenant(tenant, (tx) => tx.select().from(staff))
  assert.equal(rows.find((r) => r.employeeCode === 'EMP-1')!.userId, raoLogin)
  assert.equal(rows.find((r) => r.employeeCode === 'EMP-2')!.name, 'Menon, Ravi')
})

test('a bad date or employment kind, a login already on the register, or a faculty uploader is refused', async () => {
  await assert.rejects(run(admin, 'employee_code,name,designation,joined_on,employment\nEMP-3,X,Clerk,yesterday,\nEMP-4,Y,Clerk,2020-01-01,forever\n'), /2 rows need fixing/)
  await assert.rejects(run(admin, 'employee_code,name,designation,joined_on,email\nEMP-5,Z,Clerk,2020-01-01,rao@hr-import.test\n'), /already has staff record EMP-1/)
  await assert.rejects(run({ ...admin, role: 'faculty' }, SHEET), /cannot import/)
})
