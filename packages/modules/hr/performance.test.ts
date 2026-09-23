import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import {
  HrError,
  appraisalView,
  createCycle,
  createKra,
  createStaff,
  enrol,
  giveAppraisalFeedback,
  listCycles,
  listGoals,
  myAppraisals,
  setCycleStatus,
  setGoal,
  submitReview,
  submitSelfReview,
  updateGoal,
  weightedScore,
  type Actor,
} from './api'
import {
  appraisalCycles,
  appraisalFeedback,
  appraisalKras,
  appraisals,
  goals,
  kras,
  staff,
} from './schema'

/**
 * Performance: self review, then the reviewer, then a frozen score; goals;
 * and candid colleague feedback that never comes from the person appraised.
 */

const SLUG = 'hr-perf'
const OTHER = 'hr-perf-other'
let inst: string
let other: string
const ids = { adm: '', hod: '', fac: '', peer: '', otherAdm: '' }
let teaching = ''
let research = ''

const A = (over: Partial<Actor>): Actor => ({
  id: ids.adm,
  email: 'adm@hrperf.test',
  role: 'institution_admin',
  institutionId: inst,
  ...over,
})
const admin = () => A({})
const hod = () => A({ id: ids.hod, email: 'hod@hrperf.test', role: 'hod' })
const lecturer = () => A({ id: ids.fac, email: 'fac@hrperf.test', role: 'faculty' })
const peer = () => A({ id: ids.peer, email: 'peer@hrperf.test', role: 'faculty' })
const outsider = () => A({ id: ids.otherAdm, institutionId: other })
const code = (e: unknown) => (e as HrError).code

async function openCycleWithLecturer() {
  const cycle = await createCycle(admin(), { name: '2026-27', startsOn: '2026-07-01', endsOn: '2027-06-30' })
  await setCycleStatus(admin(), { cycleId: cycle.id, status: 'open' })
  const person = await createStaff(admin(), {
    employeeCode: 'F-1', name: 'Dr Lecturer', designation: 'Assistant Professor',
    joinedOn: '2024-01-01', userId: ids.fac,
  })
  await enrol(admin(), {
    cycleId: cycle.id, staffIds: [person.id], reviewerId: ids.hod,
    kras: [{ kraId: teaching, weight: 60 }, { kraId: research, weight: 40 }],
  })
  const [a] = await myAppraisals(lecturer())
  return { cycle, person, appraisalId: a!.id }
}

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Perf College', allowedEmailDomains: ['hrperf.test'] },
      { slug: OTHER, name: 'Other', allowedEmailDomains: ['hrperfother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@hrperf.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'hod@hrperf.test', institutionId: inst, role: 'hod', name: 'Prof HoD' },
      { email: 'fac@hrperf.test', institutionId: inst, role: 'faculty', name: 'Dr Lecturer' },
      { email: 'peer@hrperf.test', institutionId: inst, role: 'faculty', name: 'Dr Peer' },
      { email: 'adm@hrperfother.test', institutionId: other, role: 'institution_admin', name: 'O' },
    ])
    .returning({ id: users.id })
  ids.adm = people[0]!.id
  ids.hod = people[1]!.id
  ids.fac = people[2]!.id
  ids.peer = people[3]!.id
  ids.otherAdm = people[4]!.id
})

