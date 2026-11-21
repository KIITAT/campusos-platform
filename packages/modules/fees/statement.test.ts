/* eslint-disable @typescript-eslint/no-explicit-any -- exports under test are looked up by name, so a missing one fails as an assertion */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, isNull, like, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { accountFor, closePeriod, createBankAccount } from '@campusos/module-finance/api'
import {
  FeeError,
  addBankAccount,
  claimTransfer,
  createFeeItem,
  issueInvoices,
  receivableReport,
  studentLedger,
  type Actor,
} from './api'
import { feeInvoices, transferClaims } from './schema'

/**
 * Matching the bank statement to reported payments and to the payment
 * reference on our UPI QR (P1-03c).
 */

let n = 0
const SLUG = 'fees-statement-'
const importing = async (name: string) => ((await import('./api')) as Record<string, any>)[name]
const code = (e: unknown) => (e as FeeError).code
const today = () => new Date().toISOString().slice(0, 10)

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Statement University', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `clerk2@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk Two' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'Asha Roy' },
      { email: `s2@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal Khan' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const clerk: Actor = { id: people[1]!.id, email: `clerk@${tag}.test`, role: 'accounts_staff', institutionId: id }
  const clerk2: Actor = { id: people[2]!.id, email: `clerk2@${tag}.test`, role: 'accounts_staff', institutionId: id }
  const asha: Actor = { id: people[3]!.id, role: 'student', institutionId: id }
  const bilal: Actor = { id: people[4]!.id, role: 'student', institutionId: id }
  const a = admin as unknown as academic.Actor
  const dept = await academic.createDepartment(a, { code: 'cse', name: 'CSE' })
  const program = await academic.createProgram(a, { departmentId: dept.id, code: 'btech', name: 'BTech', level: 'undergraduate', durationTerms: 8 })
  const term = await academic.createTerm(a, { code: 't1', name: 'Autumn 2026', startsOn: '2026-07-01', endsOn: '2026-11-30' })
  const section = await academic.createSection(a, { programId: program.id, label: 'a', admissionYear: 2026 })
  await academic.addSectionMember(a, { sectionId: section.id, userId: asha.id })
  await academic.addSectionMember(a, { sectionId: section.id, userId: bilal.id })
  for (const s of [asha, bilal]) await academic.declareProgram(a, { studentId: s.id, programId: program.id, declaredOn: '2025-07-01' })
  await createFeeItem(admin, { programId: program.id, termId: term.id, label: 'Tuition', amount: '2,50,000' })
  await createFeeItem(admin, { programId: program.id, termId: term.id, label: 'Hostel', amount: '47,345' })
  const account = await addBankAccount(admin, {
    label: 'School of Computer Engineering',
    accountName: 'Statement University Fees',
    bankName: 'Indian Bank',
    branch: 'Patia',
    accountNumber: '50245763642',
    ifsc: 'idib000k717',
  })
  await issueInvoices(admin, { termId: term.id })
  return { id, admin, clerk, clerk2, asha, bilal, termId: term.id, accountId: account.id }
}
type Campus = Awaited<ReturnType<typeof campus>>

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

/** The finance bank account that stands for the books' bank account. */
async function bank(c: Campus) {
  const gl = await withTenant(c.id, (tx) => accountFor(tx, c.id, 'bank'))
  const made = await createBankAccount(c.admin as never, { accountId: gl, bankName: 'Indian Bank', accountNumber: '50245763642' })
  return made.id as string
}

interface Line {
  date?: string
  description: string
  reference?: string | null
  deposit?: number
  withdrawal?: number
}
/** Inserts one statement and its lines; returns the line ids in order. */
async function statement(c: Campus, fb: string, lines: Line[]) {
  return withTenant(c.id, async (tx) => {
    const [s] = (
      await tx.execute(sql`insert into finance_bank_statements (institution_id, bank_account_id, file_name, file_sha256, format, line_count)
        values (${c.id}, ${fb}, 'test.csv', ${randomBytes(32).toString('hex')}, 'csv', ${lines.length}) returning id`)
    ).rows as { id: string }[]
    const ids: string[] = []
    let seq = 0
    for (const l of lines) {
      const [r] = (
        await tx.execute(sql`insert into finance_bank_statement_lines
            (institution_id, statement_id, bank_account_id, seq, txn_date, description, reference, deposit_paise, withdrawal_paise)
          values (${c.id}, ${s!.id}, ${fb}, ${++seq}, ${l.date ?? today()}, ${l.description}, ${l.reference ?? null}, ${l.deposit ?? 0}, ${l.withdrawal ?? 0})
          returning id`)
      ).rows as { id: string }[]
      ids.push(r!.id)
    }
    return ids
  })
}
const lineOf = async (c: Campus, id: string) =>
  (await withTenant(c.id, (tx) => tx.execute(sql`select status, matched_line_id from finance_bank_statement_lines where id = ${id}`))).rows[0] as {
    status: string
    matched_line_id: string | null
  }

async function reconciled(c: Campus) {
  const r = await withTenant(c.id, (tx) => receivableReport(tx))
  assert.equal(r.differencePaise, 0)
  assert.equal(r.unattributedPaise, 0)
  assert.equal(r.mismatchCount, 0)
}

const claimUpi = (c: Campus, utr: string, amount = '45,000', over: Record<string, unknown> = {}) =>
  claimTransfer(c.asha, {
    termId: c.termId,
    accountId: c.accountId,
    mode: 'upi',
    remitterBank: 'Axis Bank',
    accountHolder: 'Asha Roy',
    contactPhone: '+91 98765 43210',
    transferredOn: today(),
    amount,
    utr,
    ...over,
  })

const paymentOfClaim = async (c: Campus, claimId: string) => {
  const [cl] = await withTenant(c.id, (tx) => tx.select().from(transferClaims).where(eq(transferClaims.id, claimId)))
  return cl!
}
const paymentRow = async (c: Campus, id: string) =>
  (await withTenant(c.id, (tx) => tx.execute(sql`select method, reference, amount_paise, reconciled_at, student_id, term_id from fee_payments where id = ${id}`))).rows[0] as {
    method: string
    reference: string
    amount_paise: string | number
    reconciled_at: Date | null
    student_id: string
    term_id: string
  }
const entryBankDebitLine = async (c: Campus, paymentId: string) =>
  (
    await withTenant(c.id, (tx) =>
      tx.execute(sql`select l.id from finance_journal_lines l join finance_journal_entries e on e.id = l.entry_id
        where e.source_ref = ${'payment:' + paymentId} and l.debit_paise > 0`),
    )
  ).rows.map((r) => (r as { id: string }).id)

async function referenceOf(c: Campus, studentId: string) {
  const payReference = await importing('payReference')
  const [inv] = await withTenant(c.id, (tx) =>
    tx
      .select({ id: feeInvoices.id })
      .from(feeInvoices)
      .where(and(eq(feeInvoices.studentId, studentId), eq(feeInvoices.termId, c.termId), isNull(feeInvoices.voidedAt))),
  )
  return payReference(inv!.id) as string
}

test('a reported UPI payment found on the statement is verified, receipted once and the line matched', async () => {
  const matchStatement = await importing('matchStatement')
  const c = await campus()
  const fb = await bank(c)
  const cl = await claimUpi(c, '412345678901')
  const [line] = await statement(c, fb, [{ description: 'UPI/412345678901/ASHA ROY/asha@okaxis', deposit: 4_500_000 }])
  const r = await matchStatement(c.clerk)
  assert.equal(r.verified, 1)
  assert.equal(r.receipted, 0)
  const done = await paymentOfClaim(c, cl.id)
  assert.equal(done.status, 'verified')
  const pay = await paymentRow(c, done.paymentId!)
  assert.equal(pay.method, 'upi')
  assert.equal(pay.reference, '412345678901')
  assert.ok(pay.reconciled_at)
  const l = await lineOf(c, line!)
  assert.equal(l.status, 'matched')
  assert.deepEqual([l.matched_line_id], await entryBankDebitLine(c, done.paymentId!))
  await reconciled(c)
  const again = await matchStatement(c.clerk)
  assert.equal(again.verified, 0)
  assert.equal(again.receipted, 0)
  assert.equal((await studentLedger(c.asha, c.asha.id, c.termId)).payments.length, 1)
  const inbox = await withTenant(c.id, (tx) =>
    tx.execute(sql`select title from notifications where user_id = ${c.asha.id} and title = 'Payment received'`),
  )
  assert.equal(inbox.rows.length, 1)
})

test('a payment carrying our reference is receipted without a claim', async () => {
  const matchStatement = await importing('matchStatement')
  const c = await campus()
  const fb = await bank(c)
  const ref = await referenceOf(c, c.asha.id)
  const [line] = await statement(c, fb, [{ description: `UPI/512345678901/FEES ${ref}/payer@okicici`, deposit: 1_000_000 }])
  const r = await matchStatement(c.clerk)
  assert.equal(r.receipted, 1)
  const ledger = await studentLedger(c.asha, c.asha.id, c.termId)
  assert.equal(ledger.payments.length, 1)
  const pay = await paymentRow(c, ledger.payments[0]!.id)
  assert.deepEqual([pay.student_id, pay.term_id, pay.method, pay.reference, Number(pay.amount_paise)], [c.asha.id, c.termId, 'upi', '512345678901', 1_000_000])
  assert.ok(pay.reconciled_at)
  assert.equal((await lineOf(c, line!)).status, 'matched')
  await reconciled(c)
})

test('what cannot be told apart is left for a person', async () => {
  const matchStatement = await importing('matchStatement')
  const c = await campus()
  const fb = await bank(c)
  await claimUpi(c, '612345678901', '5,000')
  await claimUpi(c, '612345678902', '5,000')
  const ref = await referenceOf(c, c.asha.id)
  await statement(c, fb, [
    { description: 'UPI/612345678901/612345678902/BOTH', deposit: 500_000 },
    { description: 'UPI/612345678901/WRONG AMOUNT', deposit: 500_100 },
    { description: 'UPI/712345678999/FEES CF0000000000', deposit: 500_000 },
    { description: `FEES ${ref} NO UTR`, deposit: 500_000 },
  ])
  const r = await matchStatement(c.clerk)
  assert.equal(r.verified + r.receipted, 0)
  assert.equal(r.left, 4)
})

test('the statement is matched once when two people run it at once', async () => {
  const matchStatement = await importing('matchStatement')
  const c = await campus()
  const fb = await bank(c)
  const cl = await claimUpi(c, '412345678901')
  const [line] = await statement(c, fb, [{ description: 'UPI/412345678901/ASHA ROY', deposit: 4_500_000 }])
  let both: Promise<{ verified: number }[]> | undefined
  await authDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'fees.statement:' + fb}, 0))`)
    both = Promise.all([matchStatement(c.clerk), matchStatement(c.clerk2)])
    await new Promise((r) => setTimeout(r, 300))
  })
  const [x, y] = await both!
  assert.equal(x!.verified + y!.verified, 1)
  assert.equal((await studentLedger(c.asha, c.asha.id, c.termId)).payments.length, 1)
  assert.equal((await lineOf(c, line!)).status, 'matched')
  assert.equal((await paymentOfClaim(c, cl.id)).status, 'verified')
})

