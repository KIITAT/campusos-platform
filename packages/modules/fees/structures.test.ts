import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { setSingleOfficer } from '@campusos/module-finance/api'
import {
  awardScholarship,
  createFeeItem,
  createScholarship,
  grantWaiver,
  issueInvoices,
  receivableReport,
  studentLedger,
  type Actor,
} from './api'

/**
 * Fee lines for a batch or a category: a student is charged the most specific
 * line of each label (ACC-21, P1-03d). The batch is the section's admission
 * year, else the declaration year; the category is the reservation category on
 * the student's profile (P1-12a).
 */

let n = 0
const SLUG = 'fees-structures-'

interface Campus {
  id: string
  admin: Actor
  clerk: Actor
  s1: string
  s2: string
  s3: string
  termId: string
  programId: string
}

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Structures College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'One Student' },
      { email: `s2@${tag}.test`, institutionId: id, role: 'student', name: 'Two Student' },
      { email: `s3@${tag}.test`, institutionId: id, role: 'student', name: 'Three Student' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const clerk: Actor = { id: people[1]!.id, email: `clerk@${tag}.test`, role: 'accounts_staff', institutionId: id }
  const dept = await academic.createDepartment(admin, { code: 'cse', name: 'CSE' })
  const program = await academic.createProgram(admin, { departmentId: dept.id, code: 'btech', name: 'BTech', level: 'undergraduate', durationTerms: 8 })
  const term = await academic.createTerm(admin, { code: 't1', name: 'Sem 1', startsOn: '2026-01-05', endsOn: '2026-05-30' })
  const section = await academic.createSection(admin, { programId: program.id, label: 'a', admissionYear: 2026 })
  for (const p of [people[2]!, people[3]!]) {
    await academic.addSectionMember(admin, { sectionId: section.id, userId: p.id })
    await academic.declareProgram(admin, { studentId: p.id, programId: program.id, declaredOn: '2025-07-01' })
  }
  // s3: declared in 2024, in no section.
  await academic.declareProgram(admin, { studentId: people[4]!.id, programId: program.id, declaredOn: '2024-07-01' })
  await setSingleOfficer(admin, { enabled: true, reason: 'test fixture: one officer' })
  return { id, admin, clerk, s1: people[2]!.id, s2: people[3]!.id, s3: people[4]!.id, termId: term.id, programId: program.id }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

interface Line {
  label: string
  amount: string
  admissionYear?: number | string
  category?: string
}
const item = (c: Campus, l: Line) => createFeeItem(c.admin, { programId: c.programId, termId: c.termId, ...l })
const category = (c: Campus, studentId: string, cat: string) => academic.setStudentProfile(c.admin, { studentId, category: cat })
const ledger = (c: Campus, s: string) => studentLedger(c.admin, s, c.termId)
const code = (e: unknown) => (e as { code?: string }).code
async function reconciled(c: Campus) {
  const r = await withTenant(c.id, (tx) => receivableReport(tx))
  assert.equal(r.differencePaise, 0)
  assert.equal(r.unattributedPaise, 0)
  assert.equal(r.mismatchCount, 0)
}

test('a line per batch and category, each once', async () => {
  const c = await campus()
  await item(c, { label: 'Tuition', amount: '1000' })
  await item(c, { label: 'Tuition', amount: '1200', admissionYear: 2026 })
  await item(c, { label: 'Tuition', amount: '3000', category: 'sc' })
  await item(c, { label: 'Tuition', amount: '3500', admissionYear: '2026', category: 'sc' })
  await assert.rejects(item(c, { label: 'Tuition', amount: '1300', admissionYear: 2026 }), (e) => code(e) === 'exists')
  await assert.rejects(item(c, { label: 'Tuition', amount: '1300', category: 'nri' }))
  await assert.rejects(item(c, { label: 'Tuition', amount: '1300', admissionYear: 1800 }))
})

test('a batch line replaces the programme line of the same label; the batch is the section year, else the declaration year', async () => {
  const c = await campus()
  await item(c, { label: 'Tuition', amount: '1000' })
  await item(c, { label: 'Tuition', amount: '1200', admissionYear: 2026 })
  await item(c, { label: 'Tuition', amount: '1100', admissionYear: 2025 })
  await item(c, { label: 'Tuition', amount: '1050', admissionYear: 2024 })
  await item(c, { label: 'Library', amount: '20' })
  await issueInvoices(c.admin, { termId: c.termId })
  assert.equal((await ledger(c, c.s1)).chargedPaise, 122_000)
  assert.equal((await ledger(c, c.s3)).chargedPaise, 107_000)
  assert.deepEqual((await ledger(c, c.s1)).lines.map((l) => l.label).sort(), ['Library', 'Tuition'])
  await reconciled(c)
})

test('a category line beats a batch line; another label adds', async () => {
  const c = await campus()
  await item(c, { label: 'Tuition', amount: '1000' })
  await item(c, { label: 'Tuition', amount: '1200', admissionYear: 2026 })
  await item(c, { label: 'Tuition', amount: '3000', category: 'sc' })
  await item(c, { label: 'Concession fee', amount: '50', category: 'sc' })
  await category(c, c.s1, 'sc')
  await issueInvoices(c.admin, { termId: c.termId })
  assert.equal((await ledger(c, c.s1)).chargedPaise, 305_000)
  assert.equal((await ledger(c, c.s2)).chargedPaise, 120_000)
  await reconciled(c)
})

test('batch and category together beat either alone', async () => {
  const c = await campus()
  await item(c, { label: 'Tuition', amount: '1200', admissionYear: 2026 })
  await item(c, { label: 'Tuition', amount: '3000', category: 'sc' })
  await item(c, { label: 'Tuition', amount: '3500', admissionYear: 2026, category: 'sc' })
  await category(c, c.s1, 'sc')
  await issueInvoices(c.admin, { termId: c.termId })
  assert.equal((await ledger(c, c.s1)).chargedPaise, 350_000)
})

test('a waiver is only on the line the student is charged', async () => {
  const c = await campus()
  const general = await item(c, { label: 'Tuition', amount: '1000' })
  const batch = await item(c, { label: 'Tuition', amount: '1200', admissionYear: 2026 })
  await assert.rejects(
    grantWaiver(c.admin, { studentId: c.s1, feeItemId: general.id, amount: '10', reason: 'hardship case' }),
    (e) => code(e) === 'item_not_charged',
  )
  await grantWaiver(c.admin, { studentId: c.s1, feeItemId: batch.id, amount: '10', reason: 'hardship case' })
})

test("a proportional award is a share of the student's own lines", async () => {
  const c = await campus()
  await item(c, { label: 'Tuition', amount: '1000' })
  await item(c, { label: 'Tuition', amount: '1200', admissionYear: 2026 })
  const rule = await createScholarship(c.admin, { code: 'HALF', name: 'Half', kind: 'merit', basis: 'proportional', percentBps: 5000 })
  const award = await awardScholarship(c.admin, { scholarshipId: rule.id, studentId: c.s1, termId: c.termId })
  assert.equal(award.amountPaise, 60_000)
})

test('a category change re-prices the next issue upward only', async () => {
  const c = await campus()
  await item(c, { label: 'Tuition', amount: '1000' })
  await item(c, { label: 'Tuition', amount: '3000', category: 'sc' })
  await issueInvoices(c.admin, { termId: c.termId })
  assert.equal((await ledger(c, c.s1)).chargedPaise, 100_000)
  await category(c, c.s1, 'sc')
  await issueInvoices(c.admin, { termId: c.termId })
  assert.equal((await ledger(c, c.s1)).chargedPaise, 300_000)
  await reconciled(c)
  await category(c, c.s1, '')
  await issueInvoices(c.admin, { termId: c.termId })
  assert.equal((await ledger(c, c.s1)).chargedPaise, 300_000)
})
