import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { auditLog, authDb, db, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  FeeError,
  createFeeItem,
  duesReport,
  grantWaiver,
  listFeeItems,
  paymentForReceipt,
  paymentTrail,
  receiptPdf,
  recordPayment,
  reconcilePayment,
  revokeWaiver,
  studentLedger,
  type Actor,
} from './api'
import { feeItems, feePayments, feeWaivers, receiptCounters } from './schema'

const SLUG = 'fees-test'
const OTHER = 'fees-other'
let inst: string
let other: string
const ids = {
  prog: '', prog2: '', term: '', term2: '',
  s1: '', s2: '', s3: '', clerk: '', adm: '', fac: '',
}

const A = (over: Partial<Actor>): Actor => ({
  id: ids.clerk,
  email: 'clerk@fees.test',
  role: 'accounts_staff',
  institutionId: inst,
  ...over,
})
const clerk = () => A({})
const admin = () => A({ id: ids.adm, email: 'adm@fees.test', role: 'institution_admin' })
const student = (id: string) => A({ id, role: 'student' })
const code = (e: unknown) => (e as FeeError).code
const status = (e: unknown) => (e as FeeError).status

/**
 * Drizzle wraps a driver error in a "Failed query" Error and hangs the real
 * Postgres message off .cause, so a trigger message has to be looked for down
 * the chain rather than on the surface.
 */
const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    text += x.message + String.fromCharCode(10)
  }
  return re.test(text)
}

const tuition = (over: Record<string, unknown> = {}) =>
  createFeeItem(admin(), {
    programId: ids.prog,
    termId: ids.term,
    label: 'Tuition',
    amount: '45000',
    ...over,
  })

const pay = (over: Record<string, unknown> = {}) =>
  recordPayment(clerk(), {
    studentId: ids.s1,
    termId: ids.term,
    amount: '10000',
    method: 'upi',
    ...over,
  })

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Fees College', allowedEmailDomains: ['fees.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['other.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'clerk@fees.test', institutionId: inst, role: 'accounts_staff', name: 'Clerk' },
      { email: 'adm@fees.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'f@fees.test', institutionId: inst, role: 'faculty', name: 'Fac' },
      { email: 's1@fees.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@fees.test', institutionId: inst, role: 'student', name: 'Two Student' },
      { email: 's3@fees.test', institutionId: inst, role: 'student', name: 'Three Student' },
    ])
    .returning({ id: users.id })
  ids.clerk = people[0]!.id
  ids.adm = people[1]!.id
  ids.fac = people[2]!.id
  ids.s1 = people[3]!.id
  ids.s2 = people[4]!.id
  ids.s3 = people[5]!.id

  const st = admin()
  const dept = await academic.createDepartment(st, { code: 'cse', name: 'CSE' })
  const p1 = await academic.createProgram(st, {
    departmentId: dept.id, code: 'btech', name: 'BTech',
    level: 'undergraduate', durationTerms: 8,
  })
  const p2 = await academic.createProgram(st, {
    departmentId: dept.id, code: 'mtech', name: 'MTech',
    level: 'postgraduate', durationTerms: 4,
  })
  ids.prog = p1.id
  ids.prog2 = p2.id

  ids.term = (
    await academic.createTerm(st, {
      code: 't1', name: 'Sem 1', startsOn: '2026-01-05', endsOn: '2026-05-30',
    })
  ).id
  ids.term2 = (
    await academic.createTerm(st, {
      code: 't2', name: 'Sem 2', startsOn: '2026-07-01', endsOn: '2026-12-01',
    })
  ).id

  const secA = await academic.createSection(st, {
    programId: p1.id, label: 'a', admissionYear: 2026,
  })
  const secB = await academic.createSection(st, {
    programId: p2.id, label: 'b', admissionYear: 2026,
  })
  // s1, s2 in btech; s3 in mtech.
  await academic.addSectionMember(st, { sectionId: secA.id, userId: ids.s1 })
  await academic.addSectionMember(st, { sectionId: secA.id, userId: ids.s2 })
  await academic.addSectionMember(st, { sectionId: secB.id, userId: ids.s3 })
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    // The guards refuse a silent delete, so the reset states its reason too.
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.update(feePayments).set({ reconciledAt: null, reconciledBy: null })
    await tx.delete(feePayments)
    await tx.delete(feeWaivers)
    await tx.delete(feeItems)
    await tx.delete(receiptCounters)
    await tx.delete(auditLog)
  })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

