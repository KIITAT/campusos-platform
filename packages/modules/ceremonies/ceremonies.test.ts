import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
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
import {
  CeremonyError,
  certificateDocument,
  certificateView,
  checkIn,
  clearHold,
  createCeremony,
  issueCertificates,
  listCandidates,
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

before(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})
after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('the list is whoever reads a graduating programme, and cleared means the degree audit says complete', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  const run = await runEligibility(c.admin, { ceremonyId: e.id })
  assert.equal(run.audited, 2, 'the MCA student is not graduating at a B.Tech ceremony')
  assert.equal(run.eligible, 1)
  assert.match(run.notice, /1 cleared/)

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
})

test('certificates go to the cleared and are refused, by name, to the rest', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await runEligibility(c.admin, { ceremonyId: e.id })
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
  await runEligibility(c.admin, { ceremonyId: e.id })
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
  await runEligibility(c.admin, { ceremonyId: e.id })

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
  await runEligibility(c.admin, { ceremonyId: e.id })
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
  await runEligibility(c.admin, { ceremonyId: e.id })
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
  await runEligibility(c.admin, { ceremonyId: e.id })
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
  await runEligibility(c.admin, { ceremonyId: e.id })
  await issueCertificates(c.admin, { ceremonyId: e.id })
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(certificates).set({ studentName: 'Somebody Else' })),
    refusedBy('docstatus_locked'),
  )
})

test('the graduand replies while replies are open, within the guest limit, and only once cleared', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await runEligibility(c.admin, { ceremonyId: e.id })

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
  await runEligibility(c.admin, { ceremonyId: e.id })
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
  await runEligibility(c.admin, { ceremonyId: e.id })
  await issueCertificates(c.admin, { ceremonyId: e.id })
  const [cert] = await withTenant(c.id, (tx) => tx.select().from(certificates))

  const mine = await myGraduation(c.done)
  assert.equal(mine.ceremonies[0]!.eligible, true)
  assert.equal(mine.certificates[0]!.serial, cert!.serial)
  const theirs = await myGraduation(c.short)
  assert.equal(theirs.certificates.length, 0)
  assert.match(theirs.ceremonies[0]!.shortOf!, /short|CORE/)

  await assert.rejects(certificateView(c.short, cert!.id), (x) => code(x) === 'forbidden')
  await assert.rejects(listCandidates(c.done as never, e.id), (x) => code(x) === 'forbidden')
  await assert.rejects(runEligibility(c.faculty, { ceremonyId: e.id }), (x) => code(x) === 'forbidden')
})

test('the certificate prints, as a PDF', async () => {
  const c = await campus()
  const e = await ceremonyFor(c)
  await runEligibility(c.admin, { ceremonyId: e.id })
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
  await runEligibility(c.admin, { ceremonyId: e.id })
  await issueCertificates(c.admin, { ceremonyId: e.id })
  const seen = await withTenant(d.id, (tx) => tx.select().from(certificates))
  assert.equal(seen.length, 0)
  await assert.rejects(runEligibility(d.admin, { ceremonyId: e.id }), (x) => code(x) === 'no_such_ceremony')
})
