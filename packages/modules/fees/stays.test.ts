import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, isNull, like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  chargeStayWithin,
  chargeStudentWithin,
  endStayWithin,
  issueInvoices,
  proratedPaise,
  stayDays,
  termOnWithin,
  type Actor,
  type Stay,
} from './api'
import { studentCharges } from './schema'

/**
 * A stay -- a hostel bed, a bus seat -- charged per term through the student's
 * fee account, prorated by the nights inside the term, and re-raised for the
 * nights actually used when it ends before the term is invoiced (ACC-28).
 */

let n = 0
const SLUG = 'fees-stays-'

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Stay College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'One Student' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const dept = await academic.createDepartment(admin, { code: 'cse', name: 'CSE' })
  const program = await academic.createProgram(admin, {
    departmentId: dept.id, code: 'btech', name: 'BTech', level: 'undergraduate', durationTerms: 8,
  })
  // 146 days, 5 January to 30 May inclusive.
  const term = await academic.createTerm(admin, { code: 't1', name: 'Sem 1', startsOn: '2026-01-05', endsOn: '2026-05-30' })
  await academic.declareProgram(admin, { studentId: people[1]!.id, programId: program.id, declaredOn: '2025-07-01' })
  return { id, admin, studentId: people[1]!.id, termId: term.id }
}

const stay = (studentId: string, over: Partial<Stay> = {}): Stay => ({
  sourceModule: 'hostel',
  stayId: 'a1',
  studentId,
  label: 'Hostel A-101',
  termFeePaise: 1_460_000,
  from: '2026-01-01',
  until: null,
  ...over,
})

const charges = (id: string) =>
  withTenant(id, (tx) => tx.select().from(studentCharges).where(eq(studentCharges.sourceModule, 'hostel')))

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('stay days are nights inside the term', () => {
  const term = { id: 't', code: 't1', startsOn: '2026-01-05', endsOn: '2026-05-30' }
  assert.deepEqual(stayDays(term, '2026-01-01', null), { days: 146, termDays: 146 })
  assert.equal(stayDays(term, '2026-03-01', null).days, 91)
  assert.equal(stayDays(term, '2026-01-05', '2026-01-06').days, 1)
  assert.equal(stayDays(term, '2026-06-01', null).days, 0)
  assert.equal(stayDays(term, '2025-12-01', '2026-01-05').days, 0)
  assert.equal(proratedPaise(1_460_000, 91, 146), 910_000)
})

test('a stay is charged once per term, prorated', async () => {
  const c = await campus()
  const s = stay(c.studentId, { from: '2026-03-01' })
  const first = await withTenant(c.id, (tx) => chargeStayWithin(tx, c.id, c.admin.id, s, c.termId))
  assert.equal(first?.amountPaise, 910_000)
  const again = await withTenant(c.id, (tx) => chargeStayWithin(tx, c.id, c.admin.id, s, c.termId))
  assert.equal(again?.existing, true)
  const rows = await charges(c.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.sourceId, `a1:${c.termId}`)
  assert.equal(rows[0]!.label, 'Hostel A-101, T1 (91 of 146 days)')
})

test('a stay covering the whole term is charged the whole fee, with no proration note', async () => {
  const c = await campus()
  await withTenant(c.id, (tx) => chargeStayWithin(tx, c.id, c.admin.id, stay(c.studentId), c.termId))
  const [row] = await charges(c.id)
  assert.equal(row!.amountPaise, 1_460_000)
  assert.equal(row!.label, 'Hostel A-101, T1')
})

test('ending a stay before invoicing re-raises it for the days used', async () => {
  const c = await campus()
  const s = stay(c.studentId)
  await withTenant(c.id, (tx) => chargeStayWithin(tx, c.id, c.admin.id, s, c.termId))
  const out = await withTenant(c.id, (tx) => endStayWithin(tx, c.id, c.admin.id, { ...s, until: '2026-02-04' }))
  assert.deepEqual(out, { invoiced: [] })
  const rows = await charges(c.id)
  const live = rows.filter((r) => !r.cancelledAt)
  assert.equal(live.length, 1)
  assert.equal(live[0]!.amountPaise, 300_000)
  const gone = rows.find((r) => r.cancelledAt)!
  assert.equal(gone.cancelReason, 'stay ended on 2026-02-04')
})

