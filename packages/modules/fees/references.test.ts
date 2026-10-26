import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { addBankAccount, claimTransfer, recordPayment, verifyClaim, type Actor } from './api'

/**
 * ACC-18: a bank transfer or UPI reference is receipted once per institution.
 *
 * A UTR identifies one transfer across the banking system, so a second
 * receipt for it is a mistake: typed twice at the counter, or typed once and
 * then arrived again as the student's verified claim. Cheque numbers repeat
 * across banks, and card codes and "other" references repeat too, so those
 * are left alone until P1-03 records what makes them unique.
 */

const SLUG = 'fees-refs'
const OTHER = 'fees-refs-other'
let inst = ''
let other = ''
const ids = { clerk: '', adm: '', s1: '', s2: '', otherClerk: '', otherStudent: '', term: '', otherTerm: '', account: '' }

const as = (id: string, role: Actor['role'], institutionId: string): Actor => ({ id, role, institutionId, email: null })
const clerk = () => as(ids.clerk, 'accounts_staff', inst)
const keyed = (actor: Actor, key: string) => ({ ...actor, idempotencyKey: key }) as Actor
const pay = (over: Record<string, unknown>, actor = clerk()) =>
  recordPayment(actor, { studentId: ids.s1, termId: ids.term, amount: '1000', ...over })
const code = (e: unknown) => (e as { code?: string }).code
/** A fresh UTR-shaped reference per test, so the tests do not meet. */
const utr = () => `UTR${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`

