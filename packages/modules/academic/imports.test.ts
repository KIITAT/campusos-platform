import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, inArray } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor } from '@campusos/module-framework'
import { plugin } from './plugin'
import { courses, departments, offerings, sectionMembers, sections } from './schema'

const SLUG = 'acad-import'
let tenant: string
let admin: PluginActor

const run = (importId: string, csv: string, apply = true) =>
  plugin.routes
    .find((r) => r.path === '/imports/run')!
    .handler(admin, new Request('http://x/imports/run', { method: 'POST', body: JSON.stringify({ importId, csv, apply }) })) as Promise<{
    created: number
    skipped: number
    applied: boolean
  }>

before(async () => {
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Import College', allowedEmailDomains: [] }).returning()
  tenant = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { institutionId: tenant, email: 'office@import.test', role: 'institution_admin' },
      { institutionId: tenant, email: 'Asha@Import.test', role: 'student' },
      { institutionId: tenant, email: 'rao@import.test', role: 'faculty' },
    ])
    .returning()
  admin = { id: people[0]!.id, role: 'institution_admin', institutionId: tenant }
})

after(async () => {
  await authDb.delete(users).where(eq(users.institutionId, tenant))
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('a college is set up from CSV files, and a second upload changes nothing', async () => {
  // A course can name a department created a few lines up in the same file's run.
  assert.equal((await run('departments', 'code,name\nCSE,Computer Science\nMA,"Mathematics, Pure and Applied"\n')).created, 2)
  assert.equal((await run('programs', 'code,name,department,level,duration_terms\nBTCS,B.Tech CS,CSE,undergraduate,8\n')).created, 1)
  assert.equal((await run('courses', 'Code,Title,Department,Credits\nCS101,Programming,CSE,4\nMA101,Calculus,MA,3\n')).created, 2)
  assert.equal((await run('terms', 'code,name,starts_on,ends_on\nAUT2026,Autumn 2026,2026-07-20,2026-12-05\n')).created, 1)
  assert.equal((await run('rooms', 'code,building,capacity\nCR-101,Main,60\n')).created, 1)
  assert.equal((await run('sections', 'program,admission_year,label\nBTCS,2025,A\n')).created, 1)
  assert.equal((await run('section-members', 'email,program,admission_year,section\nasha@import.test,BTCS,2025,a\n')).created, 1)
  assert.equal((await run('student-programs', 'email,program\nasha@import.test,BTCS\n')).created, 1)
  assert.equal((await run('offerings', 'term,course,program,admission_year,section,teacher_email\nAUT2026,CS101,BTCS,2025,A,rao@import.test\nAUT2026,MA101,BTCS,2025,A,\n')).created, 2)

  const again = await run('departments', 'code,name\ncse,Computer Science\n')
  assert.deepEqual([again.created, again.skipped], [0, 1])
  const members = await withTenant(tenant, (tx) => tx.select().from(sectionMembers))
  assert.equal(members.length, 1)
  const classes = await withTenant(tenant, (tx) => tx.select({ faculty: offerings.facultyUserId }).from(offerings))
  assert.equal(classes.filter((c) => c.faculty).length, 1)
})

test('checking a file writes nothing, and a file with a bad row writes none of it', async () => {
  const checked = await run('courses', 'code,title,department,credits\nPH101,Physics,CSE,3\n', false)
  assert.deepEqual([checked.created, checked.applied], [1, false])
  await assert.rejects(
    run('courses', 'code,title,department,credits\nCH101,Chemistry,CSE,3\nBIO1,Biology,NOPE,3\nEE1,Circuits,CSE,many\n'),
    (e: Error) => /2 rows need fixing.*line 3: no department NOPE; line 4: credits/.test(e.message),
  )
  const codes = await withTenant(tenant, (tx) => tx.select({ code: courses.code }).from(courses).where(inArray(courses.code, ['PH101', 'CH101', 'EE1'])))
  assert.deepEqual(codes, [])
  await assert.rejects(run('section-members', 'email,program,admission_year,section\nrao@import.test,BTCS,2025,A\n'), /only students join a cohort/)
  await assert.rejects(run('section-members', 'email,program,admission_year,section\nnobody@import.test,BTCS,2025,A\n'), /nobody here has the email/)
})

test('only the office imports, and the page lists what the reader may import', async () => {
  const faculty: PluginActor = { ...admin, role: 'faculty' }
  await assert.rejects(
    plugin.routes.find((r) => r.path === '/imports/run')!.handler(faculty, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId: 'courses', csv: 'code\nX\n' }) })),
    /cannot import/,
  )
  const page = plugin.pages!.find((p) => p.path === '/import')!
  assert.equal(page.roles.includes('faculty'), false)
  const listed = (await plugin.routes.find((r) => r.path === '/imports')!.handler(admin, new Request('http://x'))) as { id: string }[]
  assert.deepEqual(listed.map((i) => i.id), ['departments', 'programs', 'courses', 'terms', 'rooms', 'sections', 'section-members', 'student-programs', 'offerings'])
  const [dept] = await withTenant(tenant, (tx) => tx.select().from(departments).where(eq(departments.code, 'MA')))
  assert.equal(dept!.name, 'Mathematics, Pure and Applied')
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(sections))).length, 1)
})
