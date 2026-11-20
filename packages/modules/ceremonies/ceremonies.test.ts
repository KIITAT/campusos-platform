import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like, sql } from 'drizzle-orm'
import { createRequire } from 'node:module'
import { drizzle } from 'drizzle-orm/node-postgres'
import { authDb, corePool, institutionModules, institutions, users, withTenant } from '@campusos/db'
import { printedText } from '@campusos/module-framework/pdf'
import {
  correctCompletion,
  createCourse,
  createCurriculum,
  createDepartment,
  createProgram,
  createRequirement,
  createTerm,
  declareProgram,
  listCompletions,
  recordCompletion,
  type Actor as AcademicActor,
} from '@campusos/module-academic/api'
import { studentPrograms } from '@campusos/module-academic/schema'
import {
  CeremonyError,
  certificateDocument,
  certificateView,
  checkIn,
  clearHold,
  createCeremony,
  issueCertificates,
  listCandidates,
  listCeremonies,
  myGraduation,
  placeHold,
  reissueCertificate,
  respond,
  revokeCertificate,
  runEligibility,
  setCeremonyStatus,
  verifyCertificate,
  type Actor,
} from './api'
import * as fees from '../fees/api'
import * as lib from '../library/api'
import { setSingleOfficer } from '../finance/api'
import { plugin } from './plugin'
import { candidates, certificates } from './schema'

/**
 * Phase H: who graduates is the degree audit's answer, and a certificate is
 * issued only to somebody it cleared -- by this module, and by the database
 * when this module is bypassed.
 */

const SLUG = 'cer-test-'
let n = 0