// --- who may do what -------------------------------------------------------

test('a clerk may take money but may not define a charge', async () => {
  await assert.rejects(
    () => createFeeItem(clerk(), {
      programId: ids.prog, termId: ids.term, label: 'Tuition', amount: '45000',
    }),
    (e: unknown) => status(e) === 403,
  )
  await tuition()
  const p = await pay()
  assert.equal(p.amountPaise, 1000000)
})

test('only an administrator may waive', async () => {
  const item = await tuition()
  await assert.rejects(
    () => grantWaiver(clerk(), {
      studentId: ids.s1, feeItemId: item.id, amount: '5000', reason: 'merit scholarship',
    }),
    (e: unknown) => status(e) === 403,
  )
  const w = await grantWaiver(admin(), {
    studentId: ids.s1, feeItemId: item.id, amount: '5000', reason: 'merit scholarship',
  })
  assert.ok(w.id)
})

test('a student cannot read the dues report or somebody else s ledger', async () => {
  await assert.rejects(() => duesReport(student(ids.s1), ids.term), (e: unknown) => status(e) === 403)
  await assert.rejects(
    () => studentLedger(student(ids.s1), ids.s2, ids.term),
    (e: unknown) => status(e) === 403,
  )
  const own = await studentLedger(student(ids.s1), ids.s1, ids.term)
  assert.equal(own.studentId, ids.s1)
})

test('a lecturer has no business in the ledger', async () => {
  await assert.rejects(
    () => studentLedger(A({ id: ids.fac, role: 'faculty' }), ids.s1, ids.term),
    (e: unknown) => status(e) === 403,
  )
})

// --- charges and waivers ---------------------------------------------------

test('the same charge cannot be defined twice for a term', async () => {
  await tuition()
  await assert.rejects(() => tuition(), (e: unknown) => code(e) === 'exists')
  // ...but the same label in another term is a different charge
  await tuition({ termId: ids.term2 })
  assert.equal((await listFeeItems(clerk())).length, 2)
})

test('rupees typed by a clerk land as paise, never as a float', async () => {
  const item = await tuition({ label: 'Lab', amount: '1,234.56' })
  assert.equal(item.amountPaise, 123456)
})

test('a waiver larger than the charge is refused', async () => {
  const item = await tuition({ amount: '45000' })
  await assert.rejects(
    () => grantWaiver(admin(), {
      studentId: ids.s1, feeItemId: item.id, amount: '50000', reason: 'too generous',
    }),
    (e: unknown) => code(e) === 'waiver_exceeds_charge',
  )
})

test('the database refuses an oversized waiver even with the app check bypassed', async () => {
  const item = await tuition({ amount: '45000' })
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.insert(feeWaivers).values({
          institutionId: inst,
          studentId: ids.s1,
          feeItemId: item.id,
          amountPaise: 5_000_000,
          reason: 'straight past the application',
          grantedBy: ids.adm,
        }),
      ),
    saysDb(/cannot exceed the charge/),
  )
})

test('a charge cannot be lowered under a waiver already granted', async () => {
  const item = await tuition({ amount: '45000' })
  await grantWaiver(admin(), {
    studentId: ids.s1, feeItemId: item.id, amount: '40000', reason: 'full scholarship less hostel',
  })
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.update(feeItems).set({ amountPaise: 1_000_000 }).where(eq(feeItems.id, item.id)),
      ),
    saysDb(/below an existing waiver/),
  )
})

test('a waiver is granted, revised and revoked, and every step is on the trail', async () => {
  const item = await tuition()
  await grantWaiver(admin(), {
    studentId: ids.s1, feeItemId: item.id, amount: '5000', reason: 'merit scholarship',
  })
  const revised = await grantWaiver(admin(), {
    studentId: ids.s1, feeItemId: item.id, amount: '8000', reason: 'revised on appeal',
  })
  await revokeWaiver(admin(), { waiverId: revised.id, reason: 'appeal withdrawn by student' })

  const trail = await withTenant(inst, (tx) =>
    tx.select({ action: auditLog.action, reason: auditLog.reason }).from(auditLog),
  )
  assert.deepEqual(
    trail.map((t) => t.action).sort(),
    ['fee.waiver_granted', 'fee.waiver_revised', 'fee.waiver_revoked'],
  )
  assert.ok(trail.every((t) => (t.reason ?? '').length >= 5))
})

