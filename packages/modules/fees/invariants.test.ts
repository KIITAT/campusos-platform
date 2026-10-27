import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { authDb, institutions, users, verifyChains } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  chargeStudent,
  createFeeItem,
  duesReport,
  grantWaiver,
  issueInvoices,
  recordPayment,
  refundPayment,
  type Actor,
} from './api'

/**
 * The books still add up after everything P0-06 changed (ACC-18, ACC-19,
 * ACC-22, NEW-15): keyed payments and their replays, refunds and their
 * replays, waivers, a manual charge, invoices issued and issued again.
 *
 *   every fees journal entry balances: debits = credits;
 *   the fees receivable control account = the sub-ledger, the sum over the
 *   term's dues roster of payable - paid (paid net of refunds).
 *
 * Nobody here pays more than they owe and no invoice goes down after a
 * payment, so ACC-20's known divergence (P1-03) is out of the picture.
 */

const SLUG = 'fees-invariants'
let inst = ''
const ids: Record<string, string> = {}
let termId = ''
const item: Record<string, string> = {}

const as = (id: string, role: Actor['role'], key?: string): Actor =>
  ({ id, role, institutionId: inst, email: null, ...(key ? { idempotencyKey: key } : {}) }) as Actor
const adm = (key?: string) => as(ids.adm!, 'institution_admin', key)
const clerk = (key?: string) => as(ids.clerk!, 'accounts_staff', key)

async function unbalanced() {
  const r = await authDb.execute<{ ref: string; debit: string; credit: string }>(sql`
    select e.source_ref as ref, sum(l.debit_paise)::text as debit, sum(l.credit_paise)::text as credit
      from finance_journal_entries e join finance_journal_lines l on l.entry_id = e.id
     where e.institution_id = ${inst} and e.source_module = 'fees'
     group by e.id, e.source_ref
    having sum(l.debit_paise) <> sum(l.credit_paise)`)
  return r.rows
}

async function receivable() {
  const r = await authDb.execute<{ balance: string }>(sql`
    select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text as balance
      from finance_journal_lines l
      join finance_journal_entries e on e.id = l.entry_id
      join finance_accounts a on a.id = l.account_id
     where e.institution_id = ${inst} and a.purpose = 'fees_receivable'`)
  return Number(r.rows[0]!.balance)
}

async function subLedger() {
  const dues = await duesReport(clerk(), termId)
  return dues.rows.reduce((n, r) => n + r.payablePaise - r.paidPaise, 0)
}

async function assertBooksAddUp(when: string) {
  assert.deepEqual(await unbalanced(), [], `${when}: every fees entry balances`)
  assert.equal(await receivable(), await subLedger(), `${when}: receivable = sub-ledger`)
}

before(async () => {
  await authDb.delete(institutions).where(inArray(institutions.slug, [SLUG]))
  const [row] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Invariant College', allowedEmailDomains: ['invariants.test'] })
    .returning({ id: institutions.id })
  inst = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@invariants.test', institutionId: inst, role: 'institution_admin' as const, name: 'Adm' },
      { email: 'clerk@invariants.test', institutionId: inst, role: 'accounts_staff' as const, name: 'Clerk' },
      ...['s1', 's2', 's3', 's4'].map((s) => ({ email: `${s}@invariants.test`, institutionId: inst, role: 'student' as const, name: s })),
    ])
    .returning({ id: users.id, email: users.email })
  for (const p of people) ids[p.email!.split('@')[0]!] = p.id

  const dept = await academic.createDepartment(adm(), { code: 'gen', name: 'General' })
  const bt = await academic.createProgram(adm(), { departmentId: dept.id, code: 'BT', name: 'BTech', level: 'undergraduate', durationTerms: 8 })
  const mt = await academic.createProgram(adm(), { departmentId: dept.id, code: 'MT', name: 'MTech', level: 'postgraduate', durationTerms: 4 })
  termId = (await academic.createTerm(adm(), { code: 'AUT26', name: 'Autumn', startsOn: '2026-07-01', endsOn: '2026-12-01' })).id
  const section = await academic.createSection(adm(), { programId: bt.id, label: 'a', admissionYear: 2025 })
  for (const s of ['s1', 's2', 's3', 's4']) await academic.addSectionMember(adm(), { sectionId: section.id, userId: ids[s]! })
  for (const s of ['s1', 's2', 's3']) {
    await academic.declareProgram(adm(), { studentId: ids[s]!, programId: bt.id, declaredOn: '2025-07-01' })
  }
  await academic.declareProgram(adm(), { studentId: ids.s3!, programId: mt.id, declaredOn: '2025-07-01', isPrimary: false })
  // s4 sits in the section and is declared into nothing: not billed.

  item.bt = (await createFeeItem(adm(), { programId: bt.id, termId, label: 'Tuition', amount: '45000' })).id
  item.mt = (await createFeeItem(adm(), { programId: mt.id, termId, label: 'Tuition', amount: '60000' })).id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('the books add up across invoices, waivers, replays and refunds', async () => {
  const key = (name: string) => `${name}-${randomUUID()}`

  const charge = key('charge')
  await chargeStudent(clerk(charge), { studentId: ids.s2!, termId, label: 'Lab breakage', amount: '1200' })
  await chargeStudent(clerk(charge), { studentId: ids.s2!, termId, label: 'Lab breakage', amount: '1200' })
  await issueInvoices(adm(), { termId })
  await assertBooksAddUp('after invoicing')

  await grantWaiver(adm(), { studentId: ids.s1!, feeItemId: item.bt!, amount: '5000', reason: 'merit concession' })
  await assert.rejects(() =>
    grantWaiver(adm(), { studentId: ids.s1!, feeItemId: item.mt!, amount: '5000', reason: 'not their charge' }),
  )
  await assertBooksAddUp('after the waivers')

  const p1 = key('p1')
  const pay1 = await recordPayment(clerk(p1), { studentId: ids.s1!, termId, amount: '20000', method: 'cash' })
  await recordPayment(clerk(p1), { studentId: ids.s1!, termId, amount: '20000', method: 'cash' })
  const pay3 = await recordPayment(clerk(key('p3')), {
    studentId: ids.s3!, termId, amount: '105000', method: 'upi', reference: `UPI${Date.now()}`,
  })
  await recordPayment(clerk(), { studentId: ids.s2!, termId, amount: '10000', method: 'bank_transfer', reference: `UTR${Date.now()}` })
  await assertBooksAddUp('after payments and a replay')

  const r1 = key('r1')
  await refundPayment(adm(r1), { paymentId: pay1.id, amount: '2000', reason: 'paid twice at the counter' })
  await refundPayment(adm(r1), { paymentId: pay1.id, amount: '2000', reason: 'paid twice at the counter' })
  await refundPayment(adm(), { paymentId: pay3.id, amount: '1000', reason: 'transport fee refunded' })
  await assertBooksAddUp('after refunds and a replay')

  // Issued again: nothing changed, so nothing new is posted, and the sums hold.
  await issueInvoices(adm(), { termId })
  await assertBooksAddUp('after invoicing again')

  // The money in the books is what was meant to happen, once each.
  assert.equal(await subLedger(), 4500000 - 500000 - 2000000 + 200000 + (4500000 + 120000 - 1000000) + (10500000 - 10500000 + 100000))
  assert.deepEqual((await verifyChains({ institutionId: inst })).problems, [])
})
