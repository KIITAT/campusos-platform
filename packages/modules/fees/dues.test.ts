import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { setSingleOfficer } from '@campusos/module-finance/api'
import { createFeeItem, duesPage, duesReport, invoicePage, issueInvoices, listInvoices, type Actor } from './api'
import { manifest } from './manifest'
import { pages } from './pages'

/**
 * A term of 1,205 students, seeded by SQL, so that paging and chunking are
 * exercised at a size where a per-student loop would show (REL-09, LOW-04).
 */

let n = 0
const SLUG = 'fees-dues-'

interface Campus {
  id: string
  admin: Actor
  clerk: Actor
  termId: string
  programId: string
}

async function campus(students = 1205): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Dues College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const clerk: Actor = { id: people[1]!.id, email: `clerk@${tag}.test`, role: 'accounts_staff', institutionId: id }

  const dept = await academic.createDepartment(admin, { code: 'cse', name: 'CSE' })
  const program = await academic.createProgram(admin, {
    departmentId: dept.id,
    code: 'btech',
    name: 'BTech',
    level: 'undergraduate',
    durationTerms: 8,
  })
  const term = await academic.createTerm(admin, { code: 't1', name: 'Sem 1', startsOn: '2026-01-05', endsOn: '2026-05-30' })

  await authDb.execute(sql`insert into users (id, email, institution_id, role, name)
    select gen_random_uuid()::text, 'd' || g || '@' || ${tag} || '.test', ${id}::uuid, 'student', 'Student ' || lpad(g::text, 5, '0')
      from generate_series(1, ${students}::int) g`)
  await authDb.execute(sql`insert into academic_student_programs (institution_id, student_id, program_id, declared_on)
    select ${id}::uuid, u.id, ${program.id}::uuid, '2025-07-01' from users u where u.institution_id = ${id}::uuid and u.role = 'student'`)

  await setSingleOfficer(admin, { enabled: true, reason: 'test fixture: one officer' })

  return { id, admin, clerk, termId: term.id, programId: program.id }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const item = (c: Campus, label: string, amount: string) =>
  createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label, amount })

test('the dues report pages every student exactly once (REL-09)', async () => {
  const c = await campus()
  await item(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })

  const seen = new Set<string>()
  let next: string | null = null
  let first: Awaited<ReturnType<typeof duesReport>> | null = null
  do {
    const url: string = `https://x/?n=500${next ? `&after=${next}` : ''}`
    const r: Awaited<ReturnType<typeof duesReport>> = await duesReport(c.clerk, c.termId, duesPage(new Request(url), ''))
    first ??= r
    assert.equal(r.total, 1205)
    for (const row of r.rows) seen.add(row.studentId)
    next = r.next
  } while (next)

  assert.equal(seen.size, 1205)
  assert.equal(first!.totalOutstandingPaise, 1205 * 4_500_000)
  assert.equal(first!.defaulterCount, 1205)
})

test('the dues report shows what is not yet invoiced', async () => {
  const c = await campus()
  await item(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  await item(c, 'Library', '2000')

  const r = await duesReport(c.clerk, c.termId, duesPage(new Request('https://x/?n=50'), ''))
  assert.equal(r.notYetInvoicedCount, 1205)
  assert.equal(r.notYetInvoicedPaise, 1205 * 200_000)
  assert.ok(r.rows.length > 0)
  for (const row of r.rows) assert.equal(row.notYetInvoicedPaise, 200_000)
})

test('the head of department is not offered a report they cannot open (LOW-01)', () => {
  const entry = manifest.navEntries!.find((e) => e.label === 'Dues')!
  assert.deepEqual(entry.roles, ['institution_admin', 'accounts_staff'])
  assert.ok(!pages.find((p) => p.path === '/dues')!.roles.includes('hod'))
})

test('the invoice list pages (LOW-04)', async () => {
  const c = await campus()
  await item(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })

  const r = await listInvoices(c.clerk, c.termId, invoicePage(new Request('https://x/?n=500'), ''))
  assert.equal(r.rows.length, 500)
  assert.equal(r.total, 1205)
  assert.notEqual(r.next, null)
})
