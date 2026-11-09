import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { postWithin, setSingleOfficer, trialBalance, type Actor as Books } from '@campusos/module-finance/api'
import {
  awardScholarship,
  checkReceivable,
  createFeeItem,
  createScholarship,
  grantWaiver,
  issueInvoices,
  receivableReport,
  recordPayment,
  refundPayment,
  revokeWaiver,
  studentLedger,
  type Actor,
} from './api'
import { plugin } from './plugin'

/**
 * The student ledger is what the books were told (ACC-20, decision 526), and
 * the ledgers add up to the fees receivable account.
 */

let n = 0
const SLUG = 'fees-subledger-'

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
    .values({ slug: tag, name: 'Subledger College', allowedEmailDomains: [`${tag}.test`] })
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

const charge = (c: Campus, label: string, amount: string) =>
  createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label, amount })

const books = (c: Campus): Books => c.admin as unknown as Books

async function balance(c: Campus, code: string): Promise<number> {
  const tb = await trialBalance(books(c))
  return tb.rows.find((r) => r.code === code)?.balancePaise ?? 0
}

const RECEIVABLE = '1100'

test('a charge added after the invoice is not owed until it is issued', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  await charge(c, 'Library', '2000')

  let l = await studentLedger(c.admin, c.s1, c.termId)
  assert.equal(l.chargedPaise, 4_500_000)
  assert.equal(l.outstandingPaise, 4_500_000)
  assert.equal(l.notYetInvoicedPaise, 200_000)
  assert.equal(l.lines.length, 2)

  await issueInvoices(c.admin, { termId: c.termId })
  l = await studentLedger(c.admin, c.s1, c.termId)
  assert.equal(l.chargedPaise, 4_700_000)
  assert.equal(l.notYetInvoicedPaise, 0)
})

test('a credit larger than the bill is shown, not hidden', async () => {
  const c = await campus()
  const rule = await createScholarship(c.admin, {
    code: 'BIG',
    name: 'Large award',
    kind: 'merit',
    basis: 'fixed',
    amountPaise: '10000',
  })
  await charge(c, 'Tuition', '5000')
  await issueInvoices(c.admin, { termId: c.termId })
  await awardScholarship(c.admin, { scholarshipId: rule.id, studentId: c.s1, termId: c.termId })

  const l = await studentLedger(c.admin, c.s1, c.termId)
  assert.equal(l.payablePaise, -500_000)
  assert.equal(l.balancePaise, -500_000)
  assert.equal(l.outstandingPaise, 0)
  assert.equal(l.overpaidPaise, 500_000)
})

test('nothing is owed before the term is issued', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')

  const l = await studentLedger(c.admin, c.s1, c.termId)
  assert.equal(l.chargedPaise, 0)
  assert.equal(l.outstandingPaise, 0)
  assert.equal(l.notYetInvoicedPaise, 4_500_000)
})

/** The scenario the ledgers and the books must agree on. */
async function ordinaryWork(c: Campus) {
  const item = await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const waiver = await grantWaiver(c.admin, { studentId: c.s1, feeItemId: item.id, amount: '5000', reason: 'hardship after the invoice' })
  const pay = await recordPayment(c.clerk, {
    studentId: c.s1,
    termId: c.termId,
    amount: '20000',
    method: 'upi',
    reference: `UTR${Date.now()}`,
  })
  await refundPayment(c.admin, { paymentId: pay.id, amount: '2000', reason: 'paid twice at the counter' })
  await recordPayment(c.clerk, { studentId: c.s2, termId: c.termId, amount: '50000', method: 'cash' })
  return { waiver }
}

test('the student ledgers add up to the receivable', async () => {
  const c = await campus()
  await ordinaryWork(c)

  const a = await studentLedger(c.admin, c.s1, c.termId)
  const b = await studentLedger(c.admin, c.s2, c.termId)
  assert.equal(a.balancePaise + b.balancePaise, await balance(c, RECEIVABLE))
  assert.equal(b.overpaidPaise, 500_000)
})

// --- the reconciliation and the nightly check ---------------------------------

