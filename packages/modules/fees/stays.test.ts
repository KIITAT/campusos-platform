import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  chargeStayWithin,
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
  assert.equal(again, null)
  const rows = await charges(c.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.sourceId, `a1:${c.termId}`)
  assert.equal(rows[0]!.label, 'Hostel A-101, t1 (91 of 146 days)')
})

test('a stay covering the whole term is charged the whole fee, with no proration note', async () => {
  const c = await campus()
  await withTenant(c.id, (tx) => chargeStayWithin(tx, c.id, c.admin.id, stay(c.studentId), c.termId))
  const [row] = await charges(c.id)
  assert.equal(row!.amountPaise, 1_460_000)
  assert.equal(row!.label, 'Hostel A-101, t1')
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
  assert.deepEqual(out, { invoiced: ['t1'] })
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
