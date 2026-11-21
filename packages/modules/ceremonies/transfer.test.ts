import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like, sql } from 'drizzle-orm'
import { authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import {
  createDepartment,
  createProgram,
  createTerm,
  declareProgram,
  endStudentProgram,
  type Actor as AcademicActor,
} from '@campusos/module-academic/api'
import { studentPrograms } from '@campusos/module-academic/schema'
import type { Actor } from './api'
import * as fees from '../fees/api'
import { setSingleOfficer } from '../finance/api'
import { plugin } from './plugin'

/**
 * P1-13d: a numbered school transfer certificate, issued only after the pupil's
 * school declaration is ended as transferred out and the dues are clear
 * (MG-05, FUNC-05).
 */

const SLUG = 'tc-test-'
let n = 0
const DUES = 'Outstanding dues must be cleared before issuing this certificate.'
const asFees = (a: unknown) => a as fees.Actor

interface School {
  id: string
  admin: Actor
  clerk: Actor
  faculty: Actor
  hod: Actor
  pupil: Actor
  pupil2: Actor
  programId: string
  collegeProgramId: string
  declarationId: string
  declarationId2: string
  termId: string
}

/** An IST calendar date, as the institution counts its days. */
export const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())

const route = (method: 'GET' | 'POST', path: string) => {
  const r = plugin.routes.find((x) => x.method === method && x.path === path)
  assert.ok(r, `${method} ${path} is a route of the ceremonies module`)
  return r
}
const post = (a: Actor, path: string, body: unknown) =>
  route('POST', path).handler(a as never, new Request(`http://localhost/api${path}`, { method: 'POST', body: JSON.stringify(body) }))
const get = (a: Actor, path: string, q: Record<string, string> = {}) =>
  route('GET', path).handler(a as never, new Request(`http://localhost/api${path}?${new URLSearchParams(q)}`))
const failsWith = (status: number, code: string, message?: string) => (e: unknown) => {
  const x = e as { status?: number; code?: string; message?: string }
  return x.status === status && x.code === code && (message === undefined || x.message === message)
}

