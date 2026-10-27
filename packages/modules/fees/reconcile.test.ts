import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, inArray, sql } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { addBankAccount, claimTransfer, reconcilePayment, recordPayment, verifyClaim, type Actor } from './api'

/**
 * LOW-05, P0-06's part: the trail shows who recorded a payment that is
 * reconciled, and whether the same person did both.
 *
 * Refusing self-reconciliation is segregation of duties, which P0-07 owns
 * with a single-officer mode; until then every case must be findable in the
 * audit trail (decision 191).
 */

const SLUG = 'fees-reconcile'
let inst = ''
const ids = { clerk: '', adm: '', s1: '', term: '', account: '' }

const as = (id: string, role: Actor['role']): Actor => ({ id, role, institutionId: inst, email: null })
const clerk = () => as(ids.clerk, 'accounts_staff')
const adm = () => as(ids.adm, 'institution_admin')

async function reconciledDetail(paymentId: string) {
  const r = await authDb.execute<{ detail: Record<string, unknown> | null }>(sql`
    select detail from audit_log
     where institution_id = ${inst} and action = 'fee.payment_reconciled' and entity_id = ${paymentId}`)
  assert.equal(r.rows.length, 1)
  return r.rows[0]!.detail ?? {}
}

before(async () => {
  await authDb.delete(institutions).where(inArray(institutions.slug, [SLUG]))
  const [row] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Reconcile College', allowedEmailDomains: ['reconcile.test'] })
    .returning({ id: institutions.id })
  inst = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'clerk@reconcile.test', institutionId: inst, role: 'accounts_staff', name: 'Clerk' },
      { email: 'adm@reconcile.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 's1@reconcile.test', institutionId: inst, role: 'student', name: 'One' },
    ])
    .returning({ id: users.id })
  ids.clerk = people[0]!.id
  ids.adm = people[1]!.id
  ids.s1 = people[2]!.id
  ids.term = (await academic.createTerm(adm(), { code: 't1', name: 'Autumn', startsOn: '2026-07-01', endsOn: '2026-12-01' })).id
  ids.account = (
    await addBankAccount(adm(), {
      label: 'Main', accountName: 'Reconcile College', bankName: 'SBI', branch: 'Main',
      accountNumber: '1234567890', ifsc: 'SBIN0001234',
    })
  ).id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('a clerk reconciling their own payment is marked so in the trail', async () => {
  const p = await recordPayment(clerk(), { studentId: ids.s1, termId: ids.term, amount: '1000', method: 'cheque', reference: '000777' })
  await reconcilePayment(clerk(), { paymentId: p.id, reason: 'cleared on the statement' })
  const d = await reconciledDetail(p.id)
  assert.equal(d.recordedBy, ids.clerk)
  assert.equal(d.selfReconciled, true)
})

test('someone else reconciling it is marked not self-reconciled', async () => {
  const p = await recordPayment(clerk(), { studentId: ids.s1, termId: ids.term, amount: '1000', method: 'cheque', reference: '000778' })
  await reconcilePayment(adm(), { paymentId: p.id, reason: 'cleared on the statement' })
  const d = await reconciledDetail(p.id)
  assert.equal(d.recordedBy, ids.clerk)
  assert.equal(d.selfReconciled, false)
})

test('a verified transfer claim, recorded and reconciled in one act, says so', async () => {
  const claim = await claimTransfer(as(ids.s1, 'student'), {
    termId: ids.term, accountId: ids.account, mode: 'neft', remitterBank: 'SBI', accountHolder: 'Parent',
    contactPhone: '9876543210', transferredOn: '2026-07-10', amount: '2000', utr: 'UTRRECONCILE0001',
  })
  await verifyClaim(clerk(), { claimId: claim.id })
  const r = await authDb.execute<{ id: string }>(sql`select payment_id as id from fee_transfer_claims where id = ${claim.id}`)
  const d = await reconciledDetail(r.rows[0]!.id)
  assert.equal(d.recordedBy, ids.clerk)
  assert.equal(d.selfReconciled, true)
})