interface Campus {
  id: string
  admin: Actor
  faculty: Actor
  done: Actor
  short: Actor
  outsider: Actor
  programId: string
  courses: { a: string; b: string }
  termId: string
}

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Convocation College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Registrar' },
      { email: `fac@${tag}.test`, institutionId: id, role: 'faculty', name: 'Marshal' },
      { email: `done@${tag}.test`, institutionId: id, role: 'student', name: 'Asha Graduate' },
      { email: `short@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal Short' },
      { email: `out@${tag}.test`, institutionId: id, role: 'student', name: 'Chen Elsewhere' },
    ])
    .returning({ id: users.id })
  const [adm, fac, done, short, out] = people.map((p) => p.id) as [string, string, string, string, string]
  const admin: Actor = { id: adm, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const a = admin as AcademicActor

  const dept = await createDepartment(a, { code: 'CSE', name: 'Computing' })
  const prog = await createProgram(a, { departmentId: dept.id, code: 'BTCS', name: 'B.Tech Computing', level: 'undergraduate', durationTerms: 8 })
  const other = await createProgram(a, { departmentId: dept.id, code: 'MCA', name: 'Master of Computer Applications', level: 'postgraduate', durationTerms: 4 })
  const term = await createTerm(a, { code: `T${n}`, name: 'Spring', startsOn: '2026-01-05', endsOn: '2026-05-30' })
  const cur = await createCurriculum(a, { programId: prog.id, catalogYear: 2022, totalCredits: 8 })
  const cA = await createCourse(a, { departmentId: dept.id, code: `A${n}`, title: 'Algorithms', credits: 4 })
  const cB = await createCourse(a, { departmentId: dept.id, code: `B${n}`, title: 'Databases', credits: 4 })
  await createRequirement(a, { curriculumId: cur.id, code: 'CORE', title: 'Core', kind: 'core', minCredits: 8, courseIds: [cA.id, cB.id] })
  const otherCur = await createCurriculum(a, { programId: other.id, catalogYear: 2024, totalCredits: 4 })

  for (const s of [done, short]) {
    await declareProgram(a, { studentId: s, programId: prog.id, curriculumId: cur.id })
  }
  await declareProgram(a, { studentId: out, programId: other.id, curriculumId: otherCur.id })

  for (const c of [cA.id, cB.id]) {
    await recordCompletion(a, { studentId: done, courseId: c, termId: term.id, gradePoints: 8 })
  }
  await recordCompletion(a, { studentId: short, courseId: cA.id, termId: term.id, gradePoints: 7 })

  return {
    id,
    admin,
    faculty: { id: fac, role: 'faculty', institutionId: id },
    done: { id: done, role: 'student', institutionId: id },
    short: { id: short, role: 'student', institutionId: id },
    outsider: { id: out, role: 'student', institutionId: id },
    programId: prog.id,
    courses: { a: cA.id, b: cB.id },
    termId: term.id,
  }
}

const code = (e: unknown) => (e as CeremonyError).code
const refusedBy = (constraint: string) => (e: unknown) =>
  String((e as { cause?: { constraint?: string } }).cause?.constraint) === constraint

async function ceremonyFor(c: Campus, status: 'planning' | 'open' | 'held' = 'open') {
  const e = await createCeremony(c.admin, {
    name: 'Twelfth Convocation',
    heldOn: '2026-12-10',
    venue: 'Main Hall',
    programIds: [c.programId],
    guestLimit: 2,
  })
  if (status !== 'planning') await setCeremonyStatus(c.admin, { ceremonyId: e.id, status: 'open' })
  if (status === 'held') await setCeremonyStatus(c.admin, { ceremonyId: e.id, status: 'held' })
  return e
}

/** Queue the audit as the route does, then run the job as the worker would (REL-04). */
async function eligibility(c: Campus, e: { id: string }) {
  await runEligibility(c.admin, { ceremonyId: e.id })
  const job = plugin.jobs!.find((j) => j.kind === 'ceremonies.eligibility')!
  return withTenant(c.id, (tx) => job.run(c.admin as never, tx, { ceremonyId: e.id })) as Promise<{ audited: number; eligible: number }>
}

before(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})
after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('eligibility is queued, not worked out inside the request (REL-04)', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  const queued = await runEligibility(c.admin, { ceremonyId: e.id })
  assert.equal(queued.queued, true)
  assert.ok(queued.jobId)
  assert.match(queued.notice, /Refresh this page in a minute/)
  assert.equal((await listCandidates(c.admin, e.id)).length, 0, 'nothing is worked out in the request')
  const job = plugin.jobs!.find((j) => j.kind === 'ceremonies.eligibility')!
  await withTenant(c.id, (tx) => job.run(c.admin as never, tx, { ceremonyId: e.id }))
  assert.ok((await listCandidates(c.admin, e.id)).length > 0)
})

test('a ceremony past the 65,535-parameter limit of one insert is still worked out (REL-04, review HIGH)', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  const [declared] = await withTenant(c.id, (tx) => tx.select().from(studentPrograms).where(eq(studentPrograms.studentId, c.done.id)))
  const extra = 5_500 // 12 parameters a candidate row: one insert holds at most 5,461
  for (let from = 0; from < extra; from += 1_000) {
    const people = await authDb
      .insert(users)
      .values(Array.from({ length: Math.min(1_000, extra - from) }, (_, k) => ({ email: `bulk${from + k}@${SLUG}${n}.test`, institutionId: c.id, role: 'student' as const, name: `Bulk ${from + k}` })))
      .returning({ id: users.id })
    await withTenant(c.id, (tx) =>
      tx.insert(studentPrograms).values(people.map((p) => ({ institutionId: c.id, studentId: p.id, programId: declared!.programId, curriculumId: declared!.curriculumId }))),
    )
  }
  const run = await eligibility(c, e)
  assert.equal(run.audited, extra + 2)
  const [row] = await withTenant(c.id, (tx) => tx.select({ count: sql<number>`count(*)::int` }).from(candidates).where(eq(candidates.ceremonyId, e.id)))
  assert.equal(row!.count, extra + 2)
})

test('the list is whoever reads a graduating programme, and cleared means the degree audit says complete', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  const run = await eligibility(c, e)
  assert.equal(run.audited, 2, 'the MCA student is not graduating at a B.Tech ceremony')
  assert.equal(run.eligible, 1)

  const list = await listCandidates(c.admin, e.id)
  const asha = list.find((x) => x.studentId === c.done.id)!
  const bilal = list.find((x) => x.studentId === c.short.id)!
  assert.equal(asha.eligible, true)
  assert.equal(asha.stage, 'cleared')
  assert.equal(asha.creditsEarned, 8)
  assert.equal(Number(asha.cgpa), 8)
  assert.equal(bilal.eligible, false)
  assert.equal(bilal.stage, 'not_eligible')
  assert.match(bilal.shortOf!, /4 credits short|CORE/)

  // The list of ceremonies counts each one's own candidates.
  const row = (await listCeremonies(c.admin)).find((x) => x.id === e.id)!
  assert.equal(row.candidates, 2)
  assert.equal(row.eligible, 1)
})

test('certificates go to the cleared and are refused, by name, to the rest', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  const out = await issueCertificates(c.admin, { ceremonyId: e.id })
  assert.equal(out.issued, 1)
  assert.equal(out.skipped.length, 1)
  assert.match(out.skipped[0]!.reason, /not cleared by the degree audit/)

  const [cert] = await withTenant(c.id, (tx) => tx.select().from(certificates))
  assert.equal(cert!.studentId, c.done.id)
  assert.equal(cert!.docstatus, 'submitted')
  assert.match(cert!.serial, /^CERT-2026-0001$/)
  assert.equal((cert!.audit as { complete: boolean }).complete, true, 'the certificate keeps the audit it was issued on')
  assert.equal(cert!.conferredOn, '2026-12-10')

  const again = await issueCertificates(c.admin, { ceremonyId: e.id })
  assert.equal(again.issued, 0, 'one certificate standing per graduand')
})

test('the database refuses a certificate the audit did not clear, even with the module bypassed', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  const [bilal] = await withTenant(c.id, (tx) => tx.select().from(candidates).where(eq(candidates.studentId, c.short.id)))
  const forge = (audit: Record<string, unknown>) =>
    withTenant(c.id, (tx) =>
      tx.insert(certificates).values({
        institutionId: c.id,
        candidateId: bilal!.id,
        ceremonyId: e.id,
        studentId: c.short.id,
        serial: 'FORGED-1',
        verificationCode: 'forged-code-1',
        studentName: 'Bilal Short',
        programCode: 'BTCS',
        programName: 'B.Tech Computing',
        creditsEarned: 4,
        conferredOn: '2026-12-10',
        audit,
        docstatus: 'submitted',
      }),
    )
  // Even claiming the audit said complete: the candidate was not cleared.
  await assert.rejects(forge({ complete: true }), refusedBy('ceremony_certificate_audit'))

  // Nor can the list be edited to say cleared while the audit carried says otherwise.
  await withTenant(c.id, (tx) => tx.update(candidates).set({ eligible: true, shortOf: null }).where(eq(candidates.id, bilal!.id)))
  await assert.rejects(forge({ complete: false }), refusedBy('ceremony_certificate_audit'))
})

test('the audit is taken again at issue: a grade withdrawn since eligibility stops the certificate', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await eligibility(c, e)

  // A mark found to be wrong after the list was drawn up.
  const [row] = (await listCompletions(c.admin as AcademicActor, { studentId: c.done.id })).filter((x) => x.courseId === c.courses.b)
  await correctCompletion(c.admin as AcademicActor, { completionId: row!.id, passed: false, reason: 'marks entered against the wrong student' })

  const out = await issueCertificates(c.admin, { ceremonyId: e.id })
  assert.equal(out.issued, 0)
  const list = await listCandidates(c.admin, e.id)
  assert.equal(list.find((x) => x.studentId === c.done.id)!.eligible, false, 'the list follows the fresh audit')
})

test('a hold stops the certificate until it is cleared, and both are audited', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  const asha = (await listCandidates(c.admin, e.id)).find((x) => x.studentId === c.done.id)!
  const hold = await placeHold(c.admin, { candidateId: asha.id, reason: 'library books not returned' })

  assert.equal((await listCandidates(c.admin, e.id)).find((x) => x.id === asha.id)!.stage, 'held')
  const out = await issueCertificates(c.admin, { ceremonyId: e.id, candidateIds: [asha.id] })
  assert.equal(out.issued, 0)
  assert.match(out.skipped[0]!.reason, /on hold: library books/)

  await clearHold(c.admin, { holdId: hold.id, reason: 'books returned on 1 December' })
  assert.equal((await issueCertificates(c.admin, { ceremonyId: e.id, candidateIds: [asha.id] })).issued, 1)
  await assert.rejects(clearHold(c.admin, { holdId: hold.id, reason: 'again, by mistake' }), (x) => code(x) === 'already_cleared')
})

test('no certificates while planning; a ceremony only moves forward', async () => {
  const c = await campus()
  const e = await ceremonyFor(c, 'planning')
  await eligibility(c, e)
  await assert.rejects(issueCertificates(c.admin, { ceremonyId: e.id }), (x) => code(x) === 'ceremony_certificate_planning')
  await setCeremonyStatus(c.admin, { ceremonyId: e.id, status: 'open' })
  await assert.rejects(setCeremonyStatus(c.admin, { ceremonyId: e.id, status: 'open' }), (x) => code(x) === 'ceremony_status_forward')
  await setCeremonyStatus(c.admin, { ceremonyId: e.id, status: 'held' })
  await assert.rejects(
    withTenant(c.id, (tx) => tx.execute(sql`update ceremony_events set status = 'open' where id = ${e.id}`)),
    refusedBy('ceremony_status_forward'),
  )
})

test('revoke needs a reason; a revoked certificate is reissued under a new serial naming the old', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  await issueCertificates(c.admin, { ceremonyId: e.id })
  const [cert] = await withTenant(c.id, (tx) => tx.select().from(certificates))

  await assert.rejects(reissueCertificate(c.admin, { certificateId: cert!.id }), (x) => code(x) === 'not_revoked')
  await revokeCertificate(c.admin, { certificateId: cert!.id, reason: 'name misspelt on the certificate' })
  const v = await verifyCertificate(c.faculty, { code: cert!.verificationCode })
  assert.equal(v.valid, false)
  await assert.rejects(certificateDocument(c.admin, cert!.id), (x) => code(x) === 'not_standing')

  const re = await reissueCertificate(c.admin, { certificateId: cert!.id })
  assert.equal(re.docstatus, 'submitted')
  assert.equal(re.amended_from, cert!.id)
  assert.equal(re.serial, 'CERT-2026-0002')
  assert.notEqual(re.verification_code, cert!.verificationCode)

  const view = await certificateView(c.admin, cert!.id)
  assert.equal(view.replacedBy?.serial, 'CERT-2026-0002')
  assert.equal((await verifyCertificate(c.faculty, { code: String(re.verification_code) })).valid, true)
  await assert.rejects(reissueCertificate(c.admin, { certificateId: cert!.id }), (x) => (x as { code?: string }).code === 'already_amended')
})

test('a submitted certificate cannot be edited in place', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  await issueCertificates(c.admin, { ceremonyId: e.id })
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(certificates).set({ studentName: 'Somebody Else' })),
    refusedBy('docstatus_locked'),
  )
})

test('the graduand replies while replies are open, within the guest limit, and only once cleared', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await eligibility(c, e)

  await assert.rejects(respond(c.short, { ceremonyId: e.id, attendance: 'in_person', guests: 1 }), (x) => code(x) === 'not_eligible')
  await assert.rejects(respond(c.outsider, { ceremonyId: e.id, attendance: 'in_person' }), (x) => code(x) === 'not_a_candidate')
  await assert.rejects(respond(c.done, { ceremonyId: e.id, attendance: 'in_person', guests: 3 }), (x) => code(x) === 'too_many_guests')
  await assert.rejects(respond(c.admin, { ceremonyId: e.id, attendance: 'in_person' }), (x) => code(x) === 'forbidden')

  const r = await respond(c.done, { ceremonyId: e.id, attendance: 'in_person', guests: 2 })
  assert.equal(r.guests, 2)
  const absent = await respond(c.done, { ceremonyId: e.id, attendance: 'in_absentia', guests: 2 })
  assert.equal(absent.guests, 0, 'nobody brings guests to a ceremony they are not at')

  await setCeremonyStatus(c.admin, { ceremonyId: e.id, status: 'held' })
  await assert.rejects(respond(c.done, { ceremonyId: e.id, attendance: 'in_person' }), (x) => code(x) === 'replies_closed')
})

test('check-in by a marshal, once, and only for the cleared', async () => {
  const c = await campus()
  const e = await ceremonyFor(c, 'held')
  await eligibility(c, e)
  const list = await listCandidates(c.admin, e.id)
  const asha = list.find((x) => x.studentId === c.done.id)!
  const bilal = list.find((x) => x.studentId === c.short.id)!

  await assert.rejects(checkIn(c.done, { candidateId: asha.id }), (x) => code(x) === 'forbidden')
  await checkIn(c.faculty, { candidateId: asha.id })
  await assert.rejects(checkIn(c.faculty, { candidateId: asha.id }), (x) => code(x) === 'already_checked_in')
  await assert.rejects(checkIn(c.faculty, { candidateId: bilal.id }), (x) => code(x) === 'not_eligible')
})

test('a student sees their own standing and certificate, not anybody else\'s', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  await issueCertificates(c.admin, { ceremonyId: e.id })
  const [cert] = await withTenant(c.id, (tx) => tx.select().from(certificates))

  const mine = await myGraduation(c.done)
  assert.equal(mine.ceremonies[0]!.eligible, true)
  assert.equal(mine.certificates[0]!.serial, cert!.serial)
  const theirs = await myGraduation(c.short)
  assert.equal(theirs.certificates.length, 0)
  assert.match(theirs.ceremonies[0]!.shortOf!, /short|CORE/)

  // Another student, a lecturer, and a HoD who heads no department of hers (SEC-07).
  for (const who of [c.short, c.faculty, { ...c.faculty, role: 'hod' as const }]) {
    await assert.rejects(certificateView(who, cert!.id), (x) => code(x) === 'not_your_student', who.role)
  }
  await assert.rejects(listCandidates(c.done as never, e.id), (x) => code(x) === 'forbidden')
  await assert.rejects(runEligibility(c.faculty, { ceremonyId: e.id }), (x) => code(x) === 'forbidden')
})

test('the certificate prints, as a PDF', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  await issueCertificates(c.admin, { ceremonyId: e.id })
  const [cert] = await withTenant(c.id, (tx) => tx.select().from(certificates))
  const { bytes } = await certificateDocument(c.done, cert!.id)
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-')
  assert.ok(bytes.length > 1000)
})

test('another institution sees none of it', async () => {
  const c = await campus()
  const d = await campus()
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  await issueCertificates(c.admin, { ceremonyId: e.id })
  const seen = await withTenant(d.id, (tx) => tx.select().from(certificates))
  assert.equal(seen.length, 0)
  await assert.rejects(runEligibility(d.admin, { ceremonyId: e.id }), (x) => code(x) === 'no_such_ceremony')
})

test('a certificate prints an Odia name (UX-01)', async () => {
  const c = await campus()
  await authDb.update(users).set({ name: 'ଅଭିଷେକ / अभिषेक' }).where(eq(users.id, c.done.id))
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  assert.equal((await issueCertificates(c.admin, { ceremonyId: e.id })).issued, 1)
  const [cert] = await withTenant(c.id, (tx) => tx.select().from(certificates))
  const doc = await certificateDocument(c.admin, cert!.id)
  assert.ok((await printedText(doc.bytes)).includes('ଅଭିଷେକ / अभिषेक'))
})

test('a name that cannot be printed is not issued a certificate (UX-01)', async () => {
  const c = await campus()
  await authDb.update(users).set({ name: 'Asha 😀' }).where(eq(users.id, c.done.id))
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  const out = await issueCertificates(c.admin, { ceremonyId: e.id })
  assert.equal(out.issued, 0)
  const skipped = out.skipped.find((x) => x.name === 'Asha 😀')!
  assert.match(skipped.reason, /^cannot be printed/)
  assert.equal((await withTenant(c.id, (tx) => tx.select().from(certificates))).length, 0)
})

// --- certificate clearance (P1-07d, FUNC-05) -----------------------------------

const DUES = 'Outstanding dues must be cleared before issuing this certificate.'
const asFees = (a: unknown) => a as fees.Actor
const asLib = (a: unknown) => a as lib.Actor
const cashPay = (c: Money, amount: string, termId = c.termId, over: Record<string, unknown> = {}) =>
  fees.recordPayment(asFees(c.clerk), { studentId: c.done.id, termId, amount, method: 'cash', allowAdvance: true, ...over })

interface Money extends Campus {
  clerk: Actor
  clerk2: Actor
  desk: Actor
}

/** A campus with accounts staff and a library desk, for the cases that move money. */
async function moneyCampus(...modules: string[]): Promise<Money> {
  const c = await campus()
  const tag = `${SLUG}${n}`
  const people = await authDb
    .insert(users)
    .values([
      { email: `clerk@${tag}.test`, institutionId: c.id, role: 'accounts_staff', name: 'Clerk' },
      { email: `clerk2@${tag}.test`, institutionId: c.id, role: 'accounts_staff', name: 'Clerk Two' },
      { email: `desk@${tag}.test`, institutionId: c.id, role: 'library_staff', name: 'Desk' },
    ])
    .returning({ id: users.id })
  const as = (k: number, email: string, role: Actor['role']): Actor => ({ id: people[k]!.id, email, role, institutionId: c.id })
  for (const moduleId of modules) {
    await authDb
      .insert(institutionModules)
      .values({ institutionId: c.id, moduleId, enabled: true })
      .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled: true } })
  }
  // A term running today, in India: where a library fine moved to Fees lands.
  await withTenant(c.id, (tx) =>
    tx.execute(sql`insert into academic_terms (institution_id, code, name, starts_on, ends_on)
                   select ${c.id}, 'TODAY', 'Running', d - 30, d + 60 from (select (now() at time zone 'Asia/Kolkata')::date as d) x`),
  )
  await setSingleOfficer(c.admin as never, { enabled: true, reason: 'test fixture: one officer' })
  return {
    ...c,
    clerk: as(0, `clerk@${tag}.test`, 'accounts_staff'),
    clerk2: as(1, `clerk2@${tag}.test`, 'accounts_staff'),
    desk: as(2, `desk@${tag}.test`, 'library_staff'),
  }
}

/** A priced tuition item for Asha's programme, invoiced. */
async function bill(c: Money, amount: string, termId = c.termId) {
  await fees.createFeeItem(asFees(c.admin), { programId: c.programId, termId, label: 'Tuition', amount })
  await fees.issueInvoices(asFees(c.admin), { termId })
}

const raise = (c: Money, sourceModule: string, sourceId: string, amountPaise = 10_000) =>
  withTenant(c.id, (tx) =>
    fees.chargeStudentWithin(tx, c.id, c.admin.id, { studentId: c.done.id, termId: c.termId, label: `${sourceModule} dues`, amountPaise, sourceModule, sourceId: `${sourceId}:${c.id}` }),
  )

/** Open the ceremony, take the audit, and try to issue; the campus is cleared academically. */
async function tryIssue(c: Campus, e: { id: string }, candidateIds?: string[]) {
  return issueCertificates(c.admin, { ceremonyId: e.id, ...(candidateIds ? { candidateIds } : {}) })
}
const certCount = (c: Campus) => withTenant(c.id, async (tx) => (await tx.select().from(certificates)).length)
const issuedAudits = (c: Campus) =>
  withTenant(c.id, async (tx) =>
    Number(((await tx.execute(sql`select count(*)::int as n from audit_log where action = 'ceremonies.certificate_issued'`)).rows[0] as { n: number }).n),
  )
const refusal = (out: { issued: number; skipped: { name: string; reason: string }[] }, name = 'Asha Graduate') => {
  assert.equal(out.issued, 0)
  assert.equal(out.skipped.length, 1)
  assert.equal(out.skipped[0]!.name, name)
  assert.equal(out.skipped[0]!.reason, DUES)
}

test('a positive balance from another term blocks issuance even with credit elsewhere (FUNC-05)', async () => {
  const c = await moneyCampus('fees')
  const term2 = await createTerm(c.admin as AcademicActor, { code: 'T2', name: 'Autumn', startsOn: '2026-06-01', endsOn: '2026-10-30' })
  await bill(c, '0.01')
  await cashPay(c, '200', term2.id)
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  refusal(await tryIssue(c, e))
  assert.equal(await certCount(c), 0)
  assert.equal(await issuedAudits(c), 0)
  await cashPay(c, '0.01')
  const out = await tryIssue(c, e)
  assert.equal(out.issued, 1)
  const [cert] = await withTenant(c.id, (tx) => tx.select().from(certificates))
  assert.equal(cert!.serial, 'CERT-2026-0001')
})

test('a bounce after issue blocks reissue until paid again (FUNC-05)', async () => {
  const c = await moneyCampus('fees')
  await bill(c, '100')
  const p = await cashPay(c, '100', c.termId, { method: 'cheque', reference: '000123', drawerIfsc: 'SBIN0001234', drawerAccount: '12345678901' })
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  assert.equal((await tryIssue(c, e)).issued, 1)
  const [first] = await withTenant(c.id, (tx) => tx.select().from(certificates))
  await revokeCertificate(c.admin, { certificateId: first!.id, reason: 'name to be corrected' })
  const on = await withTenant(c.id, (tx) => fees.localToday(tx, c.id))
  await fees.bouncePayment(asFees(c.clerk2), { paymentId: p.id, bouncedOn: on, reason: 'funds insufficient' })
  await assert.rejects(reissueCertificate(c.admin, { certificateId: first!.id }), (x) => {
    const e = x as { status?: number; code?: string; message?: string }
    return e.status === 409 && e.code === 'certificate_dues_outstanding' && e.message === DUES
  })
  const rows = await withTenant(c.id, (tx) => tx.select().from(certificates))
  assert.deepEqual(rows.map((r) => r.docstatus), ['cancelled'])
  await cashPay(c, '100')
  await reissueCertificate(c.admin, { certificateId: first!.id })
  const after = await withTenant(c.id, (tx) => tx.select().from(certificates))
  assert.ok(after.some((r) => r.serial === 'CERT-2026-0002'))
})

test('a voided invoice with no dues left clears, and the unpriced price list does not count (FUNC-05)', async () => {
  const c = await moneyCampus('fees')
  await bill(c, '100')
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  refusal(await tryIssue(c, e))
  await fees.voidInvoice(asFees(c.admin), { studentId: c.done.id, termId: c.termId, reason: 'issued with the wrong charges' })
  const out = await tryIssue(c, e)
  assert.equal(out.issued, 1)
  const [cert] = await withTenant(c.id, (tx) => tx.select().from(certificates))
  assert.equal(cert!.serial, 'CERT-2026-0001')
})

test('a voided or bounced payment re-opens the dues and blocks the first issue again (FUNC-05)', async () => {
  const v = await moneyCampus('fees')
  await bill(v, '100')
  const pv = await cashPay(v, '100')
  await fees.voidPayment(asFees(v.admin), { paymentId: pv.id, reason: 'entered against the wrong student' })
  const ev = await ceremonyFor(v)
  await eligibility(v, ev)
  refusal(await tryIssue(v, ev))
  assert.equal(await certCount(v), 0)
  await cashPay(v, '100')
  assert.equal((await tryIssue(v, ev)).issued, 1)

  const b = await moneyCampus('fees')
  await bill(b, '100')
  const pb = await cashPay(b, '100', b.termId, { method: 'cheque', reference: '000456', drawerIfsc: 'SBIN0001234', drawerAccount: '12345678901' })
  const on = await withTenant(b.id, (tx) => fees.localToday(tx, b.id))
  await fees.bouncePayment(asFees(b.clerk2), { paymentId: pb.id, bouncedOn: on, reason: 'funds insufficient' })
  const eb = await ceremonyFor(b)
  await eligibility(b, eb)
  refusal(await tryIssue(b, eb))
  assert.equal(await certCount(b), 0)
  await cashPay(b, '100')
  assert.equal((await tryIssue(b, eb)).issued, 1)
})

for (const source of ['hostel', 'transport', 'library']) {
  test(`a ${source} charge blocks issuance before and after it is billed (FUNC-05)`, async () => {
    const c = await moneyCampus('fees')
    await raise(c, source, `${source}-1`)
    const e = await ceremonyFor(c)
    await eligibility(c, e)
    refusal(await tryIssue(c, e))
    await fees.issueInvoices(asFees(c.admin), { termId: c.termId })
    refusal(await tryIssue(c, e))
    await fees.voidInvoice(asFees(c.admin), { studentId: c.done.id, termId: c.termId, reason: 'issued with the wrong charges' })
    refusal(await tryIssue(c, e))
    await fees.issueInvoices(asFees(c.admin), { termId: c.termId })
    await cashPay(c, '100')
    assert.equal((await tryIssue(c, e)).issued, 1)
    assert.equal(await certCount(c), 1)
  })
}

test('a cancelled charge and a price list nobody was billed from do not block (FUNC-05)', async () => {
  const c = await moneyCampus('fees')
  await fees.createFeeItem(asFees(c.admin), { programId: c.programId, termId: c.termId, label: 'Tuition', amount: '100' })
  await raise(c, 'hostel', 'hostel-9')
  await withTenant(c.id, (tx) => fees.cancelChargeForSourceWithin(tx, 'hostel', `hostel-9:${c.id}`, 'raised by mistake'))
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  assert.equal((await tryIssue(c, e)).issued, 1)
})

/** A book lent to Asha and returned five days late: a fine of ten rupees. */
async function overdue(c: Money, returned: boolean) {
  await lib.setSettings(asLib(c.desk), { loanDays: 14, maxConcurrentLoans: 3, maxRenewals: 1, finePerDay: '2', graceDays: 0, blockAtOutstanding: '0', reason: 'the rules for this test' })
  const title = await lib.createTitle(asLib(c.desk), { title: 'Introduction to Algorithms', author: 'Cormen' })
  const [copy] = await lib.addCopies(asLib(c.desk), { titleId: title.id, accessionNos: ['A-1'] })
  const loan = await lib.issue(asLib(c.desk), { copyId: copy!.id, borrowerId: c.done.id })
  await withTenant(c.id, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test backdate', true)`)
    await tx.execute(sql`update library_loans
                            set issued_at = now() - interval '19 days',
                                due_on = date_trunc('day', now() - interval '5 days') + interval '23:59:59.999'
                          where id = ${loan.id}`)
  })
  if (returned) await lib.returnCopy(asLib(c.desk), { copyId: copy!.id })
  return loan.id
}

