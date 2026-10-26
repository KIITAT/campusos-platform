import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { authDb, institutions, users, verifyChains, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { cancelStudentCharge, chargeStudent, recordPayment, refundPayment, type Actor } from './api'

/**
 * ACC-18: a payment recorded once per idempotency key.
 *
 * A double-click, a resubmitted form or a retry after a dropped connection
 * used to make a second receipt and a second journal entry. The key says "the
 * same act", and the second request gets the first one's receipt back.
 */

const SLUG = 'fees-idem'
const OTHER = 'fees-idem-other'
let inst = ''
let other = ''
const ids = { clerk: '', clerk2: '', adm: '', s1: '', otherClerk: '', otherStudent: '', term: '', otherTerm: '' }

const as = (id: string, role: Actor['role'], institutionId: string): Actor => ({ id, role, institutionId, email: null })
const clerk = () => as(ids.clerk, 'accounts_staff', inst)
const keyed = (actor: Actor, key: string) => ({ ...actor, idempotencyKey: key }) as Actor
const body = (over: Record<string, unknown> = {}) => ({
  studentId: ids.s1,
  termId: ids.term,
  amount: '1000',
  method: 'cash',
  ...over,
})
const code = (e: unknown) => (e as { code?: string }).code

/**
 * Drizzle wraps a driver error in a "Failed query" Error and hangs the real
 * Postgres message off .cause, so a policy message has to be looked for down
 * the chain rather than on the surface.
 */
const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    text += x.message + String.fromCharCode(10)
  }
  return re.test(text)
}

/** What a payment leaves behind, counted from the database itself. */
async function tally(institutionId = inst) {
  const r = await authDb.execute<{ payments: number; entries: number; audits: number; counter: number | null }>(sql`
    select
      (select count(*)::int from fee_payments where institution_id = ${institutionId}) as payments,
      (select count(*)::int from finance_journal_entries
        where institution_id = ${institutionId} and source_module = 'fees' and source_ref like 'payment:%') as entries,
      (select count(*)::int from audit_log
        where institution_id = ${institutionId} and action = 'fee.payment_recorded') as audits,
      (select next::int from fee_receipt_counters where institution_id = ${institutionId}) as counter`)
  return r.rows[0]!
}

/** Until `n` sessions are waiting on a lock in a statement that matches. */
async function waitingOn(pattern: string, n = 1) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const r = await authDb.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where wait_event_type = 'Lock' and query ilike ${pattern}`)
    if (r.rows[0]!.n >= n) return
    if (Date.now() > deadline) throw new Error(`nobody is waiting on ${pattern}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

