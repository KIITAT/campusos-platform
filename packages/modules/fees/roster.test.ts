import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, inArray } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  assessAid,
  chargeStudent,
  createFeeItem,
  duesReport,
  issueInvoices,
  recordPayment,
  type Actor,
} from './api'

/**
 * ACC-19 and NEW-16: who is billed for a term.
 *
 * The roster used to be every section member, for every section's programme:
 * withdrawn and graduated students were billed each term, a student admitted
 * into a programme but not yet put in a section was never billed, an elective
 * in another programme's section billed that programme's fees, and the dues
 * report listed a two-programme student once per programme.
 *
 * Fees now follow programme declarations whose dates overlap the term
 * (decision 189), for a school's classes as for a college's degrees.
 */

const SLUG = 'fees-roster'
let inst = ''
const ids: Record<string, string> = {}
const prog: Record<string, string> = {}
const term = { college: '', school: '' }

const as = (id: string, role: Actor['role']): Actor => ({ id, role, institutionId: inst, email: null })
const adm = () => as(ids.adm!, 'institution_admin')
const clerk = () => as(ids.clerk!, 'accounts_staff')
const STUDENTS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'] as const
const nameOf = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id

async function declare(student: string, program: string, declaredOn: string, end?: { status: 'withdrawn' | 'completed'; endedOn: string }) {
  const d = await academic.declareProgram(adm(), { studentId: ids[student]!, programId: prog[program]!, declaredOn, isPrimary: false })
  if (end) await academic.endStudentProgram(adm(), { studentProgramId: d.id, ...end })
  return d
}

before(async () => {
  await authDb.delete(institutions).where(inArray(institutions.slug, [SLUG]))
  const [row] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Roster College and School', allowedEmailDomains: ['roster.test'] })
    .returning({ id: institutions.id })
  inst = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@roster.test', institutionId: inst, role: 'institution_admin' as const, name: 'Adm' },
      { email: 'clerk@roster.test', institutionId: inst, role: 'accounts_staff' as const, name: 'Clerk' },
      ...STUDENTS.map((s) => ({ email: `${s}@roster.test`, institutionId: inst, role: 'student' as const, name: s })),
    ])
    .returning({ id: users.id, email: users.email })
  for (const p of people) ids[p.email!.split('@')[0]!] = p.id

  const dept = await academic.createDepartment(adm(), { code: 'gen', name: 'General' })
  for (const [code, level, durationTerms] of [
    ['BT', 'undergraduate', 8],
    ['MT', 'postgraduate', 4],
    ['C5', 'certificate', 2],
    ['C6', 'certificate', 2],
  ] as const) {
    prog[code] = (await academic.createProgram(adm(), { departmentId: dept.id, code, name: code, level, durationTerms })).id
  }
  term.college = (await academic.createTerm(adm(), { code: 'AUT26', name: 'Autumn 2026', startsOn: '2026-07-01', endsOn: '2026-12-01' })).id
  term.school = (await academic.createTerm(adm(), { code: 'SES26', name: 'Session 2026-27, term 1', startsOn: '2026-04-01', endsOn: '2026-09-30' })).id

  const section = async (program: string, label: string, admissionYear: number, members: string[]) => {
    const s = await academic.createSection(adm(), { programId: prog[program]!, label, admissionYear })
    for (const m of members) await academic.addSectionMember(adm(), { sectionId: s.id, userId: ids[m]! })
  }
  await section('BT', 'a', 2025, ['s1', 's2', 's3', 's4', 's6', 's7', 's10'])
  await section('MT', 'b', 2025, ['s6', 's10'])
  await section('C5', 'a', 2025, ['s9'])
  await section('C6', 'a', 2026, ['s9'])

  await declare('s1', 'BT', '2025-07-01')
  await declare('s2', 'BT', '2025-07-01', { status: 'withdrawn', endedOn: '2026-03-01' })
  await declare('s3', 'BT', '2025-07-01', { status: 'completed', endedOn: '2026-05-30' })
  // s4 sits in the section and was never declared.
  await declare('s5', 'BT', '2026-06-20') // admitted, not yet in a section
  await declare('s6', 'BT', '2025-07-01')
  await declare('s6', 'MT', '2025-07-01')
  await declare('s7', 'BT', '2025-07-01', { status: 'withdrawn', endedOn: '2026-08-15' }) // left mid-term
  // s8 reads nothing here and owes a backlog paper.
  await declare('s9', 'C5', '2025-04-01', { status: 'completed', endedOn: '2026-03-31' }) // promoted...
  await declare('s9', 'C6', '2026-04-01') // ...into Class 6
  await declare('s10', 'MT', '2025-07-01') // an elective in BT's section, reading MT

  const item = (program: string, termId: string, label: string, amount: string) =>
    createFeeItem(adm(), { programId: prog[program]!, termId, label, amount })
  await item('BT', term.college, 'Tuition', '45000')
  await item('MT', term.college, 'Tuition', '60000')
  await item('C5', term.school, 'Tuition', '20000')
  await item('C6', term.school, 'Tuition', '25000')
  await chargeStudent(clerk(), { studentId: ids.s8!, termId: term.college, label: 'Backlog paper', amount: '500' })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