test('staff receipt a line by hand, once', async () => {
  const receiptLine = await importing('receiptLine')
  const c = await campus()
  const fb = await bank(c)
  const [one, two] = await statement(c, fb, [
    { description: 'NEFT CR-HDFC0000123-HDFCN52026112012345-PARENT', deposit: 2_000_000 },
    { description: 'NEFT CR-HDFC0000123-HDFCN52026112099999-PARENT', deposit: 2_000_000 },
  ])
  const input = { lineId: one, studentId: c.asha.id, termId: c.termId, method: 'bank_transfer', reference: 'HDFCN52026112012345' }
  const made = await receiptLine(c.clerk, input)
  assert.ok(made.receiptNo)
  assert.equal((await lineOf(c, one!)).status, 'matched')
  const ledger = await studentLedger(c.asha, c.asha.id, c.termId)
  assert.ok((await paymentRow(c, ledger.payments[0]!.id)).reconciled_at)
  await reconciled(c)
  await assert.rejects(receiptLine(c.clerk, input), (e) => code(e) === 'line_taken')
  const second = { lineId: two, studentId: c.asha.id, termId: c.termId, method: 'bank_transfer', reference: 'HDFCN52026112099999' }
  const settled = await Promise.allSettled([receiptLine(c.clerk, second), receiptLine(c.clerk2, second)])
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1)
  const lost = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult
  assert.equal(code(lost.reason), 'line_taken')
})