test('a desk fine, or a fine moved to Fees, stops issuance until settled or waived (FUNC-05)', async () => {
  const a = await moneyCampus('fees', 'finance', 'library')
  const loanA = await overdue(a, true)
  const ea = await ceremonyFor(a)
  await eligibility(a, ea)
  refusal(await tryIssue(a, ea))
  await lib.settleFine(asLib(a.desk), { loanId: loanA, method: 'fee_account' })
  refusal(await tryIssue(a, ea))

  const b = await moneyCampus('fees', 'finance', 'library')
  const loanB = await overdue(b, true)
  await lib.waiveFine(asLib(b.admin), { loanId: loanB, amount: '10', reason: 'waived by the librarian' })
  const eb = await ceremonyFor(b)
  await eligibility(b, eb)
  assert.equal((await tryIssue(b, eb)).issued, 1)

  const d = await moneyCampus('fees', 'finance', 'library')
  await overdue(d, false)
  const ed = await ceremonyFor(d)
  await eligibility(d, ed)
  assert.equal((await tryIssue(d, ed)).issued, 1, 'an estimate on an open loan is not a fine')
})

test('boundaries: disabled modules keep debt, tenants stay apart, and only the office issues (FUNC-05)', async () => {
  const a = await moneyCampus('fees')
  await raise(a, 'hostel', 'hostel-1')
  const ea = await ceremonyFor(a)
  await eligibility(a, ea)
  await authDb.update(institutionModules).set({ enabled: false }).where(eq(institutionModules.institutionId, a.id))
  refusal(await tryIssue(a, ea))

  const b = await moneyCampus()
  const eb = await ceremonyFor(b)
  await eligibility(b, eb)
  assert.equal((await tryIssue(b, eb)).issued, 1)
  await assert.rejects(tryIssue(b, ea), (x) => code(x) === 'no_such_ceremony')
  await assert.rejects(tryIssue({ ...a, admin: a.done } as Campus, ea), (x) => code(x) === 'forbidden')
  await assert.rejects(tryIssue({ ...a, admin: a.faculty } as Campus, ea), (x) => code(x) === 'forbidden')
  await assert.rejects(reissueCertificate(a.done, { certificateId: '00000000-0000-0000-0000-000000000000' }), (x) => code(x) === 'forbidden')
  await assert.rejects(reissueCertificate(a.faculty, { certificateId: '00000000-0000-0000-0000-000000000000' }), (x) => code(x) === 'forbidden')

  // A batch: the charge on Asha skips her; the other student's certificate stands.
  const m = await moneyCampus('fees')
  await withTenant(m.id, (tx) => fees.chargeStudentWithin(tx, m.id, m.admin.id, { studentId: m.done.id, termId: m.termId, label: 'dues', amountPaise: 100, sourceModule: 'hostel', sourceId: `h1:${m.id}` }))
  await recordCompletion(m.admin as AcademicActor, { studentId: m.short.id, courseId: m.courses.b, termId: m.termId, gradePoints: 7 })
  const em = await ceremonyFor(m)
  await eligibility(m, em)
  const out = await tryIssue(m, em)
  assert.equal(out.issued, 1)
  assert.deepEqual(out.skipped.map((s) => [s.name, s.reason]), [['Asha Graduate', DUES]])
  assert.equal(await certCount(m), 1)
})