/** A school with two pupils reading Class 10, both transferred out, one charged a paisa of tuition. */
async function school(opts: { bill?: boolean; end?: boolean } = {}): Promise<School> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Greenfield Public School', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  for (const moduleId of ['fees']) {
    await authDb.insert(institutionModules).values({ institutionId: id, moduleId, enabled: true })
  }
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Registrar' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `fac@${tag}.test`, institutionId: id, role: 'faculty', name: 'Teacher' },
      { email: `hod@${tag}.test`, institutionId: id, role: 'hod', name: 'Head' },
      { email: `p1@${tag}.test`, institutionId: id, role: 'student', name: 'Asha Verma', dateOfBirth: '2010-03-14' },
      { email: `p2@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal Khan', dateOfBirth: '2010-08-02' },
    ])
    .returning({ id: users.id })
  const [adm, clerk, fac, hod, p1, p2] = people.map((p) => p.id) as [string, string, string, string, string, string]
  const admin: Actor = { id: adm, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const a = admin as AcademicActor
  const dept = await createDepartment(a, { code: 'SCH', name: 'School' })
  const prog = await createProgram(a, { departmentId: dept.id, code: 'X', name: 'Class 10', level: 'school', durationTerms: 2 })
  const college = await createProgram(a, { departmentId: dept.id, code: 'BTCS', name: 'B.Tech', level: 'undergraduate', durationTerms: 8 })
  const term = await createTerm(a, { code: `T${n}`, name: 'Session', startsOn: '2026-01-05', endsOn: '2026-05-30' })
  const d1 = await declareProgram(a, { studentId: p1, programId: prog.id, declaredOn: '2025-07-01' })
  const d2 = await declareProgram(a, { studentId: p2, programId: prog.id, declaredOn: '2025-07-01' })
  await setSingleOfficer(admin as never, { enabled: true, reason: 'test fixture: one officer' })
  if (opts.bill) {
    await fees.createFeeItem(asFees(admin), { programId: prog.id, termId: term.id, label: 'Tuition', amount: '0.01' })
    await fees.issueInvoices(asFees(admin), { termId: term.id })
  }
  if (opts.end !== false) {
    for (const d of [d1, d2]) await endStudentProgram(a, { studentProgramId: d.id, status: 'transferred_out', endedOn: '2026-06-30' })
  }
  return {
    id,
    admin,
    clerk: { id: clerk, email: `clerk@${tag}.test`, role: 'accounts_staff', institutionId: id },
    faculty: { id: fac, role: 'faculty', institutionId: id },
    hod: { id: hod, role: 'hod', institutionId: id },
    pupil: { id: p1, role: 'student', institutionId: id },
    pupil2: { id: p2, role: 'student', institutionId: id },
    programId: prog.id,
    collegeProgramId: college.id,
    declarationId: d1.id,
    declarationId2: d2.id,
    termId: term.id,
  }
}

/** Everything the office types; the platform supplies the rest. */
export const tcBody = (declarationId: string, over: Record<string, unknown> = {}) => ({
  studentProgramId: declarationId,
  schoolAddress: '12 Station Road, Pune 411001',
  affiliationNo: '1130123',
  schoolCode: '40123',
  bookNo: '7',
  admissionNo: 'A-1042',
  motherName: 'Sunita Verma',
  fatherOrGuardianName: 'Rakesh Verma',
  birthInWords: 'Fourteenth March Two Thousand Ten',
  nationality: 'Indian',
  reservationCategory: 'Neither',
  firstAdmittedOn: '2015-06-01',
  firstClass: 'Class 1',
  lastClassFigures: '10',
  lastClassWords: 'Tenth',
  lastExamResult: 'Passed, annual examination',
  repeatCount: 0,
  subjects: 'English, Hindi, Mathematics, Science, Social Science',
  promotionEligible: 'yes',
  promotionClassFigures: '11',
  promotionClassWords: 'Eleventh',
  paidThroughMonth: '2026-03',
  feeConcession: '',
  workingDays: 220,
  presentDays: 205,
  activitiesUniformed: 'NCC',
  activitiesOther: 'Football',
  conduct: 'Good',
  appliedOn: '2026-06-20',
  leavingReason: 'Family has moved to another city',
  remarks: '',
  checkedBy: 'R. Iyer, Clerk',
  ...over,
})

const headers = (c: School) => withTenant(c.id, async (tx) => (await tx.execute(sql`select * from ceremony_transfer_certificates order by serial_no`)).rows as Record<string, unknown>[])
const counts = (c: School) =>
  withTenant(c.id, async (tx) => {
    const r = await tx.execute(sql`select (select count(*)::int from ceremony_transfer_certificates) as h,
                                          (select count(*)::int from ceremony_transfer_payloads) as p,
                                          (select count(*)::int from audit_log where action like 'ceremonies.transfer%') as a`)
    return r.rows[0] as { h: number; p: number; a: number }
  })
const payUp = (c: School, amount = '0.01') =>
  fees.recordPayment(asFees(c.clerk), { studentId: c.pupil.id, termId: c.termId, amount, method: 'cash', allowAdvance: true })

before(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})
after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('posted dues block the original without taking a serial (MG-05, FUNC-05)', async () => {
  const c = await school({ bill: true })
  await assert.rejects(post(c.admin, '/transfer-certificates/issue', tcBody(c.declarationId)), failsWith(409, 'certificate_dues_outstanding', DUES))
  assert.deepEqual(await counts(c), { h: 0, p: 0, a: 0 })
  await payUp(c)
  const out = (await post(c.admin, '/transfer-certificates/issue', tcBody(c.declarationId))) as { serial: string }
  assert.equal(out.serial, `TC-${istToday().slice(0, 4)}-000001`)
  assert.deepEqual(await counts(c), { h: 1, p: 1, a: 1 })
})

test('a newly posted debit blocks a replacement (MG-05, FUNC-05)', async () => {
  const c = await school({ bill: true })
  await payUp(c)
  const first = (await post(c.admin, '/transfer-certificates/issue', tcBody(c.declarationId))) as { id: string; serial: string }
  await post(c.admin, '/transfer-certificates/revoke', { certificateId: first.id, reason: 'name spelling to be corrected' })
  await withTenant(c.id, (tx) =>
    fees.chargeStudentWithin(tx, c.id, c.admin.id, { studentId: c.pupil.id, termId: c.termId, label: 'hostel dues', amountPaise: 10_000, sourceModule: 'hostel', sourceId: `h1:${c.id}` }),
  )
  await assert.rejects(post(c.admin, '/transfer-certificates/reissue', tcBody(c.declarationId, { certificateId: first.id, studentProgramId: undefined })), failsWith(409, 'certificate_dues_outstanding', DUES))
  assert.deepEqual((await headers(c)).map((h) => h.docstatus), ['cancelled'])
  await withTenant(c.id, (tx) => fees.cancelChargeForSourceWithin(tx, 'hostel', `h1:${c.id}`, 'raised by mistake'))
  const second = (await post(c.admin, '/transfer-certificates/reissue', tcBody(c.declarationId, { certificateId: first.id, studentProgramId: undefined }))) as { serial: string }
  assert.equal(second.serial, `TC-${istToday().slice(0, 4)}-000002`)
  const rows = await headers(c)
  assert.deepEqual(rows.map((h) => h.docstatus), ['cancelled', 'submitted'])
  assert.equal(rows[1]!.amended_from, first.id)
})

test('school and tenant boundaries (MG-05)', async () => {
  const c = await school()
  const other = await school()
  for (const who of [c.faculty, c.hod, c.pupil]) {
    await assert.rejects(post(who, '/transfer-certificates/issue', tcBody(c.declarationId)), failsWith(403, 'forbidden'))
    await assert.rejects(get(who, '/transfer-certificates'), failsWith(403, 'forbidden'))
  }
  await assert.rejects(post(other.admin, '/transfer-certificates/issue', tcBody(c.declarationId)), failsWith(404, 'no_such_transfer_declaration', 'No such school declaration.'))
  // A live school declaration and a college one are both refused.
  const live = await school({ end: false })
  await assert.rejects(post(live.admin, '/transfer-certificates/issue', tcBody(live.declarationId)), failsWith(409, 'transfer_required', 'End the school declaration as transferred out before issuing.'))
  const a = c.admin as AcademicActor
  const clg = await declareProgram(a, { studentId: c.pupil.id, programId: c.collegeProgramId, declaredOn: '2026-07-01', isPrimary: false })
  await assert.rejects(post(c.admin, '/transfer-certificates/issue', tcBody(clg.id)), failsWith(404, 'no_such_transfer_declaration'))
  await withTenant(c.id, (tx) => tx.update(studentPrograms).set({ status: 'withdrawn', endedOn: '2026-08-01', isPrimary: false }).where(eq(studentPrograms.id, clg.id)))
  await assert.rejects(post(c.admin, '/transfer-certificates/issue', tcBody(clg.id)), failsWith(404, 'no_such_transfer_declaration'))
  assert.deepEqual(await counts(c), { h: 0, p: 0, a: 0 })
})

test('same declaration, different clerks: one original; different pupils get distinct serials (MG-05)', async () => {
  const c = await school()
  const results = await Promise.allSettled([
    post(c.admin, '/transfer-certificates/issue', tcBody(c.declarationId)),
    post(c.admin, '/transfer-certificates/issue', tcBody(c.declarationId)),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
  assert.ok(failsWith(409, 'transfer_certificate_exists', 'A transfer certificate is already recorded for this declaration.')(lost.reason))
  const second = (await post(c.admin, '/transfer-certificates/issue', tcBody(c.declarationId2))) as { serial: string }
  assert.equal(second.serial, `TC-${istToday().slice(0, 4)}-000002`)
  assert.deepEqual(await counts(c), { h: 2, p: 2, a: 2 })
})
