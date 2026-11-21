import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like, sql } from 'drizzle-orm'
import { authDb, corePool, institutionModules, institutions, users, withTenant } from '@campusos/db'
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

// --- storage and lifecycle (step 2) ------------------------------------------

const constraintOf = (e: unknown) => String((e as { cause?: { constraint?: string } }).cause?.constraint ?? (e as { constraint?: string }).constraint)

test('the header and payload are tenant-isolated, locked once issued, and the payload deletes only with an erased pupil (MG-05)', async () => {
  const a = await school()
  const b = await school()
  const year = Number(istToday().slice(0, 4))
  const hdr = await withTenant(a.id, async (tx) => {
    const r = await tx.execute(sql`insert into ceremony_transfer_certificates (institution_id, student_id, student_program_id, issue_year, serial_no, issued_on, docstatus, submitted_at, submitted_by)
      values (${a.id}, ${a.pupil.id}, ${a.declarationId}, ${year}, 1, ${istToday()}, 'submitted', now(), ${a.admin.id}) returning id`)
    const id = (r.rows[0] as { id: string }).id
    await tx.execute(sql`insert into ceremony_transfer_payloads (certificate_id, institution_id, snapshot) values (${id}, ${a.id}, ${JSON.stringify({ format: 'cbse_annexure_i_v1' })}::jsonb)`)
    return id
  })
  // Tenant B sees nothing, and cannot write a row stamped for A.
  assert.equal((await counts(b)).h, 0)
  assert.equal((await counts(b)).p, 0)
  await assert.rejects(
    withTenant(b.id, (tx) => tx.execute(sql`insert into ceremony_transfer_certificates (institution_id, student_id, student_program_id, issue_year, serial_no, issued_on) values (${a.id}, ${a.pupil.id}, ${a.declarationId}, ${year}, 2, ${istToday()})`)),
    (e) => /row-level security|does not match/.test(String((e as { cause?: Error }).cause?.message)), // the subject guard fires first and cannot see A's rows from B
  )
  // A school declaration for another pupil's id is refused by the subject guard.
  await assert.rejects(
    withTenant(a.id, (tx) => tx.execute(sql`insert into ceremony_transfer_certificates (institution_id, student_id, student_program_id, issue_year, serial_no, issued_on) values (${a.id}, ${a.pupil2.id}, ${a.declarationId}, ${year}, 3, ${istToday()})`)),
    (e) => constraintOf(e) === 'transfer_subject_mismatch',
  )
  // Locked.
  await assert.rejects(withTenant(a.id, (tx) => tx.execute(sql`update ceremony_transfer_certificates set serial_no = 9 where id = ${hdr}`)), (e) => constraintOf(e) === 'docstatus_locked')
  await assert.rejects(withTenant(a.id, (tx) => tx.execute(sql`update ceremony_transfer_payloads set snapshot = '{"format":"cbse_annexure_i_v1","x":1}'::jsonb where certificate_id = ${hdr}`)), (e) => constraintOf(e) === 'transfer_payload_locked')
  await assert.rejects(withTenant(a.id, (tx) => tx.execute(sql`delete from ceremony_transfer_payloads where certificate_id = ${hdr}`)), (e) => constraintOf(e) === 'transfer_payload_locked')
  assert.deepEqual(await counts(a), { h: 1, p: 1, a: 0 })
})

// --- issue, revoke, replace (step 3) -----------------------------------------

test('a debit committed while the issue waits for the series lock blocks it, and no number is taken (MG-05, FUNC-05)', async () => {
  const c = await school({ bill: true })
  await payUp(c)
  const holder = await corePool.connect()
  let run: Promise<unknown> | undefined
  try {
    await holder.query('begin')
    await holder.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`ceremonies.tc:${c.id}`])
    run = post(c.admin, '/transfer-certificates/issue', tcBody(c.declarationId))
    run.catch(() => undefined)
    const until = Date.now() + 5_000
    for (;;) {
      const r = await authDb.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory' and pid <> pg_backend_pid()`)
      if ((r.rows[0] as { n: number }).n >= 1) break
      if (Date.now() > until) throw new Error('the issue never reached the series lock')
      await new Promise((ok) => setTimeout(ok, 50))
    }
    await withTenant(c.id, (tx) =>
      fees.chargeStudentWithin(tx, c.id, c.admin.id, { studentId: c.pupil.id, termId: c.termId, label: 'hostel dues', amountPaise: 100, sourceModule: 'hostel', sourceId: `late:${c.id}` }),
    )
  } finally {
    await holder.query('commit')
    holder.release()
  }
  await assert.rejects(run!, failsWith(409, 'certificate_dues_outstanding', DUES))
  assert.deepEqual(await counts(c), { h: 0, p: 0, a: 0 })
})

