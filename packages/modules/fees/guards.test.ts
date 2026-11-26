import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { setSingleOfficer } from '@campusos/module-finance/api'
import { createFeeItem, issueInvoices, recordPayment, type Actor } from './api'

/**
 * What the database itself holds about a corrected payment (ACC-23) and the
 * receipt series (ACC-30): a voided or returned payment is final, a receipt's
 * fee breakup never changes, the series is per institution and only moves
 * forward, and a voided invoice frees its student and term.
 */

let n = 0
const SLUG = 'fees-guards-'

interface Campus {
  id: string
  admin: Actor
  clerk: Actor
  s1: string
  s2: string
  termId: string
  programId: string
}

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Guards College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'One Student' },
      { email: `s2@${tag}.test`, institutionId: id, role: 'student', name: 'Two Student' },
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
  const term = await academic.createTerm(admin, {
    code: 't1',
    name: 'Sem 1',
    startsOn: '2026-01-05',
    endsOn: '2026-05-30',
  })
  const section = await academic.createSection(admin, { programId: program.id, label: 'a', admissionYear: 2026 })
  for (const p of [people[2]!, people[3]!]) {
    await academic.addSectionMember(admin, { sectionId: section.id, userId: p.id })
    await academic.declareProgram(admin, { studentId: p.id, programId: program.id, declaredOn: '2025-07-01' })
  }

  await setSingleOfficer(admin, { enabled: true, reason: 'test fixture: one officer' })

  return { id, admin, clerk, s1: people[2]!.id, s2: people[3]!.id, termId: term.id, programId: program.id }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    text += x.message + String.fromCharCode(10)
  }
  return re.test(text)
}

/** A statement as the owner, with an audit reason set, in one transaction. */
const asOwner = (q: ReturnType<typeof sql>) =>
  authDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test', true)`)
    await tx.execute(q)
  })

async function paid(c: Campus) {
  await createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label: 'Tuition', amount: '45000' })
  await issueInvoices(c.admin, { termId: c.termId })
  return recordPayment(c.clerk, { studentId: c.s1, termId: c.termId, amount: '10000', method: 'cash', allowAdvance: true })
}

test('a voided payment cannot be brought back', async () => {
  const c = await campus()
  const p = await paid(c)
  await asOwner(sql`update fee_payments set status = 'voided', voided_at = now(), void_reason = 'test void' where id = ${p.id}`)
  await assert.rejects(
    () => asOwner(sql`update fee_payments set status = 'live', voided_at = null, void_reason = null where id = ${p.id}`),
    saysDb(/a voided or bounced payment is final/),
  )
})

test('a person column clearing on a voided payment still goes through, with the generated receipt key beside it (P1-09c)', async () => {
  const c = await campus()
  const p = await paid(c)
  await asOwner(sql`update fee_payments set status = 'voided', voided_at = now(), void_reason = 'test void' where id = ${p.id}`)
  await asOwner(sql`update fee_payments set recorded_by = null, reconciled_by = null, voided_by = null where id = ${p.id}`)
})

test("a receipt's breakup never changes", async () => {
  const c = await campus()
  const p = await paid(c)
  await assert.rejects(
    () => asOwner(sql`update fee_payments set breakup = '{"heads":[]}'::jsonb where id = ${p.id}`),
    saysDb(/fee breakup is printed and never changes/),
  )
})

test('the receipt series belongs to its institution', async () => {
  const a = await campus()
  const b = await campus()
  await authDb.execute(sql`insert into fee_receipt_series (institution_id, fiscal_year, next) values (${a.id}::uuid, '2627', 5)`)
  const seen = await withTenant(b.id, (tx) => tx.execute(sql`select count(*)::int as n from fee_receipt_series`))
  assert.equal((seen.rows[0] as { n: number }).n, 0)
  await assert.rejects(() =>
    withTenant(b.id, (tx) =>
      tx.execute(sql`insert into fee_receipt_series (institution_id, fiscal_year, next) values (${a.id}::uuid, '2728', 1)`),
    ),
  )
  await assert.rejects(
    () => authDb.execute(sql`update fee_receipt_series set next = 4 where institution_id = ${a.id}::uuid`),
    saysDb(/cannot move backwards/),
  )
})

test('a voided invoice frees the student and term for a new one', async () => {
  const c = await campus()
  await createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label: 'Tuition', amount: '45000' })
  await issueInvoices(c.admin, { termId: c.termId })
  await asOwner(sql`update fee_invoices set voided_at = now(), voided_by = null, void_reason = 'test void' where student_id = ${c.s1}`)
  const insert = () =>
    authDb.execute(
      sql`insert into fee_invoices (institution_id, student_id, term_id, charged_paise) values (${c.id}::uuid, ${c.s1}, ${c.termId}::uuid, 100)`,
    )
  await insert()
  await assert.rejects(insert, saysDb(/fee_invoices_once/))
})