const billed = (r: { issued: { studentId: string; chargedPaise: number }[] }) =>
  Object.fromEntries(r.issued.map((i) => [nameOf(i.studentId), i.chargedPaise]))

test('a college term bills the students enrolled in it, by their programmes', async () => {
  const r = await issueInvoices(adm(), { termId: term.college })
  assert.deepEqual(billed(r), {
    s1: 4500000,
    s5: 4500000, // declared, in no section yet: billed
    s6: 10500000, // reads both programmes
    s7: 4500000, // withdrew mid-term: billed for the term they were in
    s8: 50000, // their own backlog charge, and nothing of a programme
    s10: 6000000, // MT only: a BT section for an elective is not BT's fees
  })
  // Withdrawn and graduated before the term: not billed. Never declared: not
  // billed, and said so.
  const missing = (r as unknown as { notEnrolled?: { studentId: string; programCode: string }[] }).notEnrolled ?? null
  assert.ok(missing, 'the answer names who sits in a section without being enrolled')
  assert.deepEqual(
    missing.map((m) => `${nameOf(m.studentId)}:${m.programCode}`).sort(),
    ['s4:BT'],
  )
})

test('a school term bills the class the student is in, not the one they left', async () => {
  const r = await issueInvoices(adm(), { termId: term.school })
  assert.deepEqual(billed(r), { s9: 2500000 })
})

test('a past term is billed the same way after a student moves on', async () => {
  // s1 completes after the term, then a late charge reaches the term.
  const [d] = (await academic.listStudentPrograms(adm(), { studentId: ids.s1 })) as { id: string; status: string }[]
  await academic.endStudentProgram(adm(), { studentProgramId: d!.id, status: 'completed', endedOn: '2027-01-15' })
  await createFeeItem(adm(), { programId: prog.BT!, termId: term.college, label: 'Library', amount: '1000' })
  const r = await issueInvoices(adm(), { termId: term.college })
  assert.equal(billed(r).s1, 100000)
  assert.equal(billed(r).s2, undefined)
})

test('the dues report has one row per student, and keeps a leaver who owes', async () => {
  await recordPayment(clerk(), { studentId: ids.s1!, termId: term.college, amount: '45000', method: 'cash' })
  const dues = await duesReport(clerk(), term.college)
  const rows = dues.rows.map((r) => nameOf(r.studentId))
  assert.equal(new Set(rows).size, rows.length, `one row each: ${rows.join(', ')}`)
  assert.ok(rows.includes('s6'))
  assert.equal(dues.rows.find((r) => r.studentId === ids.s6)!.programCode, 'BT, MT')
  assert.ok(rows.includes('s7'), 'left mid-term and owes: still a defaulter')
  for (const gone of ['s2', 's3', 's4']) assert.ok(!rows.includes(gone), `${gone} owes nothing this term`)
  assert.equal(
    dues.totalOutstandingPaise,
    dues.rows.reduce((n, r) => n + r.outstandingPaise, 0),
  )
  // Tuition 45,000 and the late Library 1,000 in BT, and 60,000 in MT: once.
  assert.equal(dues.rows.find((r) => r.studentId === ids.s6)!.outstandingPaise, 10600000)
})

test('a scholarship is assessed on the programmes the student is enrolled in', async () => {
  const s4 = await assessAid(adm(), { studentId: ids.s4!, termId: term.college })
  assert.equal(s4.chargedPaise, 0)
  const s10 = await assessAid(adm(), { studentId: ids.s10!, termId: term.college })
  assert.equal(s10.chargedPaise, 6000000)
})

test('a declaration ended the day it was made bills nothing', async () => {
  // A mistaken declaration, withdrawn the same day, mid-term (review of P0-06).
  await declare('s8', 'MT', '2026-08-01', { status: 'withdrawn', endedOn: '2026-08-01' })
  const s8 = await assessAid(adm(), { studentId: ids.s8!, termId: term.college })
  assert.equal(s8.chargedPaise, 0)
})
