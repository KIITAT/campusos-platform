import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { listEntries, trialBalance, type Actor as Books } from '@campusos/module-finance/api'
import { feePayments, feeRefunds } from './schema'
import {
  FeeError,
  createFeeItem,
  grantWaiver,
  issueInvoices,
  recordPayment,
  reconcilePayment,
  refundPayment,
  revokeWaiver,
  studentLedger,
  type Actor,
} from './api'

/**
 * What fees says to the books.
 *
 * A fresh institution per test, because a journal cannot be emptied between
 * them: entries are append-only by design, and a test that reached around that
 * to reset would be testing a database this module never runs on.
 */

let n = 0
const SLUG = 'fees-books-'

interface Campus {
  id: string
  admin: Actor
  clerk: Actor
  studentId: string
  termId: string
  programId: string
}

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Books College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'One Student' },
    ])
    .returning({ id: users.id })

  const admin: Actor = {
    id: people[0]!.id,
    email: `adm@${tag}.test`,
    role: 'institution_admin',
    institutionId: id,
  }
  const clerk: Actor = {
    id: people[1]!.id,
    email: `clerk@${tag}.test`,
    role: 'accounts_staff',
    institutionId: id,
  }

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
  const section = await academic.createSection(admin, {
    programId: program.id,
    label: 'a',
    admissionYear: 2026,
  })
  await academic.addSectionMember(admin, { sectionId: section.id, userId: people[2]!.id })

  return {
    id,
    admin,
    clerk,
    studentId: people[2]!.id,
    termId: term.id,
    programId: program.id,
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const charge = (c: Campus, label: string, amount: string) =>
  createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label, amount })

const paid = (c: Campus, amount: string, method = 'upi') =>
  recordPayment(c.clerk, { studentId: c.studentId, termId: c.termId, amount, method })

/** The books, read as the same person, since finance takes its own actor type. */
const books = (c: Campus): Books => c.admin as unknown as Books

/** Balance of one account, positive on its normal side. */
async function balance(c: Campus, code: string): Promise<number> {
  const tb = await trialBalance(books(c))
  return tb.rows.find((r) => r.code === code)?.balancePaise ?? 0
}

const RECEIVABLE = '1100'
const INCOME = '4000'
const WAIVER = '5000'
const BANK = '1010'
const CASH = '1000'

const feeCode = (e: unknown) => (e as FeeError).code

/**
 * Drizzle wraps a driver error in a "Failed query" Error and hangs the real
 * Postgres message off .cause, so a trigger's refusal has to be looked for
 * down the chain rather than on the surface.
 */
const chain = (e: unknown): string => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    text += x.message + String.fromCharCode(10)
  }
  return text
}

// --- issuing ---------------------------------------------------------------

test('issuing a term turns a price list into money owed', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')

  // A charge on its own is a price, and the books have not heard of it.
  assert.equal(await balance(c, INCOME), 0)

  const run = await issueInvoices(c.admin, { termId: c.termId })
  assert.equal(run.issued.length, 1)
  assert.equal(run.issued[0]!.chargedPaise, 45_000_00)

  assert.equal(await balance(c, RECEIVABLE), 45_000_00)
  assert.equal(await balance(c, INCOME), 45_000_00)
  assert.equal((await trialBalance(books(c))).differencePaise, 0)
})

test('a waiver granted before the invoice goes out with it', async () => {
  const c = await campus()
  const item = await charge(c, 'Tuition', '45000')
  await grantWaiver(c.admin, {
    studentId: c.studentId,
    feeItemId: item.id,
    amount: '5000',
    reason: 'merit scholarship',
  })

  await issueInvoices(c.admin, { termId: c.termId })

  // Gross income, the forgiveness visible as its own expense, net receivable.
  assert.equal(await balance(c, INCOME), 45_000_00)
  assert.equal(await balance(c, WAIVER), 5_000_00)
  assert.equal(await balance(c, RECEIVABLE), 40_000_00)
  assert.equal((await listEntries(books(c))).length, 1)
})

test('issuing again charges nobody twice', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })

  const again = await issueInvoices(c.admin, { termId: c.termId })
  assert.equal(again.issued.length, 0)
  assert.equal(again.unchanged, 1)

  assert.equal(await balance(c, RECEIVABLE), 45_000_00)
  assert.equal((await listEntries(books(c))).length, 1)
})

