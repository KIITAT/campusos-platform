import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import { listEntries, trialBalance, type Actor as Books } from '@campusos/module-finance/api'
import {
  addCopies,
  createTitle,
  issue,
  returnCopy,
  setSettings,
  settleFine,
  waiveFine,
  type Actor,
} from './api'

/**
 * What a library fine becomes in money (ACC-27): settled once and then never
 * waived, banked where it actually landed, or moved to the student's fee
 * account; a lost book's replacement cost on the fine; the rules audited
 * (AUD-12); the loan limit held under two desks at once (LOW-10).
 */

let n = 0
const SLUG = 'lib-money-'

interface Desk {
  id: string
  admin: Actor
  desk: Actor
  studentId: string
  facultyId: string
}

async function library(...modules: string[]): Promise<Desk> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Money College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `desk@${tag}.test`, institutionId: id, role: 'library_staff', name: 'Desk' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'One Student' },
      { email: `f1@${tag}.test`, institutionId: id, role: 'faculty', name: 'One Teacher' },
    ])
    .returning({ id: users.id })
  for (const moduleId of modules) {
    await authDb
      .insert(institutionModules)
      .values({ institutionId: id, moduleId, enabled: true })
      .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled: true } })
  }
  // A term running today, in India.
  await withTenant(id, (tx) =>
    tx.execute(sql`insert into academic_terms (institution_id, code, name, starts_on, ends_on)
                   select ${id}, 'T1', 'Sem 1', d - 30, d + 60 from (select (now() at time zone 'Asia/Kolkata')::date as d) x`),
  )
  return {
    id,
    admin: { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id },
    desk: { id: people[1]!.id, email: `desk@${tag}.test`, role: 'library_staff', institutionId: id },
    studentId: people[2]!.id,
    facultyId: people[3]!.id,
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const RULES = {
  loanDays: 14,
  maxConcurrentLoans: 3,
  maxRenewals: 1,
  finePerDay: '2',
  graceDays: 0,
  blockAtOutstanding: '0',
  reason: 'the rules for this test',
}

/** A book lent to `borrower`, returned five days late: a fine of ten rupees. */
async function overdueLoan(d: Desk, borrower = d.studentId, accession = 'A-1') {
  await setSettings(d.desk, RULES)
  const title = await createTitle(d.desk, { title: 'Introduction to Algorithms', author: 'Cormen' })
  const [copy] = await addCopies(d.desk, { titleId: title.id, accessionNos: [accession] })
  const loan = await issue(d.desk, { copyId: copy!.id, borrowerId: borrower })
  await withTenant(d.id, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test backdate', true)`)
    await tx.execute(sql`update library_loans
                            set issued_at = now() - interval '19 days',
                                due_on = date_trunc('day', now() - interval '5 days') + interval '23:59:59.999'
                          where id = ${loan.id}`)
  })
  const back = await returnCopy(d.desk, { copyId: copy!.id })
  return { loanId: loan.id, finePaise: back.finePaise }
}

const books = (d: Desk): Books => d.admin as unknown as Books
const balance = async (d: Desk, code: string) =>
  (await trialBalance(books(d))).rows.find((r) => r.code === code)?.balancePaise ?? 0
const code = (e: unknown) => (e as { code?: string }).code

test('a settled fine cannot be waived, by the app or the database (ACC-27)', async () => {
  const d = await library('finance')
  const { loanId } = await overdueLoan(d)
  await settleFine(d.desk, { loanId })
  await assert.rejects(waiveFine(d.admin, { loanId, amount: '10', reason: 'after the money was banked' }), (e) => code(e) === 'already_settled')
  await assert.rejects(
    withTenant(d.id, async (tx) => {
      await tx.execute(sql`select set_config('app.audit_reason', 'bypassing the app', true)`)
      await tx.execute(sql`update library_loans set fine_waived_paise = 100, fine_waiver_reason = 'bypassing the app' where id = ${loanId}`)
    }),
    (e: unknown) => /settled/.test(String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message)),
  )
})

test('UPI and bank transfer land in the bank, cash in cash (ACC-27)', async () => {
  const d = await library('finance')
  const { loanId } = await overdueLoan(d)
  const row = await settleFine(d.desk, { loanId, method: 'upi' })
  assert.equal(row.fineSettledBy, 'upi')
  assert.equal(await balance(d, '1010'), 1000)
  assert.equal(await balance(d, '1000'), 0)
  assert.equal(await balance(d, '4100'), 1000)
})

test('a fine moved to the fee account is a student charge, not a library posting (ACC-27)', async () => {
  const d = await library('finance', 'fees')
  const { loanId } = await overdueLoan(d)
  const row = await settleFine(d.desk, { loanId, method: 'fee_account' })
  assert.equal(row.fineSettledBy, 'fee_account')
  const charges = (
    await withTenant(d.id, (tx) =>
      tx.execute(sql`select amount_paise::int as amount, label, source_id from fee_student_charges where source_module = 'library'`),
    )
  ).rows as { amount: number; label: string; source_id: string }[]
  assert.deepEqual(charges, [{ amount: 1000, label: 'Library fine: Introduction to Algorithms (A-1)', source_id: loanId }])
  assert.equal((await listEntries(books(d))).filter((e) => e.sourceModule === 'library').length, 0)
})