test('a waiver without a real reason is refused before it reaches the database', async () => {
  const item = await tuition()
  await assert.rejects(() =>
    grantWaiver(admin(), {
      studentId: ids.s1, feeItemId: item.id, amount: '5000', reason: 'x',
    }),
  )
})

// --- payments and receipts -------------------------------------------------

test('receipt numbers are sequential and unique', async () => {
  await tuition()
  const a = await pay()
  const b = await pay({ amount: '5000' })
  assert.equal(a.receiptNo, 'R-000001')
  assert.equal(b.receiptNo, 'R-000002')
})

test('two clerks taking money at the same time never share a receipt number', async () => {
  await tuition()
  const many = await Promise.all(
    Array.from({ length: 12 }, () => pay({ amount: '1000' })),
  )
  const numbers = new Set(many.map((p) => p.receiptNo))
  assert.equal(numbers.size, 12)
})

test('a receipt counter cannot be wound back', async () => {
  await tuition()
  await pay()
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.update(receiptCounters).set({ next: 1 }).where(eq(receiptCounters.institutionId, inst)),
      ),
    saysDb(/cannot move backwards/),
  )
})

test('money is only recorded against a student', async () => {
  await assert.rejects(
    () => pay({ studentId: ids.fac }),
    (e: unknown) => code(e) === 'not_a_student',
  )
})

test('a payment of zero or of nonsense is refused at the edge', async () => {
  await assert.rejects(() => pay({ amount: '0' }))
  await assert.rejects(() => pay({ amount: 'a lot' }))
  await assert.rejects(() => pay({ amount: '10.999' }))
})

test('reconciliation is audited and cannot happen twice', async () => {
  await tuition()
  const p = await pay()
  await reconcilePayment(clerk(), { paymentId: p.id, reason: 'matched HDFC statement line 42' })
  await assert.rejects(
    () => reconcilePayment(clerk(), { paymentId: p.id, reason: 'matched again somehow' }),
    (e: unknown) => code(e) === 'already_reconciled',
  )
  const trail = await paymentTrail(clerk(), p.id)
  assert.deepEqual(
    trail.map((t) => t.action),
    ['fee.payment_recorded', 'fee.payment_reconciled'],
  )
})

test('a recorded payment cannot be amended without a reason', async () => {
  await tuition()
  const p = await pay()
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.update(feePayments).set({ amountPaise: 1 }).where(eq(feePayments.id, p.id)),
      ),
    saysDb(/audited change/),
  )
  // With a reason in the same transaction, the same write goes through.
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'cheque bounced', true)`)
    await tx.update(feePayments).set({ amountPaise: 1 }).where(eq(feePayments.id, p.id))
  })
})

test('a receipt number is never reassigned, reason or not', async () => {
  await tuition()
  const p = await pay()
  await assert.rejects(
    () =>
      withTenant(inst, async (tx) => {
        await tx.execute(sql`select set_config('app.audit_reason', 'renumbering', true)`)
        await tx
          .update(feePayments)
          .set({ receiptNo: 'R-999999' })
          .where(eq(feePayments.id, p.id))
      }),
    saysDb(/cannot be reassigned/),
  )
})

test('a reconciled payment cannot be deleted at all', async () => {
  await tuition()
  const p = await pay()
  await reconcilePayment(clerk(), { paymentId: p.id, reason: 'matched bank statement' })
  await assert.rejects(
    () =>
      withTenant(inst, async (tx) => {
        await tx.execute(sql`select set_config('app.audit_reason', 'tidying up', true)`)
        await tx.delete(feePayments).where(eq(feePayments.id, p.id))
      }),
    saysDb(/reconciled payment cannot be deleted/),
  )
})

test('an unreconciled payment can be deleted, but only with a reason', async () => {
  await tuition()
  const p = await pay()
  await assert.rejects(
    () => withTenant(inst, (tx) => tx.delete(feePayments).where(eq(feePayments.id, p.id))),
    saysDb(/requires an audited reason/),
  )
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'entered twice by mistake', true)`)
    await tx.delete(feePayments).where(eq(feePayments.id, p.id))
  })
})