test('a charge added after the invoice goes out on its own entry', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })

  await charge(c, 'Hostel', '20000')
  const supplementary = await issueInvoices(c.admin, { termId: c.termId })

  assert.equal(supplementary.issued.length, 1)
  // Only the difference, not the whole invoice again.
  assert.equal(supplementary.issued[0]!.chargedPaise, 20_000_00)
  assert.equal(supplementary.issued[0]!.version, 2)

  assert.equal(await balance(c, RECEIVABLE), 65_000_00)
  assert.equal(await balance(c, INCOME), 65_000_00)
  assert.equal((await listEntries(books(c))).length, 2)
})

test('a student with nothing charged is not invoiced for nothing', async () => {
  const c = await campus()
  const run = await issueInvoices(c.admin, { termId: c.termId })
  assert.deepEqual([run.issued.length, run.unchanged], [0, 0])
  assert.equal((await listEntries(books(c))).length, 0)
})

// --- waivers after the fact -------------------------------------------------

test('a waiver after the invoice posts the difference, and only the difference', async () => {
  const c = await campus()
  const item = await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })

  await grantWaiver(c.admin, {
    studentId: c.studentId,
    feeItemId: item.id,
    amount: '5000',
    reason: 'hardship, first instalment',
  })
  assert.equal(await balance(c, WAIVER), 5_000_00)
  assert.equal(await balance(c, RECEIVABLE), 40_000_00)

  // Revised upward: three thousand more forgiven, not eight thousand again.
  await grantWaiver(c.admin, {
    studentId: c.studentId,
    feeItemId: item.id,
    amount: '8000',
    reason: 'hardship, revised after the committee met',
  })
  assert.equal(await balance(c, WAIVER), 8_000_00)
  assert.equal(await balance(c, RECEIVABLE), 37_000_00)
  assert.equal((await trialBalance(books(c))).differencePaise, 0)
})

test('revoking a waiver after the invoice puts the debt back', async () => {
  const c = await campus()
  const item = await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const waiver = await grantWaiver(c.admin, {
    studentId: c.studentId,
    feeItemId: item.id,
    amount: '5000',
    reason: 'granted in error',
  })

  await revokeWaiver(c.admin, { waiverId: waiver.id, reason: 'the student was not eligible' })

  assert.equal(await balance(c, WAIVER), 0)
  assert.equal(await balance(c, RECEIVABLE), 45_000_00)
  // Four entries: the invoice, the waiver, its withdrawal -- and nothing else.
  assert.equal((await listEntries(books(c))).length, 3)
})

test('a waiver revoked before the invoice was ever issued posts nothing', async () => {
  const c = await campus()
  const item = await charge(c, 'Tuition', '45000')
  const waiver = await grantWaiver(c.admin, {
    studentId: c.studentId,
    feeItemId: item.id,
    amount: '5000',
    reason: 'granted in error',
  })
  await revokeWaiver(c.admin, { waiverId: waiver.id, reason: 'withdrawn before it went out' })

  assert.equal((await listEntries(books(c))).length, 0)
})

// --- money in ---------------------------------------------------------------

test('a partial payment leaves the books and the student ledger agreeing', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })

  await paid(c, '10000')

  assert.equal(await balance(c, BANK), 10_000_00)
  assert.equal(await balance(c, RECEIVABLE), 35_000_00)

  const l = await studentLedger(c.admin, c.studentId, c.termId)
  assert.equal(l.outstandingPaise, 35_000_00)
  assert.equal(l.outstandingPaise, await balance(c, RECEIVABLE))
})

test('cash lands in cash and a transfer lands in the bank', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })

  await paid(c, '3000', 'cash')
  await paid(c, '7000', 'bank_transfer')

  assert.equal(await balance(c, CASH), 3_000_00)
  assert.equal(await balance(c, BANK), 7_000_00)
  assert.equal(await balance(c, RECEIVABLE), 35_000_00)
})

test('confirming a payment against the bank is not a second entry', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const payment = await paid(c, '10000')

  const before = (await listEntries(books(c))).length
  await reconcilePayment(c.clerk, {
    paymentId: payment.id,
    reason: 'matched against the statement of 12 March',
  })

  assert.equal((await listEntries(books(c))).length, before)
  assert.equal(await balance(c, BANK), 10_000_00)
})

// --- money out --------------------------------------------------------------

test('a refund takes the money back out and the debt back on', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const payment = await paid(c, '10000')

  await refundPayment(c.admin, {
    paymentId: payment.id,
    amount: '4000',
    reason: 'paid twice by the family',
  })

  assert.equal(await balance(c, BANK), 6_000_00)
  assert.equal(await balance(c, RECEIVABLE), 39_000_00)

  const l = await studentLedger(c.admin, c.studentId, c.termId)
  assert.equal(l.paidPaise, 6_000_00)
  assert.equal(l.refundedPaise, 4_000_00)
  assert.equal(l.outstandingPaise, 39_000_00)
  // The payment itself is still on the record, at its original amount.
  assert.equal(l.payments.length, 1)
  assert.equal(l.payments[0]!.amountPaise, 10_000_00)
})

