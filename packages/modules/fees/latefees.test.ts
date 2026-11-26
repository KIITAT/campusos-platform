import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { localToday, setSingleOfficer } from '@campusos/module-finance/api'
import {
  cancelStudentCharge,
  createFeeItem,
  createScholarship,
  awardScholarship,
  chargeStudent,
  duesReport,
  grantWaiver,
  revokeWaiver,
  voidInvoice,
  issueInvoices,
  rejectClaim,
  verifyClaim,
  addBankAccount,
  claimTransfer,
  listStudentCharges,
  receivableReport,
  recordPayment,
  studentLedger,
  type Actor,
} from './api'

/**
 * Instalments are fee lines with a due date; what is overdue, first due
 * first; and late-fee rules that raise a student charge once per instalment
 * and slab (ACC-21, P1-03d). Dates are relative to the institution's today.
 */

// The late-fee functions do not exist until the fix; calls then fail on assertions, not on load.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (await import('./api')) as Record<string, any>

let n = 0
const SLUG = 'fees-latefees-'

interface Campus {
  id: string
  admin: Actor
  clerk: Actor
  s1: string
  s2: string
  termId: string
  programId: string
}

const iso = (day: string, delta: number) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Late Fees College', allowedEmailDomains: [`${tag}.test`] })
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
  const day = await withTenant(id, (tx) => localToday(tx, id))
  const dept = await academic.createDepartment(admin, { code: 'cse', name: 'CSE' })
  const program = await academic.createProgram(admin, { departmentId: dept.id, code: 'btech', name: 'BTech', level: 'undergraduate', durationTerms: 8 })
  const term = await academic.createTerm(admin, { code: 't1', name: 'Sem 1', startsOn: iso(day, -200), endsOn: iso(day, 100) })
  for (const p of [people[2]!, people[3]!]) {
    await academic.declareProgram(admin, { studentId: p.id, programId: program.id, declaredOn: iso(day, -230) })
  }
  await setSingleOfficer(admin, { enabled: true, reason: 'test fixture: one officer' })
  return { id, admin, clerk, s1: people[2]!.id, s2: people[3]!.id, termId: term.id, programId: program.id }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const today = (c: Campus) => withTenant(c.id, (tx) => localToday(tx, c.id))