before(async () => {
  await authDb.delete(institutions).where(inArray(institutions.slug, [SLUG, OTHER]))
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Idempotent College', allowedEmailDomains: ['idem.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['idem-other.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'clerk@idem.test', institutionId: inst, role: 'accounts_staff', name: 'Clerk' },
      { email: 'clerk2@idem.test', institutionId: inst, role: 'accounts_staff', name: 'Clerk Two' },
      { email: 'adm@idem.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 's1@idem.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 'clerk@idem-other.test', institutionId: other, role: 'accounts_staff', name: 'Other Clerk' },
      { email: 'adm@idem-other.test', institutionId: other, role: 'institution_admin', name: 'Other Adm' },
      { email: 's@idem-other.test', institutionId: other, role: 'student', name: 'Other Student' },
    ])
    .returning({ id: users.id })
  ids.clerk = people[0]!.id
  ids.clerk2 = people[1]!.id
  ids.adm = people[2]!.id
  ids.s1 = people[3]!.id
  ids.otherClerk = people[4]!.id
  ids.otherStudent = people[6]!.id

  ids.term = (
    await academic.createTerm(as(people[2]!.id, 'institution_admin', inst), {
      code: 't1', name: 'Sem 1', startsOn: '2026-07-01', endsOn: '2026-12-01',
    })
  ).id
  ids.otherTerm = (
    await academic.createTerm(as(people[5]!.id, 'institution_admin', other), {
      code: 't1', name: 'Sem 1', startsOn: '2026-07-01', endsOn: '2026-12-01',
    })
  ).id

  // The receipt counter row exists from the first payment on; the race below
  // holds it.
  await recordPayment(clerk(), body())
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

test('the same key twice records one payment, posts it once and audits it once', async () => {
  const before = await tally()
  const key = randomUUID()
  const first = await recordPayment(keyed(clerk(), key), body())
  const second = await recordPayment(keyed(clerk(), key), body())

  assert.equal(second.id, first.id)
  assert.equal(second.receiptNo, first.receiptNo)
  assert.equal((second as { replayed?: boolean }).replayed, true)
  assert.notEqual((first as { replayed?: boolean }).replayed, true)
  assert.match(String((second as { notice?: string }).notice), new RegExp(`Already recorded as receipt ${first.receiptNo}`))

  const now = await tally()
  assert.equal(now.payments - before.payments, 1, 'one payment')
  assert.equal(now.entries - before.entries, 1, 'one journal entry')
  assert.equal(now.audits - before.audits, 1, 'one audit row')
  assert.equal(now.counter! - before.counter!, 1, 'one receipt number taken')
})

test('two requests racing on one key: the second waits on the claim and replays the first', async () => {
  const before = await tally()
  const key = randomUUID()
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))

  // Hold the institution's receipt counter, so the first request claims the
  // key and then stops, uncommitted, at its receipt number.
  let holding!: () => void
  const locked = new Promise<void>((resolve) => (holding = resolve))
  const holder = authDb.transaction(async (tx) => {
    await tx.execute(sql`select 1 from fee_receipt_counters where institution_id = ${inst} for update`)
    holding()
    await held
  })
  await locked

  const a = recordPayment(keyed(clerk(), key), body())
  const b = (async () => {
    await waitingOn('%update "fee_receipt_counters"%')
    return recordPayment(keyed(clerk(), key), body())
  })()
  try {
    // The second must wait on the first one's claim -- not on the counter,
    // where it would take a receipt number of its own.
    await waitingOn('%insert into "fee_idempotency_keys"%')
  } finally {
    release()
    await holder
  }
  const [ra, rb] = await Promise.all([a, b])

  assert.equal(rb.id, ra.id)
  assert.equal((rb as { replayed?: boolean }).replayed, true)
  const now = await tally()
  assert.equal(now.payments - before.payments, 1, 'one payment')
  assert.equal(now.entries - before.entries, 1, 'one journal entry')
  assert.equal(now.audits - before.audits, 1, 'one audit row')
  assert.equal(now.counter! - before.counter!, 1, 'the receipt series has no gap')

  // The one audit row is sealed into the institution's chain, and the chain
  // still verifies with the replay beside it.
  const sealed = await authDb.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_chain c join audit_log l on l.id = c.audit_id
     where l.entity_id = ${ra.id} and l.action = 'fee.payment_recorded'`)
  assert.equal(sealed.rows[0]!.n, 1)
  const report = await verifyChains({ institutionId: inst })
  assert.deepEqual(report.problems, [])
})

test('a key reused for a different payment is refused and writes nothing', async () => {
  const key = randomUUID()
  await recordPayment(keyed(clerk(), key), body())
  const before = await tally()
  await assert.rejects(
    () => recordPayment(keyed(clerk(), key), body({ amount: '2000' })),
    (e: unknown) => code(e) === 'idempotency_key_reused' && (e as { status: number }).status === 409,
  )
  assert.deepEqual(await tally(), before)
})

test('a request that fails leaves no claim, so the same key then works', async () => {
  const key = randomUUID()
  // A clerk is not a student: refused, and the claim goes with it.
  await assert.rejects(
    () => recordPayment(keyed(clerk(), key), body({ studentId: ids.clerk })),
    (e: unknown) => code(e) === 'not_a_student',
  )
  const before = await tally()
  const p = await recordPayment(keyed(clerk(), key), body())
  assert.notEqual((p as { replayed?: boolean }).replayed, true)
  assert.equal((await tally()).payments - before.payments, 1)
})

test('a key belongs to one person in one institution', async () => {
  const key = randomUUID()
  const before = await tally()
  const mine = await recordPayment(keyed(clerk(), key), body())
  const theirs = await recordPayment(keyed(as(ids.clerk2, 'accounts_staff', inst), key), body())
  assert.notEqual(theirs.id, mine.id)
  assert.notEqual((theirs as { replayed?: boolean }).replayed, true)
  assert.equal((await tally()).payments - before.payments, 2)

  const elsewhere = await recordPayment(
    keyed(as(ids.otherClerk, 'accounts_staff', other), key),
    body({ studentId: ids.otherStudent, termId: ids.otherTerm }),
  )
  assert.notEqual(elsewhere.id, mine.id)
  assert.equal(elsewhere.institutionId, other)
})

test('a malformed key is refused before anything is written', async () => {
  const before = await tally()
  for (const bad of ['short', 'has space in it', 'x'.repeat(129), 'émoji-key-1']) {
    await assert.rejects(
      () => recordPayment(keyed(clerk(), bad), body()),
      (e: unknown) => code(e) === 'invalid_idempotency_key' && (e as { status: number }).status === 400,
      bad,
    )
  }
  assert.deepEqual(await tally(), before)
})

test('the claims are isolated per institution for the application role', async () => {
  const key = randomUUID()
  await recordPayment(keyed(clerk(), key), body())

  const count = (tenant: string) =>
    withTenant(tenant, async (tx) =>
      (await tx.execute<{ n: number }>(sql`select count(*)::int as n from fee_idempotency_keys where key = ${key}`)).rows[0]!.n,
    )
  assert.equal(await count(inst), 1)
  assert.equal(await count(other), 0)

  // Nor can it plant a claim in another institution's name.
  await assert.rejects(
    () =>
      withTenant(other, (tx) =>
        tx.execute(sql`insert into fee_idempotency_keys (institution_id, actor_id, operation, key, request_hash)
                       values (${inst}, ${ids.clerk}, 'payment', ${randomUUID()}, 'x')`),
      ),
    saysDb(/row-level security/),
  )
})

test('without a key a payment is recorded as before', async () => {
  const before = await tally()
  await recordPayment(clerk(), body())
  await recordPayment(clerk(), body())
  assert.equal((await tally()).payments - before.payments, 2)
})

/**
 * NEW-15: a refund and a manual charge are the same kind of act as a payment.
 * Submitted twice, each used to happen twice: two refunds paid out and posted,
 * two charges billed. They take the same key, for their own operation.
 */
async function sums(institutionId = inst) {
  const r = await authDb.execute<{ refunds: number; refundEntries: number; charges: number; chargeAudits: number }>(sql`
    select
      (select count(*)::int from fee_refunds where institution_id = ${institutionId}) as refunds,
      (select count(*)::int from finance_journal_entries
        where institution_id = ${institutionId} and source_module = 'fees' and source_ref like 'refund:%') as "refundEntries",
      (select count(*)::int from fee_student_charges where institution_id = ${institutionId}) as charges,
      (select count(*)::int from audit_log
        where institution_id = ${institutionId} and entity = 'fee_student_charges' and action = 'charge') as "chargeAudits"`)
  return r.rows[0]!
}

test('a refund submitted twice with one key is paid out once (NEW-15)', async () => {
  const p = await recordPayment(clerk(), body({ amount: '5000' }))
  const adm = keyed(as(ids.adm, 'institution_admin', inst), randomUUID())
  const refund = { paymentId: p.id, amount: '1000', reason: 'overpaid at the counter' }
  const before = await sums()
  const first = await refundPayment(adm, refund)
  const second = await refundPayment(adm, refund)
  assert.equal(second.id, first.id)
  assert.equal((second as { replayed?: boolean }).replayed, true)
  assert.match(String((second as { notice?: string }).notice), /Already refunded/)
  const now = await sums()
  assert.equal(now.refunds - before.refunds, 1, 'one refund')
  assert.equal(now.refundEntries - before.refundEntries, 1, 'one journal entry')
})

test('a manual charge submitted twice with one key is charged once (NEW-15)', async () => {
  const actor = keyed(clerk(), randomUUID())
  const charge = { studentId: ids.s1, termId: ids.term, label: 'Lost library book', amount: '450' }
  const before = await sums()
  const first = await chargeStudent(actor, charge)
  const second = await chargeStudent(actor, charge)
  assert.equal(second.id, first.id)
  assert.equal((second as { replayed?: boolean }).replayed, true)
  const now = await sums()
  assert.equal(now.charges - before.charges, 1, 'one charge')
  assert.equal(now.chargeAudits - before.chargeAudits, 1, 'one audit row')
})

test('a key used for a payment does not answer a refund (NEW-15)', async () => {
  const adm = keyed(as(ids.adm, 'institution_admin', inst), randomUUID())
  const p = await recordPayment(adm, body({ amount: '3000' }))
  const r = await refundPayment(adm, {
    paymentId: p.id, amount: '500', reason: 'part refund, same key',
  })
  assert.notEqual(r.id, p.id)
  assert.notEqual((r as { replayed?: boolean }).replayed, true)
})

test('a charge cancelled since is not replayed as live (NEW-15)', async () => {
  const actor = keyed(clerk(), randomUUID())
  const charge = { studentId: ids.s1, termId: ids.term, label: 'Duplicate admit card', amount: '100' }
  const first = await chargeStudent(actor, charge)
  await cancelStudentCharge(clerk(), { chargeId: first.id, reason: 'raised in error' })
  await assert.rejects(() => chargeStudent(actor, charge), (e: unknown) => code(e) === 'idempotent_result_gone')
})