test('a receipt renders as a PDF', async () => {
  await tuition()
  const p = await pay()
  const data = await paymentForReceipt(student(ids.s1), p.id)
  const pdf = await receiptPdf({ ...data, institutionName: 'Fees College' })
  assert.equal(Buffer.from(pdf.subarray(0, 5)).toString(), '%PDF-')
  assert.ok(pdf.length > 500)
})

test('a student cannot fetch another student s receipt', async () => {
  await tuition()
  const p = await pay()
  await assert.rejects(
    () => paymentForReceipt(student(ids.s2), p.id),
    (e: unknown) => status(e) === 403,
  )
})

// --- the arithmetic, end to end -------------------------------------------

test('a ledger adds up: charges, waiver, part payment', async () => {
  const t = await tuition({ label: 'Tuition', amount: '45000' })
  await tuition({ label: 'Hostel', amount: '25000' })
  await grantWaiver(admin(), {
    studentId: ids.s1, feeItemId: t.id, amount: '5000', reason: 'merit scholarship',
  })
  const p1 = await pay({ amount: '30000' })
  await reconcilePayment(clerk(), { paymentId: p1.id, reason: 'cleared on 12 Jan' })
  await pay({ amount: '10000', method: 'cheque' })

  const l = await studentLedger(clerk(), ids.s1, ids.term)
  assert.equal(l.chargedPaise, 7_000_000)
  assert.equal(l.waivedPaise, 500_000)
  assert.equal(l.payablePaise, 6_500_000)
  assert.equal(l.paidPaise, 4_000_000)
  assert.equal(l.unreconciledPaise, 1_000_000)
  assert.equal(l.outstandingPaise, 2_500_000)
  assert.equal(l.overpaidPaise, 0)
  assert.equal(l.lines.length, 2)
})

test('a student is only charged for their own program', async () => {
  await tuition({ amount: '45000' })
  await tuition({ programId: ids.prog2, label: 'Tuition', amount: '90000' })

  const btech = await studentLedger(clerk(), ids.s1, ids.term)
  const mtech = await studentLedger(clerk(), ids.s3, ids.term)
  assert.equal(btech.payablePaise, 4_500_000)
  assert.equal(mtech.payablePaise, 9_000_000)
})

test('an overpayment is a credit, not negative dues', async () => {
  await tuition({ amount: '45000' })
  const p = await pay({ amount: '50000' })
  await reconcilePayment(clerk(), { paymentId: p.id, reason: 'paid full year in advance' })
  const l = await studentLedger(clerk(), ids.s1, ids.term)
  assert.equal(l.outstandingPaise, 0)
  assert.equal(l.overpaidPaise, 500_000)
})

test('the dues report ranks defaulters and skips students with nothing owed', async () => {
  await tuition({ amount: '45000' })
  const p = await pay({ amount: '45000' })
  await reconcilePayment(clerk(), { paymentId: p.id, reason: 'cleared' })

  const r = await duesReport(clerk(), ids.term)
  // s1 paid in full, s2 owes everything, s3 is in another program with no charge.
  assert.deepEqual(r.rows.map((x) => x.studentId), [ids.s2, ids.s1])
  assert.equal(r.rows[0]!.outstandingPaise, 4_500_000)
  assert.equal(r.rows[1]!.outstandingPaise, 0)
  assert.equal(r.defaulterCount, 1)
  assert.equal(r.totalOutstandingPaise, 4_500_000)
})

// --- tenancy --------------------------------------------------------------

test('another institution sees none of this, and RLS not the query says so', async () => {
  await tuition()
  await pay()

  const seen = await withTenant(other, async (tx) => ({
    items: await tx.select().from(feeItems),
    payments: await tx.select().from(feePayments),
    counters: await tx.select().from(receiptCounters),
  }))
  assert.deepEqual([seen.items.length, seen.payments.length, seen.counters.length], [0, 0, 0])
})

test('a session with no tenant set reads nothing rather than erroring', async () => {
  await tuition()
  const rows = await db.select().from(feeItems)
  assert.equal(rows.length, 0)
})

test('a clerk of another institution cannot reach into this one', async () => {
  await tuition()
  const p = await pay()
  const outsider = A({ institutionId: other })
  await assert.rejects(
    () => reconcilePayment(outsider, { paymentId: p.id, reason: 'not mine to touch' }),
    (e: unknown) => code(e) === 'no_such_payment',
  )
})
