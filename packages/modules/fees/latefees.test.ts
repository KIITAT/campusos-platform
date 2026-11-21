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
  duesReport,
  grantWaiver,
  issueInvoices,
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
  (await listStudentCharges(c.admin, c.termId)).rows.filter((r) => r.studentId === studentId && r.label.startsWith('Late fee'))

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
  const rule = await createScholarship(c.admin, { code: 'MERIT', name: 'Merit', kind: 'merit', basis: 'fixed', amountPaise: '500' })
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
  await issue(c)
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
  await issue(c)
  assert.equal((await ledger(c, c.s1)).chargedPaise, 5_050_000)
  await reconciled(c)
})

test('paid by the cutoff escapes; paid after it does not', async () => {
  const c = await campus()
  await item(c, 'Tuition I', '50000', await ago(c, 40))
  const r = await api.createLateFee(c.admin, { termId: c.termId, afterDays: 10, amount: '500' })
  await backdate(c, r.id, 400)
  await issue(c)
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
  await issue(c)
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
  await issue(c)
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
  await issue(c)
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
  await issue(c)
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
  await issue(c)
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