test('a refund can leave by a different route from the one the money arrived on', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const payment = await paid(c, '10000', 'cash')

  await refundPayment(c.admin, {
    paymentId: payment.id,
    amount: '10000',
    method: 'bank_transfer',
    reason: 'returned to the account the family asked for',
  })

  assert.equal(await balance(c, CASH), 10_000_00)
  assert.equal(await balance(c, BANK), -10_000_00)
  assert.equal(await balance(c, RECEIVABLE), 45_000_00)
})

test('more cannot go back than came in', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const payment = await paid(c, '10000')

  await refundPayment(c.admin, {
    paymentId: payment.id,
    amount: '6000',
    reason: 'partial return, agreed with the family',
  })
  await assert.rejects(
    () =>
      refundPayment(c.admin, {
        paymentId: payment.id,
        amount: '5000',
        reason: 'the rest of it, which is more than is left',
      }),
    (e: unknown) => feeCode(e) === 'refund_exceeds_payment',
  )

  assert.equal(await balance(c, BANK), 4_000_00)
})

test('the database refuses an oversized refund even with the app check bypassed', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const payment = await paid(c, '10000')

  await assert.rejects(
    () =>
      withTenant(c.id, (tx) =>
        tx.insert(feeRefunds).values({
          institutionId: c.id,
          paymentId: payment.id,
          amountPaise: 99_999_00,
          method: 'upi',
          reason: 'straight at the table',
        }),
      ),
    (e: unknown) => /would exceed the payment/.test(chain(e)),
  )
})

test('a payment that has been refunded cannot be deleted', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const payment = await paid(c, '10000')
  await refundPayment(c.admin, {
    paymentId: payment.id,
    amount: '1000',
    reason: 'a small correction',
  })

  await assert.rejects(
    () =>
      withTenant(c.id, async (tx) => {
        // The other delete guard wants a reason; this one refuses regardless.
        await tx.execute(sql`select set_config('app.audit_reason', 'tidying up', true)`)
        await tx.delete(feePayments).where(eq(feePayments.id, payment.id))
      }),
    (e: unknown) => /has been refunded cannot be deleted/.test(chain(e)),
  )
})

// --- who may ----------------------------------------------------------------

test('a clerk takes money but does not issue charges or give money back', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')

  await assert.rejects(
    () => issueInvoices(c.clerk, { termId: c.termId }),
    (e: unknown) => (e as FeeError).status === 403,
  )

  await issueInvoices(c.admin, { termId: c.termId })
  const payment = await paid(c, '10000')

  await assert.rejects(
    () =>
      refundPayment(c.clerk, {
        paymentId: payment.id,
        amount: '1000',
        reason: 'not a decision a clerk makes',
      }),
    (e: unknown) => (e as FeeError).status === 403,
  )
})

// --- the whole thing --------------------------------------------------------

test('a term of ordinary fee work leaves the books balanced', async () => {
  const c = await campus()
  const tuition = await charge(c, 'Tuition', '45000')
  await charge(c, 'Hostel', '20000')
  await grantWaiver(c.admin, {
    studentId: c.studentId,
    feeItemId: tuition.id,
    amount: '5000',
    reason: 'merit scholarship',
  })

  await issueInvoices(c.admin, { termId: c.termId })
  const first = await paid(c, '30000')
  await reconcilePayment(c.clerk, {
    paymentId: first.id,
    reason: 'matched against the statement',
  })
  await paid(c, '10000', 'cash')
  await refundPayment(c.admin, {
    paymentId: first.id,
    amount: '2000',
    reason: 'overcharged for the hostel',
  })
  await grantWaiver(c.admin, {
    studentId: c.studentId,
    feeItemId: tuition.id,
    amount: '7000',
    reason: 'scholarship revised by the committee',
  })

  const tb = await trialBalance(books(c))
  assert.equal(tb.differencePaise, 0)

  // 65,000 charged, 7,000 forgiven, 40,000 in, 2,000 back out.
  assert.equal(await balance(c, INCOME), 65_000_00)
  assert.equal(await balance(c, WAIVER), 7_000_00)
  assert.equal(await balance(c, BANK), 28_000_00)
  assert.equal(await balance(c, CASH), 10_000_00)
  assert.equal(await balance(c, RECEIVABLE), 20_000_00)

  // And the student's own ledger says the same number.
  const l = await studentLedger(c.admin, c.studentId, c.termId)
  assert.equal(l.outstandingPaise, 20_000_00)
})
