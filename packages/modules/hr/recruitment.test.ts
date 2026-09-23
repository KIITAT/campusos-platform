import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import {
  HrError,
  addApplicant,
  applicantFile,
  closeOpening,
  createOnboardingTemplate,
  decideRequisition,
  giveFeedback,
  hire,
  listOpenings,
  listRequisitions,
  makeOffer,
  moveApplicant,
  myInterviews,
  onboardingFor,
  openPosition,
  raiseRequisition,
  respondToOffer,
  scheduleInterview,
  withdrawOffer,
  type Actor,
} from './api'
import {
  interviewFeedback,
  interviews,
  jobApplicants,
  jobOffers,
  jobOpenings,
  jobRequisitions,
  onboardingTemplates,
  onboardings,
  staff,
} from './schema'

/**
 * Recruitment end to end: a post agreed, advertised, interviewed for by a
 * panel, offered, accepted, and turned into a staff record in one act.
 */

const SLUG = 'hr-recruit'
const OTHER = 'hr-recruit-other'
let inst: string
let other: string
const ids = { adm: '', adm2: '', hod: '', fac: '', fac2: '', otherAdm: '' }

const A = (over: Partial<Actor>): Actor => ({
  id: ids.adm,
  email: 'adm@hrrec.test',
  role: 'institution_admin',
  institutionId: inst,
  ...over,
})
const admin = () => A({})
const principal = () => A({ id: ids.adm2, email: 'principal@hrrec.test' })
const hod = () => A({ id: ids.hod, email: 'hod@hrrec.test', role: 'hod' })
const panelist = () => A({ id: ids.fac, email: 'fac@hrrec.test', role: 'faculty' })
const bystander = () => A({ id: ids.fac2, email: 'fac2@hrrec.test', role: 'faculty' })
const outsider = () => A({ id: ids.otherAdm, institutionId: other })
const code = (e: unknown) => (e as HrError).code

const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)

/** A post agreed and advertised, ready for applicants. */
async function advertised(positions = 1) {
  const req = await raiseRequisition(hod(), {
    designation: 'Assistant Professor', department: 'Computing', positions,
    reason: 'two retirements in the department this year',
  })
  await decideRequisition(admin(), { requisitionId: req.id, approve: true })
  const opening = await openPosition(admin(), {
    requisitionId: req.id, title: 'Assistant Professor, Computing',
  })
  return { req, opening }
}

/** An applicant taken through one panel round, with feedback. */
async function interviewed(openingId: string, email = 'cand@example.com') {
  const a = await addApplicant(admin(), { openingId, name: 'A Candidate', email, source: 'website' })
  await moveApplicant(admin(), { applicantId: a.id, to: 'shortlisted' })
  const round = await scheduleInterview(admin(), {
    applicantId: a.id, scheduledAt: '2026-10-05T10:00:00+05:30', panel: [ids.fac],
  })
  await giveFeedback(panelist(), {
    interviewId: round.id, rating: 4, recommendation: 'hire', notes: 'Strong on systems; teaches clearly.',
  })
  return { applicant: a, round }
}

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Recruiting College', allowedEmailDomains: ['hrrec.test'] },
      { slug: OTHER, name: 'Other', allowedEmailDomains: ['hrrecother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@hrrec.test', institutionId: inst, role: 'institution_admin', name: 'Registrar' },
      { email: 'principal@hrrec.test', institutionId: inst, role: 'institution_admin', name: 'Principal' },
      { email: 'hod@hrrec.test', institutionId: inst, role: 'hod', name: 'HoD' },
      { email: 'fac@hrrec.test', institutionId: inst, role: 'faculty', name: 'Dr Panel' },
      { email: 'fac2@hrrec.test', institutionId: inst, role: 'faculty', name: 'Dr Elsewhere' },
      { email: 'adm@hrrecother.test', institutionId: other, role: 'institution_admin', name: 'O' },
    ])
    .returning({ id: users.id })
  ;[ids.adm, ids.adm2, ids.hod, ids.fac, ids.fac2, ids.otherAdm] = people.map((p) => p.id) as [
    string, string, string, string, string, string,
  ]
})