beforeEach(async () => {
  for (const t of [inst, other]) {
    await withTenant(t, async (tx) => {
      await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
      await tx.delete(goals)
      await tx.delete(appraisalFeedback)
      await tx.delete(appraisalKras)
      await tx.delete(appraisals)
      await tx.delete(appraisalCycles)
      await tx.delete(kras)
      await tx.delete(staff)
    })
  }
  teaching = (await createKra(admin(), { code: 'TEACH', name: 'Teaching' })).id
  research = (await createKra(admin(), { code: 'RES', name: 'Research' })).id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

test('the score is the weighted mean, in hundredths', () => {
  assert.equal(weightedScore([{ weight: 60, rating: 4 }, { weight: 40, rating: 3 }]), 360)
  assert.equal(weightedScore([{ weight: 100, rating: 5 }]), 500)
})

test('an appraisal runs self review, then the reviewer, and freezes its score', async () => {
  const { appraisalId } = await openCycleWithLecturer()

  // The reviewer does not go first.
  await assert.rejects(
    () => submitReview(hod(), {
      appraisalId, summary: 'Rated before reading.',
      ratings: [{ kraId: teaching, rating: 4 }, { kraId: research, rating: 3 }],
    }),
    (e: unknown) => code(e) === 'awaiting_self_review',
  )

  await submitSelfReview(lecturer(), {
    appraisalId, summary: 'Taught three courses; one paper under review.',
    ratings: [{ kraId: teaching, rating: 5 }, { kraId: research, rating: 3, comment: 'one submission' }],
  })
  const done = await submitReview(hod(), {
    appraisalId, summary: 'Excellent teaching feedback; research needs momentum.',
    ratings: [{ kraId: teaching, rating: 4 }, { kraId: research, rating: 3 }],
  })
  assert.equal(done.status, 'completed')
  assert.equal(done.scoreCenti, 360)

  const view = await appraisalView(lecturer(), appraisalId)
  assert.equal(view.score, 3.6)
  assert.equal(view.lines.find((l) => l.code === 'TEACH')!.selfRating, 5)
  assert.equal(view.lines.find((l) => l.code === 'TEACH')!.reviewerRating, 4)

  // A completed appraisal is a record.
  await assert.rejects(() =>
    withTenant(inst, (tx) => tx.update(appraisals).set({ scoreCenti: 500 }).where(eq(appraisals.id, appraisalId))),
  )
})

test('only the appraisee self-reviews, and only the reviewer reviews', async () => {
  const { appraisalId } = await openCycleWithLecturer()
  const ratings = [{ kraId: teaching, rating: 3 }, { kraId: research, rating: 3 }]
  await assert.rejects(
    () => submitSelfReview(peer(), { appraisalId, summary: 'Not mine to write.', ratings }),
    (e: unknown) => code(e) === 'forbidden',
  )
  await submitSelfReview(lecturer(), { appraisalId, summary: 'My own account.', ratings })
  await assert.rejects(
    () => submitReview(admin(), { appraisalId, summary: 'Not the assigned reviewer.', ratings }),
    (e: unknown) => code(e) === 'forbidden',
  )
})

test('every KRA is rated, once, and nothing else', async () => {
  const { appraisalId } = await openCycleWithLecturer()
  await assert.rejects(
    () => submitSelfReview(lecturer(), { appraisalId, summary: 'Half done.', ratings: [{ kraId: teaching, rating: 4 }] }),
    (e: unknown) => code(e) === 'incomplete',
  )
})

test('weights add to 100, and nobody reviews themselves', async () => {
  const cycle = await createCycle(admin(), { name: 'c', startsOn: '2026-07-01', endsOn: '2027-06-30' })
  const person = await createStaff(admin(), {
    employeeCode: 'F-2', name: 'HoD', designation: 'Professor', joinedOn: '2020-01-01', userId: ids.hod,
  })
  await assert.rejects(() =>
    enrol(admin(), {
      cycleId: cycle.id, staffIds: [person.id], reviewerId: ids.adm,
      kras: [{ kraId: teaching, weight: 50 }, { kraId: research, weight: 30 }],
    }),
  )
  await assert.rejects(
    () => enrol(admin(), {
      cycleId: cycle.id, staffIds: [person.id], reviewerId: ids.hod,
      kras: [{ kraId: teaching, weight: 100 }],
    }),
    (e: unknown) => code(e) === 'self_review',
  )
})

test('colleagues give candid feedback: named to HR, anonymous to the appraisee', async () => {
  const { appraisalId } = await openCycleWithLecturer()
  await giveAppraisalFeedback(peer(), {
    appraisalId, relation: 'peer', rating: 4,
    strengths: 'Generous with lab time for students.', improvements: 'Replies to email slowly.',
  })
  await assert.rejects(
    () => giveAppraisalFeedback(peer(), {
      appraisalId, relation: 'peer', rating: 5, strengths: 'Second thoughts here.', improvements: 'None at all.',
    }),
    (e: unknown) => code(e) === 'already_given',
  )
  await assert.rejects(
    () => giveAppraisalFeedback(lecturer(), {
      appraisalId, relation: 'other', rating: 5, strengths: 'I am great at this.', improvements: 'Nothing whatsoever.',
    }),
    (e: unknown) => code(e) === 'self_feedback',
  )

  assert.equal((await appraisalView(admin(), appraisalId)).feedback[0]!.from, 'Dr Peer')
  assert.equal((await appraisalView(lecturer(), appraisalId)).feedback[0]!.from, null)
  // Somebody neither appraised, reviewing nor HR reads nothing.
  await assert.rejects(() => appraisalView(peer(), appraisalId), (e: unknown) => code(e) === 'forbidden')
})

test('a closed cycle takes no more ratings, from the code or the table', async () => {
  const { cycle, appraisalId } = await openCycleWithLecturer()
  await setCycleStatus(admin(), { cycleId: cycle.id, status: 'closed' })
  await assert.rejects(
    () => submitSelfReview(lecturer(), {
      appraisalId, summary: 'Too late now.',
      ratings: [{ kraId: teaching, rating: 3 }, { kraId: research, rating: 3 }],
    }),
    (e: unknown) => code(e) === 'cycle_not_open',
  )
  await assert.rejects(() =>
    withTenant(inst, (tx) =>
      tx.update(appraisalKras).set({ selfRating: 5 }).where(eq(appraisalKras.appraisalId, appraisalId)),
    ),
  )
  await assert.rejects(
    () => setCycleStatus(admin(), { cycleId: cycle.id, status: 'open' }),
    (e: unknown) => code(e) === 'bad_move',
  )
  const [c] = await listCycles(admin())
  assert.equal(c!.selfReview, 1, 'the unfinished appraisal is visible as unfinished')
})

test('goals are set and tracked, and achieved means all the way', async () => {
  const { person, cycle } = await openCycleWithLecturer()
  const g = await setGoal(lecturer(), {
    staffId: person.id, title: 'Publish two papers', kraId: research, cycleId: cycle.id, targetOn: '2027-05-31',
  })
  await updateGoal(lecturer(), { goalId: g.id, progress: 50 })
  const achieved = await updateGoal(lecturer(), { goalId: g.id, status: 'achieved' })
  assert.equal(achieved.progress, 100)
  await assert.rejects(
    () => updateGoal(lecturer(), { goalId: g.id, progress: 20 }),
    (e: unknown) => code(e) === 'closed',
  )
  const mine = await listGoals(lecturer())
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.kra, 'RES')
  // A colleague does not set goals for somebody else.
  await assert.rejects(
    () => setGoal(peer(), { staffId: person.id, title: 'Do my marking' }),
    (e: unknown) => code(e) === 'forbidden',
  )
})

test('the reviewer’s list says what is waiting on them', async () => {
  const { appraisalId } = await openCycleWithLecturer()
  assert.equal((await myAppraisals(hod()))[0]!.waiting, false)
  assert.equal((await myAppraisals(lecturer()))[0]!.waiting, true)
  await submitSelfReview(lecturer(), {
    appraisalId, summary: 'Done my part.',
    ratings: [{ kraId: teaching, rating: 4 }, { kraId: research, rating: 4 }],
  })
  assert.equal((await myAppraisals(hod()))[0]!.waiting, true)
  assert.equal((await myAppraisals(lecturer()))[0]!.waiting, false)
})

test('one college’s appraisals are nobody else’s', async () => {
  await openCycleWithLecturer()
  assert.equal((await listCycles(outsider())).length, 0)
})