test('only a student has a fee account, and only where fees runs (ACC-27)', async () => {
  const d = await library('finance', 'fees')
  const { loanId } = await overdueLoan(d, d.facultyId)
  await assert.rejects(settleFine(d.desk, { loanId, method: 'fee_account' }), (e) => code(e) === 'not_a_student')
  const e = await library('finance')
  const second = await overdueLoan(e)
  await assert.rejects(settleFine(e.desk, { loanId: second.loanId, method: 'fee_account' }), (x) => code(x) === 'fees_not_enabled')
})

test('a lost book adds its replacement cost to the fine (ACC-27)', async () => {
  const d = await library()
  await setSettings(d.desk, RULES)
  const title = await createTitle(d.desk, { title: 'Sipser', author: 'Sipser' })
  const [copy] = await addCopies(d.desk, { titleId: title.id, accessionNos: ['S-1'], replacement: '500' })
  await issue(d.desk, { copyId: copy!.id, borrowerId: d.studentId })
  const back = await returnCopy(d.desk, { copyId: copy!.id, markLost: true })
  assert.equal(back.finePaise, 50_000)
  assert.equal(back.replacementPaise, 50_000)
})

test('changing the fine rules needs a reason and is audited (AUD-12)', async () => {
  const d = await library()
  const { reason: _reason, ...without } = RULES
  void _reason
  await assert.rejects(setSettings(d.desk, without))
  await setSettings(d.desk, { ...RULES, finePerDay: '5' })
  const rows = (
    await withTenant(d.id, (tx) => tx.execute(sql`select reason, detail from audit_log where action = 'library.settings_changed'`))
  ).rows as { reason: string; detail: { to: { finePerDayPaise: number } } }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.reason, 'the rules for this test')
  assert.equal(rows[0]!.detail.to.finePerDayPaise, 500)
})

test('two issues to one borrower at once cannot pass the limit (LOW-10)', async () => {
  const d = await library()
  await setSettings(d.desk, { ...RULES, maxConcurrentLoans: 1 })
  const title = await createTitle(d.desk, { title: 'Two Copies', author: 'Anon' })
  const [c1, c2] = await addCopies(d.desk, { titleId: title.id, accessionNos: ['T-1', 'T-2'] })

  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  const lock = authDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'library.borrower:' + d.studentId}, 0))`)
    await held
  })
  const a = issue(d.desk, { copyId: c1!.id, borrowerId: d.studentId })
  const b = issue(d.desk, { copyId: c2!.id, borrowerId: d.studentId })
  for (let i = 0; i < 100; i++) {
    const [w] = (await authDb.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event = 'advisory' and datname = current_database()`)).rows as { n: number }[]
    if (w!.n >= 2) break
    await new Promise((r) => setTimeout(r, 50))
  }
  release()
  await lock
  const out = await Promise.allSettled([a, b])
  assert.equal(out.filter((o) => o.status === 'fulfilled').length, 1)
  const refused = out.find((o) => o.status === 'rejected') as PromiseRejectedResult
  assert.equal(code(refused.reason), 'loan_limit_reached')
})

test('a fine cannot be settled before the book is back, or when nothing is due (review BLOCKER 2)', async () => {
  const d = await library('finance')
  await setSettings(d.desk, RULES)
  const title = await createTitle(d.desk, { title: 'Introduction to Algorithms', author: 'Cormen' })
  const [copy] = await addCopies(d.desk, { titleId: title.id, accessionNos: ['A-9'] })
  const loan = await issue(d.desk, { copyId: copy!.id, borrowerId: d.studentId })
  await withTenant(d.id, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test backdate', true)`)
    await tx.execute(sql`update library_loans
                            set issued_at = now() - interval '19 days',
                                due_on = date_trunc('day', now() - interval '5 days') + interval '23:59:59.999'
                          where id = ${loan.id}`)
  })
  // Overdue and still out: the stored fine is zero, so settling would record a method and post nothing.
  await assert.rejects(settleFine(d.desk, { loanId: loan.id, method: 'upi' }), (e) => code(e) === 'not_returned')
  const back = await returnCopy(d.desk, { copyId: copy!.id })
  assert.equal(back.finePaise, 1000)
  const row = await settleFine(d.desk, { loanId: loan.id, method: 'upi' })
  assert.equal(row.fineSettledBy, 'upi')
  assert.equal(await balance(d, '1010'), 1000)

  // A returned loan with no fine has nothing to settle.
  const [copy2] = await addCopies(d.desk, { titleId: title.id, accessionNos: ['A-10'] })
  const fresh = await issue(d.desk, { copyId: copy2!.id, borrowerId: d.studentId })
  await returnCopy(d.desk, { copyId: copy2!.id })
  await assert.rejects(settleFine(d.desk, { loanId: fresh.id, method: 'cash' }), (e) => code(e) === 'nothing_due')
})
