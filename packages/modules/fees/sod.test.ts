import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { setSingleOfficer } from '@campusos/module-finance/api'
import {
  FeeError,
  createFeeItem,
  issueInvoices,
  reconcilePayment,
  recordPayment,
  refundPayment,
  type Actor,
} from './api'

/**
 * LOW-05, ACC-01 (P0-07): the person who recorded a payment does not confirm
 * it against the bank or refund it, unless single-officer mode is on.
 */

let n = 0
const SLUG = 'fees-sod-'
const RECONCILE = 'you recorded this payment, so someone else must confirm it'
const REFUND = 'you recorded this payment, so someone else must refund it'

interface Campus {
  id: string
  admin: Actor
  admin2: Actor
  clerk: Actor
  clerk2: Actor
  studentId: string
  termId: string
}

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Sod College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `adm2@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm Two' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `clerk2@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk Two' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'One Student' },
    ])
    .returning({ id: users.id })
  const who = (at: number, role: Actor['role']): Actor => ({ id: people[at]!.id, email: `${at}@${tag}.test`, role, institutionId: id })
  const admin = who(0, 'institution_admin')
  const dept = await academic.createDepartment(admin, { code: 'cse', name: 'CSE' })
  const program = await academic.createProgram(admin, { departmentId: dept.id, code: 'btech', name: 'BTech', level: 'undergraduate', durationTerms: 8 })
  const term = await academic.createTerm(admin, { code: 't1', name: 'Sem 1', startsOn: '2026-01-05', endsOn: '2026-05-30' })
  const section = await academic.createSection(admin, { programId: program.id, label: 'a', admissionYear: 2026 })
  await academic.addSectionMember(admin, { sectionId: section.id, userId: people[4]!.id })
  await academic.declareProgram(admin, { studentId: people[4]!.id, programId: program.id, declaredOn: '2025-07-01' })
  await createFeeItem(admin, { programId: program.id, termId: term.id, label: 'Tuition', amount: '45000' })
  await issueInvoices(admin, { termId: term.id })
  return { id, admin, admin2: who(1, 'institution_admin'), clerk: who(2, 'accounts_staff'), clerk2: who(3, 'accounts_staff'), studentId: people[4]!.id, termId: term.id }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const record = (c: Campus, by: Actor) => recordPayment(by, { studentId: c.studentId, termId: c.termId, amount: '10000', method: 'upi' })

async function refused(p: Promise<unknown>, message: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof FeeError, `expected a FeeError, got ${String(e)}`)
    assert.equal(e.code, 'separation_of_duties')
    assert.equal(e.status, 403)
    assert.equal(e.message, message)
    return true
  })
}

const acts = async (c: Campus) =>
  (
    await withTenant(c.id, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.institutionId, c.id), eq(auditLog.action, 'sod.single_officer_used'))),
    )
  ).map((r) => (r.detail as { act: string }).act)

test('the clerk who recorded a payment cannot reconcile it; another clerk can (LOW-05)', async () => {
  const c = await campus()
  const p = await record(c, c.clerk)
  await refused(reconcilePayment(c.clerk, { paymentId: p.id, reason: 'matched against the statement' }), RECONCILE)
  await reconcilePayment(c.clerk2, { paymentId: p.id, reason: 'matched against the statement' })
})

test('the person who recorded a payment cannot refund it; another administrator can', async () => {
  const c = await campus()
  const p = await record(c, c.admin)
  await refused(refundPayment(c.admin, { paymentId: p.id, amount: '1000', reason: 'paid twice by the family' }), REFUND)
  await refundPayment(c.admin2, { paymentId: p.id, amount: '1000', reason: 'paid twice by the family' })
})

test('single-officer mode lets one person do both, and writes the use to the trail', async () => {
  const c = await campus()
  await setSingleOfficer(c.admin, { enabled: true, reason: 'one accountant only' })
  const p = await record(c, c.clerk)
  await reconcilePayment(c.clerk, { paymentId: p.id, reason: 'matched against the statement' })
  const q = await record(c, c.admin)
  await refundPayment(c.admin, { paymentId: q.id, amount: '1000', reason: 'paid twice by the family' })
  assert.deepEqual((await acts(c)).sort(), ['reconcile', 'refund'])
})

test('a payment with no recorder is reconciled by anyone', async () => {
  const c = await campus()
  const p = await record(c, c.clerk)
  await authDb.execute(sql`update fee_payments set recorded_by = null where id = ${p.id}`)
  await reconcilePayment(c.clerk, { paymentId: p.id, reason: 'matched against the statement' })
})