async function payments(institutionId = inst) {
  const r = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from fee_payments where institution_id = ${institutionId}`)
  return r.rows[0]!.n
}

async function waitingOn(pattern: string, n: number) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const r = await authDb.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike ${pattern}`)
    if (r.rows[0]!.n >= n) return
    if (Date.now() > deadline) throw new Error(`fewer than ${n} waiting on ${pattern}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

before(async () => {
  await authDb.delete(institutions).where(inArray(institutions.slug, [SLUG, OTHER]))
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Reference College', allowedEmailDomains: ['refs.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['refs-other.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'clerk@refs.test', institutionId: inst, role: 'accounts_staff', name: 'Clerk' },
      { email: 'adm@refs.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 's1@refs.test', institutionId: inst, role: 'student', name: 'One' },
      { email: 's2@refs.test', institutionId: inst, role: 'student', name: 'Two' },
      { email: 'clerk@refs-other.test', institutionId: other, role: 'accounts_staff', name: 'Other Clerk' },
      { email: 'adm@refs-other.test', institutionId: other, role: 'institution_admin', name: 'Other Adm' },
      { email: 's@refs-other.test', institutionId: other, role: 'student', name: 'Other Student' },
    ])
    .returning({ id: users.id })
  ids.clerk = people[0]!.id
  ids.adm = people[1]!.id
  ids.s1 = people[2]!.id
  ids.s2 = people[3]!.id
  ids.otherClerk = people[4]!.id
  ids.otherStudent = people[6]!.id
  const adm = as(ids.adm, 'institution_admin', inst)
  ids.term = (await academic.createTerm(adm, { code: 't1', name: 'Autumn', startsOn: '2026-07-01', endsOn: '2026-12-01' })).id
  ids.otherTerm = (
    await academic.createTerm(as(people[5]!.id, 'institution_admin', other), {
      code: 't1', name: 'Autumn', startsOn: '2026-07-01', endsOn: '2026-12-01',
    })
  ).id
  ids.account = (
    await addBankAccount(adm, {
      label: 'Main', accountName: 'Reference College', bankName: 'SBI', branch: 'Main',
      accountNumber: '1234567890', ifsc: 'SBIN0001234',
    })
  ).id
  await pay({ method: 'cash' }) // the receipt counter exists from here on
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

test('a UTR is receipted once, whatever its case or padding', async () => {
  const ref = utr()
  const first = await pay({ method: 'bank_transfer', reference: ref })
  const before = await payments()
  for (const again of [ref, ref.toLowerCase(), `  ${ref} `]) {
    await assert.rejects(
      () => pay({ method: 'bank_transfer', reference: again, studentId: ids.s2 }),
      (e: unknown) =>
        code(e) === 'duplicate_reference' &&
        (e as { status: number }).status === 409 &&
        (e as Error).message.includes(first.receiptNo),
      again,
    )
  }
  // A UPI reference is the same kind of thing, and one transfer is one transfer.
  await assert.rejects(() => pay({ method: 'upi', reference: ref }), (e: unknown) => code(e) === 'duplicate_reference')
  assert.equal(await payments(), before)
})

test('a UPI reference is receipted once', async () => {
  const ref = `${Date.now()}`.slice(-12)
  await pay({ method: 'upi', reference: ref })
  await assert.rejects(() => pay({ method: 'upi', reference: ref }), (e: unknown) => code(e) === 'duplicate_reference')
})

test('cheques, cards, other references and cash are not held to one receipt', async () => {
  const before = await payments()
  // Cheque 000123 from two different banks is two cheques.
  await pay({ method: 'cheque', reference: '000123' })
  await pay({ method: 'cheque', reference: '000123', studentId: ids.s2 })
  await pay({ method: 'card', reference: 'AUTH77' })
  await pay({ method: 'card', reference: 'AUTH77' })
  await pay({ method: 'other', reference: 'DD-5' })
  await pay({ method: 'other', reference: 'DD-5' })
  await pay({ method: 'cash' })
  await pay({ method: 'cash' })
  assert.equal((await payments()) - before, 8)
})

test('another institution may receipt the same UTR', async () => {
  const ref = utr()
  await pay({ method: 'bank_transfer', reference: ref })
  const theirs = await recordPayment(as(ids.otherClerk, 'accounts_staff', other), {
    studentId: ids.otherStudent, termId: ids.otherTerm, amount: '1000', method: 'bank_transfer', reference: ref,
  })
  assert.equal(theirs.institutionId, other)
})

test('a claim for a UTR already receipted by hand is refused, and stays pending', async () => {
  const ref = utr()
  await pay({ method: 'bank_transfer', reference: ref, amount: '5000' })
  const claim = await claimTransfer(as(ids.s1, 'student', inst), {
    termId: ids.term, accountId: ids.account, mode: 'neft', remitterBank: 'SBI', accountHolder: 'Parent',
    contactPhone: '9876543210', transferredOn: '2026-07-10', amount: '5000', utr: ref,
  })
  const before = await payments()
  await assert.rejects(() => verifyClaim(clerk(), { claimId: claim.id }), (e: unknown) => code(e) === 'duplicate_reference')
  assert.equal(await payments(), before)
  const r = await authDb.execute<{ status: string }>(sql`select status from fee_transfer_claims where id = ${claim.id}`)
  assert.equal(r.rows[0]!.status, 'pending')
})

test('two requests racing with one UTR under different keys: exactly one receipt', async () => {
  const ref = utr()
  const before = await payments()
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let holding!: () => void
  const locked = new Promise<void>((resolve) => (holding = resolve))
  const holder = authDb.transaction(async (tx) => {
    await tx.execute(sql`select 1 from fee_receipt_counters where institution_id = ${inst} for update`)
    holding()
    await held
  })
  await locked

  // Both get past any look-up while neither has committed, and wait at the
  // receipt counter; only the database can tell them apart after that.
  const a = pay({ method: 'bank_transfer', reference: ref }, keyed(clerk(), randomUUID()))
  await waitingOn('%update "fee_receipt_counters"%', 1)
  const b = pay({ method: 'bank_transfer', reference: ref }, keyed(clerk(), randomUUID()))
  try {
    await waitingOn('%update "fee_receipt_counters"%', 2)
  } finally {
    release()
    await holder
  }
  const results = await Promise.allSettled([a, b])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
  assert.equal(code(refused.reason), 'duplicate_reference')
  assert.equal((await payments()) - before, 1)
})

/**
 * The pre-flight is the first statement of fees 0007. Run against duplicates
 * it must refuse, naming them, before the migration changes anything. Done
 * inside a transaction that is rolled back, with the new index dropped so the
 * duplicates can exist.
 */
test('fees 0007 refuses to run over duplicate references, and names them', async () => {
  const file = new URL('./migrations/0007_idempotency_and_references.sql', import.meta.url)
  const preflight = readFileSync(file, 'utf8').split('--> statement-breakpoint')[0]!
  const ref = utr()
  let caught: unknown = null
  await authDb
    .transaction(async (tx) => {
      await tx.execute(sql`drop index if exists fee_payments_reference`)
      for (const [no, r] of [['DUP-1', ref], ['DUP-2', ref.toLowerCase()]] as const) {
        await tx.execute(sql`
          insert into fee_payments (institution_id, student_id, term_id, amount_paise, method, reference, receipt_no)
          values (${inst}, ${ids.s1}, ${ids.term}, 1000, 'upi', ${r}, ${no})`)
      }
      try {
        await tx.execute(sql.raw(preflight))
      } catch (e) {
        caught = e
      }
      throw new Error('roll back')
    })
    .catch((e) => {
      if ((e as Error).message !== 'roll back') throw e
    })

  let text = ''
  for (let x: unknown = caught; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    const c = x as Error & { detail?: string }
    text += `${c.message}\n${c.detail ?? ''}\n`
  }
  assert.match(text, /receipted more than once/)
  assert.match(text, /DUP-1/)
  assert.match(text, /DUP-2/)
  assert.match(text, new RegExp(SLUG))
})
