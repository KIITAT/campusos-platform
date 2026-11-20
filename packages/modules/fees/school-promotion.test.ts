import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { createFeeItem, issueInvoices, type Actor } from './api'
import { enrolledPrograms } from './api/enrolment'

/**
 * MG-04 and decision 189: a school year's promotion ends one declaration and
 * starts the next, and billing, which reads declarations, charges the class a
 * student is in for each term without being told anything.
 */

const SLUG = 'fees-school-promotion'
let inst = ''
const ids: Record<string, string> = {}
const prog: Record<string, string> = {}
const term = { old: '', next: '' }
const nameOf = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id
const adm = (): Actor => ({ id: ids.adm!, role: 'institution_admin', institutionId: inst, email: null })

before(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  const [row] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Promotion School', allowedEmailDomains: ['promo.test'] }).returning({ id: institutions.id })
  inst = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@promo.test', institutionId: inst, role: 'institution_admin' as const, name: 'Adm' },
      { email: 'up@promo.test', institutionId: inst, role: 'student' as const, name: 'Promoted' },
      { email: 'down@promo.test', institutionId: inst, role: 'student' as const, name: 'Detained' },
    ])
    .returning({ id: users.id, email: users.email })
  for (const p of people) ids[p.email!.split('@')[0]!] = p.id
  const dept = await academic.createDepartment(adm(), { code: 'sch', name: 'School' })
  for (const code of ['C6', 'C7']) {
    prog[code] = (await academic.createProgram(adm(), { departmentId: dept.id, code, name: code, level: 'school', durationTerms: 2 })).id
  }
  term.old = (await academic.createTerm(adm(), { code: 'S25', name: 'Session 2025-26', startsOn: '2025-10-01', endsOn: '2026-03-31' })).id
  term.next = (await academic.createTerm(adm(), { code: 'S26', name: 'Session 2026-27', startsOn: '2026-04-01', endsOn: '2026-09-30' })).id
  for (const [program, termId, amount] of [
    ['C6', term.old, '10000'],
    ['C7', term.old, '12000'],
    ['C6', term.next, '21000'],
    ['C7', term.next, '23000'],
  ] as const) {
    await createFeeItem(adm(), { programId: prog[program]!, termId, label: 'Tuition', amount })
  }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

const programsFor = (student: string, termId: string) =>
  withTenant(inst, async (tx) => (await enrolledPrograms(tx, ids[student]!, termId)).map((p) => p.programId))

const billed = (r: { issued: { studentId: string; chargedPaise: number }[] }) => Object.fromEntries(r.issued.map((i) => [nameOf(i.studentId), i.chargedPaise]))

test('a term uses the promoted class and a detention retains the old class', async () => {
  const section = async (program: string, year: number) => (await academic.createSection(adm(), { programId: prog[program]!, label: 'A', admissionYear: year })).id
  const s6 = await section('C6', 2025)
  const next7 = await section('C7', 2026)
  const again6 = await section('C6', 2026)
  for (const who of ['up', 'down']) {
    await academic.declareProgram(adm(), { studentId: ids[who]!, programId: prog.C6!, declaredOn: '2025-06-01' })
    await academic.addSectionMember(adm(), { sectionId: s6, userId: ids[who]! })
  }

  // The old session is billed to Class 6, whatever happens afterwards.
  assert.deepEqual(billed(await issueInvoices(adm(), { termId: term.old })), { up: 1000000, down: 1000000 })

  // Without the promotion the incoming term would still bill Class 6: this is the assertion that fails without it.
  assert.deepEqual(await programsFor('up', term.next), [prog.C6])

  await academic.setNextSchoolProgram(adm(), { programId: prog.C6, nextProgramId: prog.C7 })
  const members = [ids.up!, ids.down!]
  await academic.promoteSection(adm(), {
    sourceSectionId: s6,
    sourceTermId: term.old,
    nextTermId: term.next,
    promotedSectionId: next7,
    detainedSectionId: again6,
    detainedStudentIds: [ids.down],
    rosterToken: createHash('sha256').update(JSON.stringify([[...members].sort(), [...members].sort()])).digest('hex'),
    reason: 'Year end 2025-26',
  })

  // Either side of the boundary, one class each.
  assert.deepEqual(await programsFor('up', term.old), [prog.C6])
  assert.deepEqual(await programsFor('up', term.next), [prog.C7])
  assert.deepEqual(await programsFor('down', term.old), [prog.C6])
  assert.deepEqual(await programsFor('down', term.next), [prog.C6])

  const count = async () => (await authDb.execute<{ n: number }>(sql`select count(*)::int as n from fee_invoices where institution_id = ${inst}`)).rows[0]!.n
  const invoices = await count()
  assert.deepEqual((await issueInvoices(adm(), { termId: term.old })).issued, [], 'the old term, run again, adds nothing')
  assert.equal(await count(), invoices)

  assert.deepEqual(billed(await issueInvoices(adm(), { termId: term.next })), { up: 2300000, down: 2100000 })
})