test('the reconciliation agrees after ordinary fee work', async () => {
  const c = await campus()
  const { waiver } = await ordinaryWork(c)
  const rule = await createScholarship(c.admin, {
    code: 'MERIT',
    name: 'Merit',
    kind: 'merit',
    basis: 'fixed',
    amountPaise: '1000',
  })
  await awardScholarship(c.admin, { scholarshipId: rule.id, studentId: c.s1, termId: c.termId })
  await revokeWaiver(c.admin, { waiverId: waiver.id, reason: 'granted in error' })

  const r = await withTenant(c.id, (tx) => receivableReport(tx))
  assert.equal(r.differencePaise, 0)
  assert.equal(r.unattributedPaise, 0)
  assert.equal(r.mismatchCount, 0)
  assert.equal(r.booksPaise, await balance(c, RECEIVABLE))
})

test('a waiver that rode in the invoice and was then revoked still belongs to its student', async () => {
  const c = await campus()
  const item = await charge(c, 'Tuition', '45000')
  const waiver = await grantWaiver(c.admin, { studentId: c.s1, feeItemId: item.id, amount: '5000', reason: 'hardship before the invoice' })
  await issueInvoices(c.admin, { termId: c.termId })
  await revokeWaiver(c.admin, { waiverId: waiver.id, reason: 'granted in error' })

  const r = await withTenant(c.id, (tx) => receivableReport(tx))
  assert.equal(r.differencePaise, 0)
  assert.equal(r.unattributedPaise, 0)
  assert.equal(r.mismatchCount, 0)
})

/** A journal straight to the receivable, which no fee document explains. */
const handAdjustment = (c: Campus) =>
  withTenant(c.id, (tx) =>
    postWithin(tx, c.id, c.admin.id, {
      memo: 'hand adjustment',
      sourceModule: 'finance',
      sourceRef: `test:${randomUUID()}`,
      lines: [
        { purpose: 'fees_receivable', debitPaise: 10_000 },
        { purpose: 'cash', creditPaise: 10_000 },
      ],
    }),
  )

test('a journal straight to the receivable is caught and named unattributed', async () => {
  const c = await campus()
  await ordinaryWork(c)
  await handAdjustment(c)

  const r = await withTenant(c.id, (tx) => receivableReport(tx))
  assert.equal(r.differencePaise, 10_000)
  assert.equal(r.unattributedPaise, 10_000)
  assert.equal(r.mismatchCount, 0)
})

test('the nightly check tells the office when the books disagree', async () => {
  const c = await campus()
  await ordinaryWork(c)
  await handAdjustment(c)

  const out = await withTenant(c.id, (tx) => checkReceivable(c.admin, tx))
  assert.equal(out.differencePaise, 10_000)
  const mine = async (userId: string) =>
    (await withTenant(c.id, (tx) => tx.execute(sql`select title, link from notifications where user_id = ${userId}`))).rows as {
      title: string
      link: string
    }[]
  for (const who of [c.admin, c.clerk]) {
    const rows = (await mine(who.id)).filter((n) => n.title === 'Fee ledger and books disagree')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.link, '/m/fees/reconciliation')
  }
  const logged = await withTenant(c.id, (tx) =>
    tx.execute(sql`select count(*)::int as n from audit_log where institution_id = ${c.id}::uuid and action = 'fee.receivable_mismatch'`),
  )
  assert.equal((logged.rows[0] as { n: number }).n, 1)

  // A campus whose books agree is left alone.
  const fine = await campus()
  await ordinaryWork(fine)
  const quiet = await withTenant(fine.id, (tx) => checkReceivable(fine.admin, tx))
  assert.equal(quiet.differencePaise, 0)
  assert.equal((await mine(fine.admin.id)).filter((n) => n.title === 'Fee ledger and books disagree').length, 0)
  const none = await withTenant(fine.id, (tx) =>
    tx.execute(sql`select count(*)::int as n from audit_log where institution_id = ${fine.id}::uuid and action = 'fee.receivable_mismatch'`),
  )
  assert.equal((none.rows[0] as { n: number }).n, 0)
})

test('the check is a daily job', () => {
  const job = plugin.jobs?.find((j) => j.kind === 'fees.check-receivable')
  assert.ok(job)
  assert.equal(job.daily, true)
})