test('the office checks what it types: dates, promotion, subjects, glyphs; a replacement needs a revocation (MG-05)', async () => {
  const c = await school()
  const issue = (over: Record<string, unknown>) => post(c.admin, '/transfer-certificates/issue', tcBody(c.declarationId, over))
  const zodRefused = (e: unknown) => (e as { name?: string }).name === 'ZodError'
  await assert.rejects(issue({ presentDays: 300 }), zodRefused)
  await assert.rejects(issue({ promotionEligible: 'no' }), zodRefused)
  await assert.rejects(issue({ subjects: 'English,,Maths' }), zodRefused)
  await assert.rejects(issue({ repeatCount: 3 }), zodRefused)
  await assert.rejects(issue({ conduct: 'Good\nVery' }), zodRefused)
  await assert.rejects(issue({ firstAdmittedOn: '2009-01-01' }), failsWith(400, 'invalid_transfer_fields'))
  await assert.rejects(issue({ appliedOn: '2027-01-01' }), failsWith(400, 'invalid_transfer_fields'))
  await assert.rejects(issue({ paidThroughMonth: '2099-01' }), failsWith(400, 'invalid_transfer_fields'))
  await assert.rejects(issue({ conduct: 'Good \u{1F600}' }), failsWith(409, 'missing_glyph'))
  assert.deepEqual(await counts(c), { h: 0, p: 0, a: 0 })
  const ok = (await issue({ schoolAddress: '12 Station Road\nPune 411001' })) as { id: string; serial: string }
  await assert.rejects(issue({}), failsWith(409, 'transfer_certificate_exists'))
  await assert.rejects(post(c.admin, '/transfer-certificates/reissue', tcBody(c.declarationId, { certificateId: ok.id, studentProgramId: undefined })), failsWith(409, 'transfer_not_revoked', 'Revoke the certificate before replacing it.'))
  await assert.rejects(post(c.admin, '/transfer-certificates/revoke', { certificateId: ok.id, reason: 'no' }), zodRefused)
  await post(c.admin, '/transfer-certificates/revoke', { certificateId: ok.id, reason: 'printed on the wrong stock' })
  await assert.rejects(post(c.admin, '/transfer-certificates/revoke', { certificateId: ok.id, reason: 'printed on the wrong stock' }), failsWith(409, 'not_submitted'))
  const one = (await post(c.admin, '/transfer-certificates/reissue', tcBody(c.declarationId, { certificateId: ok.id, studentProgramId: undefined }))) as { id: string }
  await assert.rejects(post(c.admin, '/transfer-certificates/reissue', tcBody(c.declarationId, { certificateId: ok.id, studentProgramId: undefined })), failsWith(409, 'already_amended'))
  const list = (await get(c.admin, '/transfer-certificates', { studentId: c.pupil.id })) as { id: string; serial: string; docstatus: string; printable: boolean; amendedFrom: string | null }[]
  assert.deepEqual(list.map((r) => [r.serial.slice(-6), r.docstatus, r.printable, r.amendedFrom === null]), [['000002', 'submitted', true, false], ['000001', 'cancelled', false, true]])
  assert.equal(list[0]!.id, one.id)
  const bySerial = (await get(c.admin, '/transfer-certificates', { serial: list[1]!.serial })) as unknown[]
  assert.equal(bySerial.length, 1)
  // The address was typed over two lines and is stored as one.
  const [p] = await withTenant(c.id, async (tx) => (await tx.execute(sql`select snapshot->>'schoolAddress' as a from ceremony_transfer_payloads p join ceremony_transfer_certificates h on h.id = p.certificate_id where h.serial_no = 1`)).rows as { a: string }[])
  assert.equal(p!.a, '12 Station Road Pune 411001')
})
