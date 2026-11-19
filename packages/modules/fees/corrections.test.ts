import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { localToday, setSingleOfficer, trialBalance, type Actor as Books } from '@campusos/module-finance/api'
import {
  createFeeItem,
  issueInvoices,
  listStudentCharges,
  receivableReport,
  reconcilePayment,
  recordPayment,
  refundPayment,
  studentLedger,
  type Actor,
} from './api'

// Loaded as a record so that, before the functions exist, the tests fail on
// their assertions rather than the whole file failing to load.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (await import('./api')) as Record<string, any>

/**
 * Void and cheque return (ACC-23): a receipt is never deleted; it is voided or
 * marked returned unpaid, its journal entry is reversed through reverseWithin,
 * the amount is owed again, and the ledger still equals the books.
 */

let n = 0
const SLUG = 'fees-corrections-'

interface Campus {
  id: string
  admin: Actor
  admin2: Actor
  clerk: Actor
  clerk2: Actor
  s1: string
  s2: string
  termId: string
  programId: string
}

async function campus(solo = true): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Corrections College', allowedEmailDomains: [`${tag}.test`] })
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
      { email: `s2@${tag}.test`, institutionId: id, role: 'student', name: 'Two Student' },
    ])
    .returning({ id: users.id })

  const actor = (k: number, email: string, role: Actor['role']): Actor => ({ id: people[k]!.id, email, role, institutionId: id })
  const admin = actor(0, `adm@${tag}.test`, 'institution_admin')
  const admin2 = actor(1, `adm2@${tag}.test`, 'institution_admin')
  const clerk = actor(2, `clerk@${tag}.test`, 'accounts_staff')
  const clerk2 = actor(3, `clerk2@${tag}.test`, 'accounts_staff')

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
  for (const p of [people[4]!, people[5]!]) {
    await academic.addSectionMember(admin, { sectionId: section.id, userId: p.id })
    await academic.declareProgram(admin, { studentId: p.id, programId: program.id, declaredOn: '2025-07-01' })
  }

  if (solo) await setSingleOfficer(admin, { enabled: true, reason: 'test fixture: one officer' })

  return { id, admin, admin2, clerk, clerk2, s1: people[4]!.id, s2: people[5]!.id, termId: term.id, programId: program.id }
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

async function reconciled(c: Campus) {
  const r = await withTenant(c.id, (tx) => receivableReport(tx))
  assert.equal(r.differencePaise, 0)
  assert.equal(r.unattributedPaise, 0)
  assert.equal(r.mismatchCount, 0)
}

const today = (c: Campus) => withTenant(c.id, (tx) => localToday(tx, c.id))

const nextDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

const code = (want: string) => (e: unknown) => (e as { code?: string }).code === want

const cash = (c: Campus, amount = '45000', by: Actor = c.clerk) =>
  recordPayment(by, { studentId: c.s1, termId: c.termId, amount, method: 'cash', allowAdvance: true })

const cheque = (c: Campus, over: Record<string, unknown> = {}) =>
  recordPayment(c.clerk, {
    studentId: c.s1,
    termId: c.termId,
    amount: '45000',
    method: 'cheque',
    reference: '000123',
    drawerIfsc: 'SBIN0001234',
    drawerAccount: '12345678901',
    allowAdvance: true,
    ...over,
  })

async function one<T>(c: Campus, q: ReturnType<typeof sql>): Promise<T> {
  const r = await withTenant(c.id, (tx) => tx.execute(q))
  return r.rows[0] as T
}

/** The reversal entries of a payment's journal entry. */
const reversalsOf = (c: Campus, paymentId: string) =>
  withTenant(c.id, async (tx) =>
    (
      await tx.execute(sql`
        select r.id, r.posting_date::text as posting_date
          from finance_journal_entries r
          join finance_journal_entries e on e.id = r.reversal_of
         where e.source_ref = ${'payment:' + paymentId}`)
    ).rows as { id: string; posting_date: string }[],
  )

/** Wait until n sessions are blocked on a payment row lock. */
async function waitForWaiters(want: number) {
  const until = Date.now() + 5000
  for (;;) {
    const r = await authDb.execute(
      sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%fee_payments%for update%'`,
    )
    if ((r.rows[0] as { n: number }).n >= want) return
    if (Date.now() > until) throw new Error(`fewer than ${want} waiters after 5 s`)
    await new Promise((ok) => setTimeout(ok, 50))
  }
}

test('a voided receipt is reversed in the books and owed again', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const p = await cash(c)
  await api.voidPayment(c.admin, { paymentId: p.id, reason: 'entered against the wrong student' })

  const l = await studentLedger(c.admin, c.s1, c.termId)
  assert.equal(l.outstandingPaise, 4_500_000)
  assert.equal(l.paidPaise, 0)
  assert.equal((l.payments[0] as { status?: string }).status, 'voided')
  const rev = await reversalsOf(c, p.id)
  assert.equal(rev.length, 1)
  assert.equal(rev[0]!.posting_date, await today(c))
  await reconciled(c)
  const l2 = await studentLedger(c.admin, c.s2, c.termId)
  assert.equal(await balance(c, RECEIVABLE), l.balancePaise + l2.balancePaise)
})