test('receipting a line is refused when it is not ours to receipt', async () => {
  const receiptLine = await importing('receiptLine')
  const matchStatement = await importing('matchStatement')
  const c = await campus()
  const fb = await bank(c)
  const other = (await createBankAccount(c.admin as never, { bankName: 'HDFC Bank', accountNumber: '99887766554' })).id as string
  const [out] = await statement(c, fb, [{ description: 'CHARGES', withdrawal: 500 }])
  const [foreign] = await statement(c, other, [{ description: 'SOMEONE ELSE', deposit: 100_000 }])
  const [waiting] = await statement(c, fb, [{ description: 'UPI/812345678901', reference: '812345678901', deposit: 100_000 }])
  const base = { studentId: c.asha.id, termId: c.termId, method: 'upi', reference: 'ABCDEF123456' }
  await assert.rejects(receiptLine(c.clerk, { ...base, lineId: out }), (e) => code(e) === 'not_a_credit')
  await assert.rejects(receiptLine(c.clerk, { ...base, lineId: foreign }), (e) => code(e) === 'wrong_account')
  await claimUpi(c, '812345678901', '1,000')
  await assert.rejects(receiptLine(c.clerk, { ...base, lineId: waiting, reference: '812345678901' }), (e) => code(e) === 'claim_waiting')
  await assert.rejects(receiptLine(c.asha, { ...base, lineId: waiting }), (e) => code(e) === 'forbidden')
  const fresh = await campus()
  await assert.rejects(matchStatement(fresh.clerk), (e) => code(e) === 'no_statement_account')
})