beforeEach(async () => {
  for (const t of [inst, other]) {
    await withTenant(t, async (tx) => {
      await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
      await tx.delete(onboardings)
      await tx.delete(onboardingTemplates)
      await tx.delete(interviewFeedback)
      await tx.delete(interviews)
      await tx.delete(jobOffers)
      await tx.delete(jobApplicants)
      await tx.delete(jobOpenings)
      await tx.delete(jobRequisitions)
      await tx.delete(staff)
    })
  }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

// --- the whole road --------------------------------------------------------

test('a post goes from a request to a person on the payroll list', async () => {
  const template = await createOnboardingTemplate(admin(), {
    code: 'faculty', name: 'New faculty',
    activities: [{ title: 'Issue ID card', owner: 'Admin office', dueDayOffset: 0 }],
  })
  const { req, opening } = await advertised()
  const { applicant } = await interviewed(opening.id)

  const offer = await makeOffer(admin(), {
    applicantId: applicant.id, monthly: '75000', joiningOn: '2026-12-01', expiresOn: inAWeek(),
  })
  assert.equal(offer.designation, 'Assistant Professor', 'terms default from the requisition')
  assert.equal(offer.monthlyPaise, 7_500_000)

  await respondToOffer(admin(), { offerId: offer.id, accept: true })
  const { staff: person, onboarding } = await hire(admin(), {
    offerId: offer.id, employeeCode: 'F-101', onboardingTemplateId: template.id,
  })

  assert.equal(person.name, 'A Candidate')
  assert.equal(person.email, 'cand@example.com')
  assert.equal(person.department, 'Computing')
  assert.equal(person.joinedOn, '2026-12-01')
  assert.ok(onboarding)
  assert.equal((await onboardingFor(admin(), person.id))!.activities.length, 1)

  const file = await applicantFile(admin(), applicant.id)
  assert.equal(file.applicant.status, 'hired')
  assert.equal(file.offers[0]!.staffId, person.id, 'the hire points back at its terms')
  assert.equal(file.rounds[0]!.feedback[0]!.interviewer, 'Dr Panel')

  const [r] = (await listRequisitions(admin())).filter((x) => x.id === req.id)
  assert.equal(r!.status, 'filled')
  assert.equal(r!.hired, 1)
  const [o] = await listOpenings(admin())
  assert.equal(o!.live, false, 'a filled post stops being advertised')
  assert.equal(o!.hired, 1)
})

// --- the requisition gate --------------------------------------------------

test('nothing is advertised before the post is agreed', async () => {
  const req = await raiseRequisition(hod(), {
    designation: 'Lab assistant', reason: 'new electronics lab opening in January',
  })
  await assert.rejects(
    () => openPosition(admin(), { requisitionId: req.id, title: 'Lab assistant' }),
    (e: unknown) => code(e) === 'not_approved',
  )
})

test('whoever raised a requisition does not approve it', async () => {
  const req = await raiseRequisition(admin(), {
    designation: 'Accountant', reason: 'the bursar needs a second pair of hands',
  })
  await assert.rejects(
    () => decideRequisition(admin(), { requisitionId: req.id, approve: true }),
    (e: unknown) => code(e) === 'self_approval',
  )
  const ok = await decideRequisition(principal(), { requisitionId: req.id, approve: true })
  assert.equal(ok.status, 'approved')
})

test('a lecturer does not raise requisitions; a head of department does', async () => {
  await assert.rejects(
    () => raiseRequisition(panelist(), { designation: 'X', reason: 'my own assistant please' }),
    (e: unknown) => code(e) === 'forbidden',
  )
  await assert.rejects(
    () => decideRequisition(hod(), { requisitionId: '00000000-0000-0000-0000-000000000000', approve: true }),
    (e: unknown) => code(e) === 'forbidden',
  )
})

test('one live advert per requisition, and a closed one takes no applicants', async () => {
  const { req, opening } = await advertised()
  await assert.rejects(
    () => openPosition(admin(), { requisitionId: req.id, title: 'Again' }),
    (e: unknown) => code(e) === 'already_open',
  )
  await closeOpening(admin(), { openingId: opening.id })
  await assert.rejects(
    () => addApplicant(admin(), { openingId: opening.id, name: 'Late', email: 'late@example.com' }),
    (e: unknown) => code(e) === 'closed',
  )
})

// --- applicants and the panel ---------------------------------------------

test('the same address applies once per opening, whatever its case', async () => {
  const { opening } = await advertised()
  await addApplicant(admin(), { openingId: opening.id, name: 'A', email: 'Same@Example.com' })
  await assert.rejects(
    () => addApplicant(admin(), { openingId: opening.id, name: 'A again', email: 'same@example.com' }),
    (e: unknown) => code(e) === 'already_applied',
  )
})

test('an applicant moves forward only by the steps that exist', async () => {
  const { opening } = await advertised()
  const a = await addApplicant(admin(), { openingId: opening.id, name: 'A', email: 'a@example.com' })
  await assert.rejects(
    () => scheduleInterview(admin(), { applicantId: a.id, scheduledAt: '2026-10-05T10:00:00Z', panel: [ids.fac] }),
    (e: unknown) => code(e) === 'not_shortlisted',
  )
  await moveApplicant(admin(), { applicantId: a.id, to: 'rejected', note: 'no doctorate' })
  await assert.rejects(
    () => moveApplicant(admin(), { applicantId: a.id, to: 'shortlisted' }),
    (e: unknown) => code(e) === 'bad_move',
  )
})

test('only the panel gives feedback, once each, and the round completes when all have', async () => {
  const { opening } = await advertised()
  const a = await addApplicant(admin(), { openingId: opening.id, name: 'A', email: 'a@example.com' })
  await moveApplicant(admin(), { applicantId: a.id, to: 'shortlisted' })
  const round = await scheduleInterview(admin(), {
    applicantId: a.id, scheduledAt: '2026-10-05T10:00:00Z', panel: [ids.fac, ids.hod],
  })
  assert.equal(round.round, 1)

  await assert.rejects(
    () => giveFeedback(bystander(), { interviewId: round.id, rating: 5, recommendation: 'strong_hire', notes: 'heard good things' }),
    (e: unknown) => code(e) === 'not_on_panel',
  )
  await giveFeedback(panelist(), { interviewId: round.id, rating: 3, recommendation: 'hire', notes: 'Adequate on theory.' })
  await assert.rejects(
    () => giveFeedback(panelist(), { interviewId: round.id, rating: 5, recommendation: 'strong_hire', notes: 'changed my mind' }),
    (e: unknown) => code(e) === 'already_given',
  )

  let file = await applicantFile(admin(), a.id)
  assert.equal(file.rounds[0]!.status, 'scheduled')
  assert.equal((await myInterviews(hod()))[0]!.owed, true)

  await giveFeedback(hod(), { interviewId: round.id, rating: 4, recommendation: 'hire', notes: 'Good fit for the systems group.' })
  file = await applicantFile(admin(), a.id)
  assert.equal(file.rounds[0]!.status, 'completed')
  assert.equal((await myInterviews(hod()))[0]!.owed, false)
})

test('the database also refuses feedback from off the panel, and edits to it', async () => {
  const { opening } = await advertised()
  const { round } = await interviewed(opening.id)
  await assert.rejects(() =>
    withTenant(inst, (tx) =>
      tx.insert(interviewFeedback).values({
        institutionId: inst, interviewId: round.id, interviewerId: ids.fac2,
        rating: 5, recommendation: 'strong_hire', notes: 'written straight in',
      }),
    ),
  )
  await assert.rejects(() =>
    withTenant(inst, (tx) =>
      tx.update(interviewFeedback).set({ rating: 1 }).where(eq(interviewFeedback.interviewId, round.id)),
    ),
  )
})

test('a panel is people from this college', async () => {
  const { opening } = await advertised()
  const a = await addApplicant(admin(), { openingId: opening.id, name: 'A', email: 'a@example.com' })
  await moveApplicant(admin(), { applicantId: a.id, to: 'shortlisted' })
  await assert.rejects(
    () => scheduleInterview(admin(), { applicantId: a.id, scheduledAt: '2026-10-05T10:00:00Z', panel: [ids.otherAdm] }),
    (e: unknown) => code(e) === 'bad_panel',
  )
})

// --- offers ----------------------------------------------------------------

test('no offer to somebody nobody has interviewed', async () => {
  const { opening } = await advertised()
  const a = await addApplicant(admin(), { openingId: opening.id, name: 'A', email: 'a@example.com' })
  await moveApplicant(admin(), { applicantId: a.id, to: 'shortlisted' })
  await scheduleInterview(admin(), { applicantId: a.id, scheduledAt: '2026-10-05T10:00:00Z', panel: [ids.fac] })
  await assert.rejects(
    () => makeOffer(admin(), { applicantId: a.id, monthly: '70000', joiningOn: '2026-12-01', expiresOn: inAWeek() }),
    (e: unknown) => code(e) === 'no_feedback',
  )
})

test('an expired offer cannot be accepted, and a declined one hires nobody', async () => {
  const { opening } = await advertised()
  const { applicant } = await interviewed(opening.id)
  const offer = await makeOffer(admin(), {
    applicantId: applicant.id, monthly: '70000', joiningOn: '2026-12-01', expiresOn: inAWeek(),
  })
  await withTenant(inst, (tx) =>
    tx.update(jobOffers).set({ expiresOn: '2026-01-01' }).where(eq(jobOffers.id, offer.id)),
  )
  await assert.rejects(
    () => respondToOffer(admin(), { offerId: offer.id, accept: true }),
    (e: unknown) => code(e) === 'offer_expired',
  )
  await respondToOffer(admin(), { offerId: offer.id, accept: false })
  await assert.rejects(
    () => hire(admin(), { offerId: offer.id, employeeCode: 'F-1' }),
    (e: unknown) => code(e) === 'not_accepted',
  )
  assert.equal((await applicantFile(admin(), applicant.id)).applicant.status, 'withdrawn')
})

test('withdrawing an offer is audited, and impossible once it is a hire', async () => {
  const { opening } = await advertised(2)
  const first = await interviewed(opening.id, 'one@example.com')
  const o1 = await makeOffer(admin(), {
    applicantId: first.applicant.id, monthly: '70000', joiningOn: '2026-12-01', expiresOn: inAWeek(),
  })
  const w = await withdrawOffer(admin(), { offerId: o1.id, reason: 'the budget line was frozen' })
  assert.equal(w.status, 'withdrawn')

  const second = await interviewed(opening.id, 'two@example.com')
  const o2 = await makeOffer(admin(), {
    applicantId: second.applicant.id, monthly: '70000', joiningOn: '2026-12-01', expiresOn: inAWeek(),
  })
  await respondToOffer(admin(), { offerId: o2.id, accept: true })
  await hire(admin(), { offerId: o2.id, employeeCode: 'F-2' })
  await assert.rejects(
    () => withdrawOffer(admin(), { offerId: o2.id, reason: 'too late for that now' }),
    (e: unknown) => code(e) === 'already_hired',
  )
})

test('a requisition for one is not filled twice', async () => {
  const { opening } = await advertised(1)
  const a = await interviewed(opening.id, 'a@example.com')
  const b = await interviewed(opening.id, 'b@example.com')
  const oa = await makeOffer(admin(), { applicantId: a.applicant.id, monthly: '70000', joiningOn: '2026-12-01', expiresOn: inAWeek() })
  const ob = await makeOffer(admin(), { applicantId: b.applicant.id, monthly: '70000', joiningOn: '2026-12-01', expiresOn: inAWeek() })
  await respondToOffer(admin(), { offerId: oa.id, accept: true })
  await respondToOffer(admin(), { offerId: ob.id, accept: true })
  await hire(admin(), { offerId: oa.id, employeeCode: 'F-A' })
  await assert.rejects(
    () => hire(admin(), { offerId: ob.id, employeeCode: 'F-B' }),
    (e: unknown) => code(e) === 'filled',
  )
})

test('one college’s hiring is invisible at another', async () => {
  await advertised()
  assert.equal((await listOpenings(outsider())).length, 0)
  assert.equal((await listRequisitions(outsider())).length, 0)
})