test('a bounced cheque reverses the receipt and its GL entry and re-opens the due', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const p = await cheque(c)
  assert.equal((await studentLedger(c.admin, c.s1, c.termId)).outstandingPaise, 0)
  const on = await today(c)
  await api.bouncePayment(c.clerk2, { paymentId: p.id, bouncedOn: on, reason: 'funds insufficient', charge: '500' })

  const l = await studentLedger(c.admin, c.s1, c.termId)
  assert.equal(l.outstandingPaise, 4_500_000)
  const row = await one<{ status: string; bounced_on: string }>(
    c,
    sql`select status, bounced_on::text as bounced_on from fee_payments where id = ${p.id}`,
  )
  assert.equal(row.status, 'bounced')
  assert.equal(row.bounced_on, on)
  const rev = await reversalsOf(c, p.id)
  assert.equal(rev.length, 1)
  assert.equal(rev[0]!.posting_date, on)
  const charges = await listStudentCharges(c.admin, c.termId)
  const fee = charges.find((x) => x.label === `Cheque returned unpaid, receipt ${p.receiptNo}`)
  assert.ok(fee)
  assert.equal(fee.amountPaise, 50_000)
  await reconciled(c)

  await issueInvoices(c.admin, { termId: c.termId })
  const again = await studentLedger(c.admin, c.s1, c.termId)
  assert.equal(again.chargedPaise, 4_550_000)
  assert.equal(again.outstandingPaise, 4_550_000)
  await reconciled(c)
})

test('only a cheque is returned unpaid', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const p = await cash(c)
  await assert.rejects(
    () => api.bouncePayment(c.clerk2, { paymentId: p.id, bouncedOn: '2026-10-01', reason: 'funds insufficient' }),
    code('not_a_cheque'),
  )
})

test("a return needs the drawer's IFSC and account", async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const p = await cheque(c, { drawerIfsc: undefined, drawerAccount: undefined })
  const on = await today(c)
  await assert.rejects(
    () => api.bouncePayment(c.clerk2, { paymentId: p.id, bouncedOn: on, reason: 'funds insufficient' }),
    code('drawer_required'),
  )
  await api.bouncePayment(c.clerk2, {
    paymentId: p.id,
    bouncedOn: on,
    reason: 'funds insufficient',
    drawerIfsc: 'hdfc0000123',
    drawerAccount: '5010 0012 3456',
  })
  const row = await one<{ drawer_ifsc: string; drawer_account: string }>(
    c,
    sql`select drawer_ifsc, drawer_account from fee_payments where id = ${p.id}`,
  )
  assert.equal(row.drawer_ifsc, 'HDFC0000123')
  assert.equal(row.drawer_account, '501000123456')
})

test('a return is dated between receipt and today', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const p = await cheque(c, { receivedAt: '2026-10-01T06:00:00.000Z' })
  const on = await today(c)
  await assert.rejects(
    () => api.bouncePayment(c.clerk2, { paymentId: p.id, bouncedOn: '2026-09-30', reason: 'funds insufficient' }),
    code('bounce_before_receipt'),
  )
  await assert.rejects(
    () => api.bouncePayment(c.clerk2, { paymentId: p.id, bouncedOn: nextDay(on), reason: 'funds insufficient' }),
    code('future_bounce'),
  )
  await assert.rejects(
    () => api.bouncePayment(c.clerk2, { paymentId: p.id, bouncedOn: on, reason: 'funds insufficient', charge: '10000.01' }),
    code('bad_charge'),
  )
})

test('a void or a return is final', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const p = await cash(c)
  await api.voidPayment(c.admin, { paymentId: p.id, reason: 'entered twice by mistake' })
  await assert.rejects(
    () => api.voidPayment(c.admin, { paymentId: p.id, reason: 'entered twice by mistake' }),
    code('payment_not_live'),
  )
  await assert.rejects(
    () => refundPayment(c.admin2, { paymentId: p.id, amount: '1000', reason: 'overpaid at the counter' }),
    code('payment_not_live'),
  )
  await assert.rejects(
    () => reconcilePayment(c.clerk2, { paymentId: p.id, reason: 'matched bank statement' }),
    code('payment_not_live'),
  )

  const q = await cheque(c)
  await api.bouncePayment(c.clerk2, { paymentId: q.id, bouncedOn: await today(c), reason: 'funds insufficient' })
  await assert.rejects(
    () => api.voidPayment(c.admin, { paymentId: q.id, reason: 'entered twice by mistake' }),
    code('payment_not_live'),
  )
})