const ago = async (c: Campus, k: number) => iso(await today(c), -k)
const ahead = async (c: Campus, k: number) => iso(await today(c), k)
const dmy = (day: string) => {
  const [y, m, d] = day.split('-')
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`
}
const code = (e: unknown) => (e as { code?: string }).code

const item = (c: Campus, label: string, amount: string, dueOn?: string) =>
  createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label, amount, dueOn })
const issue = (c: Campus) => issueInvoices(c.admin, { termId: c.termId })
/**
 * Moves the term's fee lines and invoices (every issue of them) k days into
 * the past, as if the office had issued them then; with a student, only that
 * student's invoice moves. Payments and due dates stay where they are.
 */
async function shiftIssues(c: Campus, k: number, studentId?: string) {
  if (!studentId) await authDb.execute(sql`update fee_items set created_at = created_at - make_interval(days => ${k}) where term_id = ${c.termId}::uuid`)
  const only = studentId ? sql` and student_id = ${studentId}` : sql``
  await authDb.execute(sql`update fee_invoices set issued_at = issued_at - make_interval(days => ${k}) where term_id = ${c.termId}::uuid${only}`)
  await authDb.execute(sql`update fee_invoices
     set versions_issued_at = (select array_agg(t - make_interval(days => ${k}) order by o) from unnest(versions_issued_at) with ordinality u(t, o))
   where term_id = ${c.termId}::uuid${only}`)
  await authDb
    .execute(sql`update fee_invoices
     set owed_at = (select coalesce(array_agg(t - make_interval(days => ${k}) order by o), '{}') from unnest(owed_at) with ordinality u(t, o))
   where term_id = ${c.termId}::uuid${only}`)
}
const issueAgo = async (c: Campus, k: number) => {
  await issue(c)
  await shiftIssues(c, k)
}
type L = { lines: { label: string; dueOn: string | null }[]; overduePaise: number; outstandingPaise: number; notYetInvoicedPaise: number; chargedPaise: number }
const ledger = async (c: Campus, s: string) => (await studentLedger(c.admin, s, c.termId)) as unknown as L
const cash = (c: Campus, studentId: string, amount: string, receivedAt?: string) =>
  recordPayment(c.clerk, { studentId, termId: c.termId, amount, method: 'cash', allowAdvance: true, receivedAt })
const run = (c: Campus): Promise<{ charged: number; totalPaise: number }> => withTenant(c.id, (tx) => api.chargeLateFees(c.admin, tx))
const backdate = (c: Campus, ruleId: string, days: number) =>
  authDb.execute(sql`update fee_late_fees set created_at = now() - make_interval(days => ${days}) where id = ${ruleId}`)
async function reconciled(c: Campus) {
  const r = await withTenant(c.id, (tx) => receivableReport(tx))
  assert.equal(r.differencePaise, 0)
  assert.equal(r.unattributedPaise, 0)
  assert.equal(r.mismatchCount, 0)
}
const lateCharges = async (c: Campus, studentId: string) =>
  (await listStudentCharges(c.admin, c.termId)).rows.filter((r) => r.studentId === studentId && r.state !== 'cancelled' && r.label.startsWith('Late fee'))

test('lines carry their due dates and the ledger says what is overdue', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  await item(c, 'Tuition II', '50000', await ahead(c, 30))
  await item(c, 'Library', '2000')
  await issue(c)
  const l = await ledger(c, c.s1)
  assert.equal(l.lines.find((x) => x.label === 'Tuition I')!.dueOn, await ago(c, 40))
  assert.equal(l.lines.find((x) => x.label === 'Library')!.dueOn, null)
  assert.equal(l.overduePaise, 5_200_000)
  await cash(c, c.s1, '30000')
  assert.equal((await ledger(c, c.s1)).overduePaise, 2_200_000)
  await cash(c, c.s1, '30000')
  const after = await ledger(c, c.s1)
  assert.equal(after.overduePaise, 0)
  assert.equal(after.outstandingPaise, 4_200_000)
})

test('waivers and credits settle the earliest instalment first', async () => {
  const c = await campus()
  const first = await item(c, 'Tuition I', '50000', await ago(c, 40))
  await item(c, 'Tuition II', '50000', await ahead(c, 30))
  await grantWaiver(c.admin, { studentId: c.s1, feeItemId: first.id, amount: '10000', reason: 'hardship case' })
  await issue(c)
  assert.equal((await ledger(c, c.s1)).overduePaise, 4_000_000)
  const rule = await createScholarship(c.admin, { code: 'MERIT', name: 'Merit', kind: 'merit', basis: 'fixed', amountPaise: '5000' })
  await awardScholarship(c.admin, { scholarshipId: rule.id, studentId: c.s1, termId: c.termId })
  assert.equal((await ledger(c, c.s1)).overduePaise, 3_500_000)
})

test('the dues list shows overdue', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  await item(c, 'Tuition II', '50000', await ahead(c, 30))
  await item(c, 'Library', '2000')
  await issue(c)
  await cash(c, c.s1, '50000')
  const r = (await duesReport(c.admin, c.termId)) as unknown as { rows: { studentId: string; overduePaise: number }[]; totalOverduePaise: number; overdueCount: number }
  const row = (s: string) => r.rows.find((x) => x.studentId === s)!
  assert.equal(row(c.s1).overduePaise, 200_000)
  assert.equal(row(c.s2).overduePaise, 5_200_000)
  assert.equal(r.totalOverduePaise, 5_400_000)
  assert.equal(r.overdueCount, 2)
})

test('a late fee is raised once for an instalment unpaid after the grace days', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  const first = await run(c)
  assert.equal(first.charged, 2)
  assert.equal(first.totalPaise, 100_000)
  const label = `Late fee: instalment due ${dmy(await ago(c, 40))}, unpaid after ${dmy(await ago(c, 30))}`
  const rows = await lateCharges(c, c.s1)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.label, label)
  assert.equal(rows[0]!.amountPaise, 50_000)
  assert.equal((await run(c)).charged, 0)
  assert.equal((await ledger(c, c.s1)).notYetInvoicedPaise, 50_000)
  await issueAgo(c, 45)
  assert.equal((await ledger(c, c.s1)).chargedPaise, 5_050_000)
  await reconciled(c)
})

test('paid by the cutoff escapes; paid after it does not', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await cash(c, c.s1, '50000', `${await ago(c, 35)}T06:00:00.000Z`)
  await cash(c, c.s2, '50000', `${await ago(c, 20)}T06:00:00.000Z`)
  const out = await run(c)
  assert.equal(out.charged, 1)
  assert.equal((await lateCharges(c, c.s2)).length, 1)
  assert.equal((await lateCharges(c, c.s1)).length, 0)
})

test('a cheque returned after the cutoff was never paid', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  const p = await recordPayment(c.clerk, {
    studentId: c.s1,
    termId: c.termId,
    amount: '50000',
    method: 'cheque',
    reference: '000123',
    drawerIfsc: 'SBIN0001234',
    drawerAccount: '12345678901',
    receivedAt: `${await ago(c, 35)}T06:00:00.000Z`,
    allowAdvance: true,
  })
  await api.bouncePayment(c.clerk, { paymentId: p.id, bouncedOn: await ago(c, 5), reason: 'funds insufficient' })
  await run(c)
  assert.equal((await lateCharges(c, c.s1)).length, 1)
})

test('a rule never reaches back before it was made', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '500' })
  await issueAgo(c, 45)
  assert.equal((await run(c)).charged, 0)
  await backdate(c, r.id, 25)
  assert.equal((await run(c)).charged, 0)
  await backdate(c, r.id, 35)
  assert.equal((await run(c)).charged, 2)
})

test('a cancelled late fee is not raised again', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await run(c)
  const [fee] = await lateCharges(c, c.s1)
  await cancelStudentCharge(c.admin, { chargeId: fee!.id, reason: 'waived by the principal' })
  assert.equal((await run(c)).charged, 0)
  assert.equal((await lateCharges(c, c.s1)).length, 0)
})

test('slabs: each rule once', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const a = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '500' })
  const b = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 25, amount: '1000' })
  await backdate(c, a.id, 400)
  await backdate(c, b.id, 400)
  await issueAgo(c, 45)
  await run(c)
  const amounts = (await lateCharges(c, c.s1)).map((r) => r.amountPaise).sort((x, y) => x - y)
  assert.deepEqual(amounts, [50_000, 100_000])
})

test('nothing invoiced, nothing late', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '500' })
  await backdate(c, r.id, 400)
  assert.equal((await run(c)).charged, 0)
})

test('the student is told', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await run(c)
  const titles = (
    await withTenant(c.id, (tx) => tx.execute(sql`select title from notifications where user_id = ${c.s1}`))
  ).rows as { title: string }[]
  assert.ok(titles.some((t) => t.title === 'Late fee added'))
})

test('who sets late fees', async () => {
  const c = await campus()
  await assert.rejects(api.createLateFee(c.clerk, { termId: c.termId, afterDays: 10, amount: '500' }), (e) => code(e) === 'forbidden')
  await assert.rejects(api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '0' }))
  await assert.rejects(api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '100001' }))
  await assert.rejects(api.createLateFee(c.admin, { termId: c.termId, afterDays: 366, amount: '500' }))
  const rule = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '500' })
  await assert.rejects(api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '600' }), (e) => code(e) === 'exists')
  assert.equal((await api.listLateFees(c.clerk, c.termId)).length, 1)
  await assert.rejects(api.removeLateFee(c.clerk, { lateFeeId: rule.id, reason: 'policy withdrawn' }), (e) => code(e) === 'forbidden')
  await api.removeLateFee(c.admin, { lateFeeId: rule.id, reason: 'policy withdrawn' })
  assert.equal((await api.listLateFees(c.clerk, c.termId)).length, 0)
  const actions = (
    await authDb.execute(sql`select action from audit_log where entity = 'fee_late_fees' and entity_id = ${rule.id}`)
  ).rows.map((r) => (r as { action: string }).action)
  assert.ok(actions.includes('fee.late_fee_created') && actions.includes('fee.late_fee_removed'))
})

test('late fees belong to their institution', async () => {
  const a = await campus()
  const b = await campus()
  const rule = await api.createLateFee(a.admin, { termId: a.termId, afterDays: 10, amount: '500' })
  const seen = await withTenant(b.id, (tx) => tx.execute(sql`select count(*)::int as n from fee_late_fees`))
  assert.equal((seen.rows[0] as { n: number }).n, 0)
  await assert.rejects(api.removeLateFee(b.admin, { lateFeeId: rule.id, reason: 'not mine at all' }), (e) => code(e) === 'no_such_late_fee')
})

test('an unpaid late fee is not itself a reason for another', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const a = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '500' })
  const b = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 25, amount: '1000' })
  await backdate(c, a.id, 400)
  await backdate(c, b.id, 400)
  await issueAgo(c, 45)
  // Paid after the first cutoff (30 days ago) and before the second (15 days ago).
  await cash(c, c.s1, '50000', `${await ago(c, 20)}T06:00:00.000Z`)
  await run(c)
  assert.deepEqual((await lateCharges(c, c.s1)).map((r) => r.amountPaise), [50_000])
  await issue(c)
  await run(c)
  assert.deepEqual((await lateCharges(c, c.s1)).map((r) => r.amountPaise), [50_000])
})

test('a charge raised after the cutoff is not a reason for a late fee on an instalment paid in time (review HIGH 1)', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await cash(c, c.s1, '50000', `${await ago(c, 39)}T06:00:00.000Z`)
  await cash(c, c.s2, '50000', `${await ago(c, 39)}T06:00:00.000Z`)
  assert.equal((await run(c)).charged, 0)
  await chargeStudent(c.clerk, { studentId: c.s1, termId: c.termId, label: 'Library fine', amount: '200' })
  await issue(c)
  assert.equal((await run(c)).charged, 0)
  assert.equal((await lateCharges(c, c.s1)).length, 0)
})

// Second review (Opus) HIGHs: what was owed at a cutoff is what had been invoiced to that student by then.

test('a student invoiced after an instalment fell due is not late for it (review 2 HIGH 1, late joiner)', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  // s2 joins late: invoiced today, for an instalment that fell due 40 days ago.
  await shiftIssues(c, -45, c.s2)
  await cash(c, c.s2, '50000')
  assert.equal((await run(c)).charged, 1)
  assert.equal((await lateCharges(c, c.s1)).length, 1)
  assert.equal((await lateCharges(c, c.s2)).length, 0)
})

test('an undated line added later is not owed at an earlier cutoff (review 2 HIGH 1)', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await cash(c, c.s1, '50000', `${await ago(c, 39)}T06:00:00.000Z`)
  await cash(c, c.s2, '50000', `${await ago(c, 39)}T06:00:00.000Z`)
  assert.equal((await run(c)).charged, 0)
  await item(c, 'Exam fee', '2000')
  await issue(c)
  assert.equal((await run(c)).charged, 0)
})

test('a line invoiced after its due date falls due on the day it is invoiced (review 2 HIGH 1)', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await cash(c, c.s1, '50000', `${await ago(c, 39)}T06:00:00.000Z`)
  await cash(c, c.s2, '50000', `${await ago(c, 39)}T06:00:00.000Z`)
  await item(c, 'Lab fee', '3000', await ago(c, 20))
  await issue(c)
  assert.equal((await run(c)).charged, 0, 'invoiced today: not late for a due date already past')
  // Ten days on, still unpaid: late, counted from the day it was invoiced.
  await shiftIssues(c, 10)
  assert.equal((await run(c)).charged, 2)
  const [fee] = await lateCharges(c, c.s1)
  assert.equal(fee!.label, `Late fee: instalment due ${dmy(await ago(c, 10))}, unpaid after ${dmy(await ago(c, 5))}`)
})

test('a late fee follows the student’s own instalments, not another batch’s (review 2 HIGH 2)', async () => {
  const c = await campus()
  const section = await academic.createSection(c.admin, { programId: c.programId, label: 'old', admissionYear: 2025 })
  await academic.addSectionMember(c.admin, { sectionId: section.id, userId: c.s2 })
  const s1Batch = Number(iso(await today(c), -230).slice(0, 4))
  assert.notEqual(s1Batch, 2025, 'fixture: s1 falls back to the year it was declared')
  await createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label: 'Tuition', amount: '50000', dueOn: await ago(c, 40), admissionYear: s1Batch })
  await createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label: 'Tuition', amount: '45000', dueOn: await ago(c, 30), admissionYear: 2025 })
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  assert.equal((await run(c)).charged, 2)
  assert.deepEqual((await lateCharges(c, c.s1)).map((x) => x.label), [`Late fee: instalment due ${dmy(await ago(c, 40))}, unpaid after ${dmy(await ago(c, 35))}`])
  assert.deepEqual((await lateCharges(c, c.s2)).map((x) => x.label), [`Late fee: instalment due ${dmy(await ago(c, 30))}, unpaid after ${dmy(await ago(c, 25))}`])
})

async function account(c: Campus) {
  const a = await addBankAccount(c.admin, {
    label: 'Fees account',
    accountName: 'Late Fees College',
    bankName: 'Indian Bank',
    branch: 'Patia',
    accountNumber: '50245763642',
    ifsc: 'idib000k717',
  })
  return a.id
}
const claimFor = async (c: Campus, accountId: string, studentId: string, transferredOn: string, utr: string) =>
  claimTransfer({ id: studentId, role: 'student', institutionId: c.id } as Actor, {
    termId: c.termId,
    accountId,
    mode: 'neft',
    remitterBank: 'State Bank of India',
    remitterIfsc: 'sbin0000078',
    accountHolder: 'A Parent',
    contactPhone: '+91 98765 43210',
    transferredOn,
    amount: '50000',
    utr,
  })

test('a claim dated by the cutoff counts while pending, and its verification keeps the student clear (review 2 HIGH 3)', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  const cl = await claimFor(c, await account(c), c.s1, await ago(c, 38), 'NEFTLATE00001')
  assert.equal((await run(c)).charged, 1)
  assert.equal((await lateCharges(c, c.s1)).length, 0)
  await verifyClaim(c.clerk, { claimId: cl.id, note: 'on the statement' })
  assert.equal((await run(c)).charged, 0)
  assert.equal((await lateCharges(c, c.s1)).length, 0)
  assert.equal((await lateCharges(c, c.s2)).length, 1)
})

test('a payment recorded later with its true date removes a late fee not yet invoiced (review 2 HIGH 3)', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  assert.equal((await run(c)).charged, 2)
  await cash(c, c.s1, '50000', `${await ago(c, 38)}T06:00:00.000Z`)
  await run(c)
  assert.equal((await lateCharges(c, c.s1)).length, 0)
  assert.equal((await lateCharges(c, c.s2)).length, 1)
  const actions = (
    await authDb.execute(sql`select action from audit_log where institution_id = ${c.id}::uuid and action = 'fee.late_fees_removed'`)
  ).rows
  assert.equal(actions.length, 1)
  await reconciled(c)
})

test('a rejected claim puts the late fee back (review 2 HIGH 3)', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  assert.equal((await run(c)).charged, 2)
  const cl = await claimFor(c, await account(c), c.s1, await ago(c, 38), 'NEFTLATE00002')
  await run(c)
  assert.equal((await lateCharges(c, c.s1)).length, 0, 'pending and dated in time: not late while it is checked')
  await rejectClaim(c.clerk, { claimId: cl.id, reason: 'no such transfer on the statement' })
  assert.equal((await run(c)).charged, 1)
  assert.equal((await lateCharges(c, c.s1)).length, 1)
})

test('an invoiced late fee stays when the payment turns up later', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await run(c)
  await issue(c)
  await cash(c, c.s1, '50000', `${await ago(c, 38)}T06:00:00.000Z`)
  await run(c)
  assert.equal((await lateCharges(c, c.s1)).length, 1)
})

// Opus fix verification (round 3): what was owed at an instalment is what had been invoiced, net of waivers, by then.

test('a category correction billed later raises no late fee for an earlier instalment (fix verification HIGH 1, F2)', async () => {
  const c = await campus()
  await createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label: 'Tuition', amount: '50000', dueOn: await ago(c, 40), category: 'general' })
  await createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label: 'Tuition', amount: '30000', dueOn: await ago(c, 40), category: 'sc' })
  await academic.setStudentProfile(c.admin, { studentId: c.s1, category: 'sc' })
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await cash(c, c.s1, '30000', `${await ago(c, 39)}T06:00:00.000Z`)
  await cash(c, c.s2, '50000', `${await ago(c, 39)}T06:00:00.000Z`)
  assert.equal((await run(c)).charged, 0)
  await academic.setStudentProfile(c.admin, { studentId: c.s1, category: 'general' })
  await issue(c)
  assert.equal((await run(c)).charged, 0)
  assert.equal((await lateCharges(c, c.s1)).length, 0)
})

test('a waiver revoked after the cutoff raises no late fee for that instalment (fix verification HIGH 1, F1)', async () => {
  const c = await campus()
  const tuition = await item(c, 'Tuition I', '50000', await ago(c, 40))
  const w = await grantWaiver(c.admin, { studentId: c.s1, feeItemId: tuition.id, amount: '10000', reason: 'hardship case' })
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await cash(c, c.s1, '40000', `${await ago(c, 39)}T06:00:00.000Z`)
  await cash(c, c.s2, '50000', `${await ago(c, 39)}T06:00:00.000Z`)
  assert.equal((await run(c)).charged, 0)
  await revokeWaiver(c.admin, { waiverId: (w as { id: string }).id, reason: 'granted in error' })
  assert.equal((await run(c)).charged, 0)
  assert.equal((await lateCharges(c, c.s1)).length, 0)
  await reconciled(c)
})

test('voiding and issuing an invoice again does not move the instalment or charge it twice (fix verification HIGH 2, G)', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  assert.equal((await run(c)).charged, 2)
  await issue(c)
  await voidInvoice(c.admin, { studentId: c.s1, termId: c.termId, reason: 'wrong name on it' })
  await issue(c)
  // As if the nightly runs had gone on for 20 days since the new invoice.
  await authDb.execute(sql`update fee_invoices set versions_issued_at = array[now() - interval '20 days'] where term_id = ${c.termId}::uuid and student_id = ${c.s1} and voided_at is null`)
  await authDb
    .execute(sql`update fee_invoices set owed_at = array[now() - interval '20 days'] where term_id = ${c.termId}::uuid and student_id = ${c.s1} and voided_at is null`)
  assert.equal((await run(c)).charged, 0)
  assert.equal((await lateCharges(c, c.s1)).length, 1)
})

test('a rule removed and added again does not charge an instalment twice (fix verification NOTE, R)', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const a = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, a.id, 400)
  await issueAgo(c, 45)
  assert.equal((await run(c)).charged, 2)
  await api.removeLateFee(c.admin, { lateFeeId: a.id, reason: 'typed the wrong amount' })
  const b = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, b.id, 400)
  assert.equal((await run(c)).charged, 0)
  assert.equal((await lateCharges(c, c.s1)).length, 1)
})

// Opus fix verification (round 4): the cap is per instalment, and a void before the day owes nothing at it.

test('a category correction in a two-instalment term raises no late fee for the paid instalment (fix verification 3 HIGH 1, P1)', async () => {
  const c = await campus()
  for (const [cat, amt] of [['general', '50000'], ['sc', '30000']] as const) {
    await createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label: 'Tuition I', amount: amt, dueOn: await ago(c, 40), category: cat })
    await createFeeItem(c.admin, { programId: c.programId, termId: c.termId, label: 'Tuition II', amount: amt, dueOn: await ahead(c, 30), category: cat })
  }
  await academic.setStudentProfile(c.admin, { studentId: c.s1, category: 'sc' })
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await cash(c, c.s1, '30000', `${await ago(c, 39)}T06:00:00.000Z`)
  await cash(c, c.s2, '50000', `${await ago(c, 39)}T06:00:00.000Z`)
  assert.equal((await run(c)).charged, 0)
  await academic.setStudentProfile(c.admin, { studentId: c.s1, category: 'general' })
  await issue(c)
  assert.equal((await run(c)).charged, 0)
  assert.equal((await lateCharges(c, c.s1)).length, 0)
})

test('a waiver revoked in a two-instalment term raises no late fee for the paid instalment (fix verification 3 HIGH 1, P2)', async () => {
  const c = await campus()
  const t1 = await item(c, 'Tuition I', '50000', await ago(c, 40))
  await item(c, 'Tuition II', '50000', await ahead(c, 30))
  const w = await grantWaiver(c.admin, { studentId: c.s1, feeItemId: t1.id, amount: '10000', reason: 'hardship case' })
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await cash(c, c.s1, '40000', `${await ago(c, 39)}T06:00:00.000Z`)
  await cash(c, c.s2, '50000', `${await ago(c, 39)}T06:00:00.000Z`)
  assert.equal((await run(c)).charged, 0)
  await revokeWaiver(c.admin, { waiverId: (w as { id: string }).id, reason: 'granted in error' })
  assert.equal((await run(c)).charged, 0)
  assert.equal((await lateCharges(c, c.s1)).length, 0)
  await reconciled(c)
})

test('an invoice voided before the due day owes nothing at it, whatever is invoiced later (fix verification 3 HIGH 2, P5)', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 5, amount: '500' })
  await backdate(c, r.id, 400)
  await issueAgo(c, 45)
  await cash(c, c.s2, '50000', `${await ago(c, 39)}T06:00:00.000Z`)
  await voidInvoice(c.admin, { studentId: c.s1, termId: c.termId, reason: 'issued in error, not admitted yet' })
  // As if the void had been 44 days ago, before the due day.
  await authDb.execute(sql`update fee_invoices set voided_at = now() - interval '44 days', owed_at[cardinality(owed_at)] = now() - interval '44 days'
     where term_id = ${c.termId}::uuid and student_id = ${c.s1}`)
  await issue(c)
  assert.equal((await run(c)).charged, 0)
  assert.equal((await lateCharges(c, c.s1)).length, 0)
})