test('an invoiced stay charge is left for a waiver', async () => {
  const c = await campus()
  const s = stay(c.studentId)
  await withTenant(c.id, (tx) => chargeStayWithin(tx, c.id, c.admin.id, s, c.termId))
  await issueInvoices(c.admin, { termId: c.termId })
  const out = await withTenant(c.id, (tx) => endStayWithin(tx, c.id, c.admin.id, { ...s, until: '2026-02-04' }))
  assert.deepEqual(out, { invoiced: ['T1'] })
  const live = await withTenant(c.id, (tx) =>
    tx.select().from(studentCharges).where(and(eq(studentCharges.sourceModule, 'hostel'))),
  )
  assert.equal(live.length, 1)
  assert.equal(live[0]!.cancelledAt, null)
  assert.equal(live[0]!.amountPaise, 1_460_000)
})

test('the term a day falls in', async () => {
  const c = await campus()
  const t = await withTenant(c.id, (tx) => termOnWithin(tx, '2026-03-01'))
  assert.equal(t?.id, c.termId)
  assert.equal(await withTenant(c.id, (tx) => termOnWithin(tx, '2026-07-01')), null)
})

// --- review BLOCKER 1: invoicing and ending a stay -------------------------------

const waitFor = async (probe: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await probe()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.fail('timed out waiting for the interleaving')
}

test('ending a stay waits for an invoice run on the term, then leaves what the invoice priced', async () => {
  const c = await campus()
  const s = stay(c.studentId)
  await withTenant(c.id, (tx) => chargeStayWithin(tx, c.id, c.admin.id, s, c.termId))
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  let ready!: () => void
  const locked = new Promise<void>((r) => (ready = r))
  // An invoice run, as issueChunk takes it: the term lock, then the charges marked as billed.
  const invoice = withTenant(c.id, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'fees.issue:' + c.termId}, 0))`)
    await tx.update(studentCharges).set({ invoicedAt: new Date() }).where(eq(studentCharges.termId, c.termId))
    ready()
    await gate
  })
  await locked
  let done = false
  const ended = withTenant(c.id, (tx) => endStayWithin(tx, c.id, c.admin.id, { ...s, until: '2026-02-04' })).then((r) => ((done = true), r))
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(done, false, 'ending a stay must wait for the invoice run')
  open()
  await invoice
  assert.deepEqual(await ended, { invoiced: ['T1'] })
  const rows = (await charges(c.id)).filter((r) => !r.cancelledAt)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.amountPaise, 1_460_000)
})

test('an invoice marks only the charges it priced as billed', async () => {
  const c = await campus()
  await withTenant(c.id, (tx) => chargeStayWithin(tx, c.id, c.admin.id, stay(c.studentId), c.termId))
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  let ready!: () => void
  let holder = 0
  const held = new Promise<void>((r) => (ready = r))
  // Hold the priced charge's row after the invoice has priced, so its marking waits and a charge can land in between. A row lock, not a table lock: other test files invoice in the same database at the same time.
  const intruder = withTenant(c.id, async (tx) => {
    const [own] = await tx.select({ id: studentCharges.id }).from(studentCharges).where(isNull(studentCharges.cancelledAt)).for('update')
    assert.ok(own)
    holder = Number((await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid)
    ready()
    await gate
    await chargeStudentWithin(tx, c.id, c.admin.id, { studentId: c.studentId, termId: c.termId, label: 'Late library fine', amountPaise: 5000 })
  })
  await held
  const invoiced = issueInvoices(c.admin, { termId: c.termId })
  await waitFor(async () => {
    const r = await authDb.execute(sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and ${holder} = any(pg_blocking_pids(pid))`)
    return r.rows.length > 0
  })
  open()
  await intruder
  await invoiced
  const rows = await withTenant(c.id, (tx) => tx.select().from(studentCharges).where(isNull(studentCharges.cancelledAt)))
  const late = rows.find((r) => r.label === 'Late library fine')!
  assert.equal(late.invoicedAt, null, 'a charge the invoice never priced is not billed')
  assert.ok(rows.find((r) => r.label !== 'Late library fine')!.invoicedAt)
})