test('a refunded payment is neither voided nor returned', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const p = await cash(c)
  await refundPayment(c.admin, { paymentId: p.id, amount: '1000', reason: 'overpaid at the counter' })
  await assert.rejects(
    () => api.voidPayment(c.admin, { paymentId: p.id, reason: 'entered twice by mistake' }),
    code('payment_refunded'),
  )
  const q = await cheque(c)
  await refundPayment(c.admin, { paymentId: q.id, amount: '1000', reason: 'overpaid at the counter' })
  await assert.rejects(
    async () => api.bouncePayment(c.clerk2, { paymentId: q.id, bouncedOn: await today(c), reason: 'funds insufficient' }),
    code('payment_refunded'),
  )
})

test('the recorder does not void or return their own receipt', async () => {
  const c = await campus(false)
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const p = await cash(c, '45000', c.admin)
  await assert.rejects(
    () => api.voidPayment(c.admin, { paymentId: p.id, reason: 'entered twice by mistake' }),
    (e: unknown) => (e as { status?: number }).status === 403 && code('separation_of_duties')(e),
  )
  await api.voidPayment(c.admin2, { paymentId: p.id, reason: 'entered twice by mistake' })

  const q = await cheque(c)
  const on = await today(c)
  await assert.rejects(
    () => api.bouncePayment(c.clerk, { paymentId: q.id, bouncedOn: on, reason: 'funds insufficient' }),
    code('separation_of_duties'),
  )
  await api.bouncePayment(c.clerk2, { paymentId: q.id, bouncedOn: on, reason: 'funds insufficient' })
})

test('a clerk does not void', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const p = await cash(c)
  await assert.rejects(
    () => api.voidPayment(c.clerk, { paymentId: p.id, reason: 'entered twice by mistake' }),
    (e: unknown) => (e as { status?: number }).status === 403 && code('forbidden')(e),
  )
})

test('two voids at once: one wins', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const p = await cash(c)
  let a!: Promise<unknown>
  let b!: Promise<unknown>
  await authDb.transaction(async (h) => {
    await h.execute(sql`select 1 from fee_payments where id = ${p.id} for update`)
    a = api.voidPayment(c.admin, { paymentId: p.id, reason: 'first attempt' })
    b = api.voidPayment(c.admin2, { paymentId: p.id, reason: 'second attempt' })
    a.catch(() => {})
    b.catch(() => {})
    await waitForWaiters(2)
  })
  const out = await Promise.allSettled([a, b])
  assert.equal(out.filter((o) => o.status === 'fulfilled').length, 1)
  const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult
  assert.ok(code('payment_not_live')(lost.reason))
  assert.equal((await reversalsOf(c, p.id)).length, 1)
  await reconciled(c)
})

test('a void and a refund at once: one wins', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const p = await cash(c)
  let a!: Promise<unknown>
  let b!: Promise<unknown>
  await authDb.transaction(async (h) => {
    await h.execute(sql`select 1 from fee_payments where id = ${p.id} for update`)
    a = api.voidPayment(c.admin, { paymentId: p.id, reason: 'entered twice by mistake' })
    b = refundPayment(c.admin2, { paymentId: p.id, amount: '1000', reason: 'overpaid at the counter' })
    a.catch(() => {})
    b.catch(() => {})
    await waitForWaiters(2)
  })
  const out = await Promise.allSettled([a, b])
  assert.equal(out.filter((o) => o.status === 'fulfilled').length, 1)
  const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult
  assert.ok(code('payment_not_live')(lost.reason) || code('payment_refunded')(lost.reason), String(lost.reason))
  await reconciled(c)
})

test('the student and their guardians are told', async () => {
  const c = await campus()
  await charge(c, 'Tuition', '45000')
  await issueInvoices(c.admin, { termId: c.termId })
  const titles = async () =>
    (
      await withTenant(c.id, (tx) => tx.execute(sql`select title from notifications where user_id = ${c.s1} order by created_at`))
    ).rows.map((r) => (r as { title: string }).title)

  const p = await cash(c)
  await api.voidPayment(c.admin, { paymentId: p.id, reason: 'entered against the wrong student' })
  assert.ok((await titles()).includes('Receipt cancelled'))

  const q = await cheque(c)
  await api.bouncePayment(c.clerk2, { paymentId: q.id, bouncedOn: await today(c), reason: 'funds insufficient' })
  assert.ok((await titles()).includes('Cheque returned unpaid'))
})

test("another institution cannot void this one's receipt", async () => {
  const a = await campus()
  const b = await campus()
  await charge(a, 'Tuition', '45000')
  await issueInvoices(a.admin, { termId: a.termId })
  const p = await cash(a)
  await assert.rejects(
    () => api.voidPayment(b.admin, { paymentId: p.id, reason: 'not mine at all' }),
    (e: unknown) => (e as { status?: number }).status === 404 && code('no_such_payment')(e),
  )
})