test('a debit committed while waiting for the serial blocks the issue (FUNC-05)', async () => {
  const c = await moneyCampus('fees')
  const e = await ceremonyFor(c)
  await eligibility(c, e)
  const holder = await corePool.connect()
  let run: Promise<unknown> | undefined
  try {
    await holder.query('begin')
    await holder.query(`select pg_advisory_xact_lock(hashtext($1 || ':ceremony-serial'))`, [c.id])
    run = tryIssue(c, e)
    run.catch(() => undefined)
    const until = Date.now() + 10_000
    for (;;) {
      const r = await authDb.execute(
        sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%ceremony-serial%' and pid <> pg_backend_pid()`,
      )
      if ((r.rows[0] as { n: number }).n >= 1) break
      if (Date.now() > until) throw new Error('the issue never reached the serial lock')
      await new Promise((ok) => setTimeout(ok, 50))
    }
    await raise(c, 'hostel', 'late-1')
  } finally {
    await holder.query('commit')
    holder.release()
  }
  refusal((await run) as { issued: number; skipped: { name: string; reason: string }[] })
  assert.equal(await certCount(c), 0)
})

test('a configured provider with no tables stops issue; an unconfigured one counts as zero (FUNC-05)', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clearance = ((await import('./api')) as Record<string, any>).checkCertificateClearanceWithin
  const c = await campus()
  const { Client } = createRequire(new URL('../../db/package.json', import.meta.url))('pg') as { Client: new (o: { connectionString?: string }) => { connect(): Promise<void>; query(q: string, v?: unknown[]): Promise<unknown>; end(): Promise<void> } }
  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
  await client.connect()
  const stop = new Error('roll back')
  try {
    await client.query('begin')
    await client.query('alter table public.fee_invoices rename to fee_invoices_clearance_test')
    await client.query('alter table public.library_loans rename to library_loans_clearance_test')
    await client.query(`select set_config('app.institution_id', $1, true)`, [c.id])
    const run = async () => {
      await client.query('savepoint s')
      try {
        return await clearance(drizzle(client) as never, c.id, c.done.id)
      } finally {
        await client.query('rollback to savepoint s')
      }
    }
    assert.deepEqual(await run(), { clear: true })
    for (const moduleId of ['fees', 'library']) {
      await client.query(`insert into institution_modules (institution_id, module_id, enabled) values ($1, $2, true)
                          on conflict (institution_id, module_id) do update set enabled = true`, [c.id, moduleId])
      await assert.rejects(run(), (x) => (x as { status?: number }).status === 503 && (x as { code?: string }).code === 'certificate_clearance_unavailable')
      await client.query(`update institution_modules set enabled = false where institution_id = $1 and module_id = $2`, [c.id, moduleId])
    }
    throw stop
  } catch (x) {
    if (x !== stop) throw x
  } finally {
    await client.query('rollback')
    await client.end()
  }
  const [r] = (await authDb.execute(sql`select to_regclass('public.fee_invoices') as a, to_regclass('public.library_loans') as b`)).rows as { a: string; b: string }[]
  assert.ok(r!.a && r!.b)
})