test('a line the books will not take is skipped, not fatal', async () => {
  const matchStatement = await importing('matchStatement')
  const c = await campus()
  const fb = await bank(c)
  const past = new Date()
  past.setUTCDate(15)
  past.setUTCMonth(past.getUTCMonth() - 2)
  const closed = past.toISOString().slice(0, 10)
  await claimUpi(c, '712345678901', '5,000', { transferredOn: closed })
  await claimUpi(c, '712345678902', '5,000')
  const [old, fresh] = await statement(c, fb, [
    { date: closed, description: 'UPI/712345678901/ASHA', deposit: 500_000 },
    { description: 'UPI/712345678902/ASHA', deposit: 500_000 },
  ])
  await closePeriod(c.admin as never, {
    year: past.getUTCFullYear(),
    month: past.getUTCMonth() + 1,
    override: true,
    overrideReason: 'closed for the statement test',
  })
  const r = await matchStatement(c.clerk)
  assert.equal(r.verified, 1)
  assert.equal(r.skipped.length, 1)
  assert.match(r.skipped[0].reason, /period|closed/i)
  assert.equal((await lineOf(c, fresh!)).status, 'matched')
  assert.equal((await lineOf(c, old!)).status, 'unmatched')
})

test('the statement page lists what is left, with a suggestion for our reference', async () => {
  const { transferPages } = await import('./transfer-pages')
  const page = transferPages.find((p) => p.path === '/statement')!
  const c = await campus()
  const fb = await bank(c)
  const ref = await referenceOf(c, c.asha.id)
  await statement(c, fb, [
    { description: `FEES ${ref} NO UTR`, deposit: 500_000 },
    { description: 'SOMETHING ELSE', deposit: 100_000 },
  ])
  const data = (await page.load!(c.clerk as never, new Request('https://x/m/fees/statement'))) as Record<string, any>
  const hit = data.rows.find((r: { description: string }) => r.description.includes(ref))
  assert.match(hit.suggested, /^CF[0-9A-F]{10} → Asha Roy \(T1\)$/)
  assert.equal(data.rows.find((r: { description: string }) => r.description === 'SOMETHING ELSE').suggested, '')
  assert.equal(data.totals.count, 2)
  const forms = page.sections(data as never).filter((s) => s.kind === 'form') as { path: string }[]
  assert.ok(forms.some((f) => f.path === '/statement/receipt'))
  const fresh = await campus()
  const empty = (await page.load!(fresh.clerk as never, new Request('https://x/m/fees/statement'))) as Record<string, any>
  assert.equal(empty.account, null)
  assert.equal(page.sections(empty as never).length, 1)
})

test('a reference that is only a common word never auto-verifies a claim against someone else’s credit', async () => {
  const matchStatement = await importing('matchStatement')
  const c = await campus()
  const fb = await bank(c)
  const cl = await claimUpi(c, 'TRANSFER', '45,000', { mode: 'neft' })
  const [line] = await statement(c, fb, [{ description: 'NEFT TRANSFER FROM BILAL KHAN FEES', deposit: 4_500_000 }])
  const r = await matchStatement(c.clerk)
  assert.equal(r.verified, 0)
  assert.equal((await paymentOfClaim(c, cl.id)).status, 'pending')
  assert.equal((await lineOf(c, line!)).status, 'unmatched')
  // a real UTR (digits, 10 or more characters) in the description still matches
  const ok = await claimUpi(c, 'SBIN526123456789', '46,000', { mode: 'neft' })
  const [line2] = await statement(c, fb, [{ description: 'NEFT SBIN526123456789 ASHA ROY', deposit: 4_600_000 }])
  assert.equal((await matchStatement(c.clerk)).verified, 1)
  assert.equal((await paymentOfClaim(c, ok.id)).status, 'verified')
  assert.equal((await lineOf(c, line2!)).status, 'matched')
})

test('a statement match is dated by the bank line, and voiding the receipt offers the line again', async () => {
  const matchStatement = await importing('matchStatement')
  const voidPayment = await importing('voidPayment')
  const c = await campus()
  const fb = await bank(c)
  const claimed = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
  const cl = await claimUpi(c, '812345678901', '45,000', { transferredOn: claimed })
  const [line] = await statement(c, fb, [{ description: 'UPI/812345678901/ASHA ROY', deposit: 4_500_000 }])
  assert.equal((await matchStatement(c.clerk)).verified, 1)
  const paymentId = (await paymentOfClaim(c, cl.id)).paymentId!
  const [row] = (await withTenant(c.id, (tx) => tx.execute(sql`select (received_at at time zone 'Asia/Kolkata')::date::text as d from fee_payments where id = ${paymentId}`))).rows as { d: string }[]
  assert.equal(row!.d, today())
  await voidPayment(c.admin, { paymentId, reason: 'entered in error' })
  assert.equal((await lineOf(c, line!)).status, 'unmatched')
})
