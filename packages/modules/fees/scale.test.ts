import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { setSingleOfficer } from '@campusos/module-finance/api'
import { createFeeItem, duesPage, duesReport, issueInvoices, receivableReport, type Actor } from './api'

/**
 * Opt-in (FEES_SCALE=1): the REL-09 acceptance. Thirty thousand postings take
 * minutes, so this does not run in every gate.
 */

let n = 0
const SLUG = 'fees-scale-'

interface Campus {
  id: string
  admin: Actor
  clerk: Actor
  termId: string
  programId: string
}

async function campus(students = 30_000): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Scale College', allowedEmailDomains: [`${tag}.test`] })
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

test('30,000 students invoice in under ten minutes, 500 to a transaction', { skip: process.env.FEES_SCALE !== '1', timeout: 3_600_000 }, async () => {
  const c = await campus()
  await createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label: 'Tuition', amount: '45000' })
  await authDb.execute(sql`analyze users`)
  await authDb.execute(sql`analyze academic_student_programs`)

  const t0 = Date.now()
  const r = await issueInvoices(c.admin, { termId: c.termId })
  const issueMs = Date.now() - t0
  console.log(`issue 30,000: ${issueMs} ms in ${r.chunks} chunks`)
  assert.ok(issueMs < 600_000)
  assert.equal(r.chunks, 60)
  assert.equal(r.issued.length, 30_000)

  await authDb.execute(sql`analyze fee_invoices`)
  await authDb.execute(sql`analyze finance_journal_lines`)

  const page = () => duesReport(c.clerk, c.termId, duesPage(new Request('https://x/?n=50'), ''))
  await page()
  const t1 = Date.now()
  await page()
  const duesMs = Date.now() - t1
  console.log(`first dues page: ${duesMs} ms`)
  assert.ok(duesMs < 2_000)

  const t2 = Date.now()
  const rec = await withTenant(c.id, (tx) => receivableReport(tx))
  const recMs = Date.now() - t2
  console.log(`receivableReport: ${recMs} ms`)
  assert.ok(recMs < 10_000)
  assert.equal(rec.differencePaise, 0)
})
