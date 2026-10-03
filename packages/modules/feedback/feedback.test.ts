import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import {
  addSectionMember,
  createCourse,
  createDepartment,
  createOffering,
  createProgram,
  createSection,
  createTerm,
  type Actor as AcademicActor,
} from '@campusos/module-academic/api'
import {
  addQuestion,
  addScaleQuestions,
  classResults,
  completion,
  createForm,
  createWindow,
  FeedbackError,
  formView,
  give,
  giveView,
  myClassResults,
  myFeedback,
  publishForm,
  publishWindow,
  windowView,
  withdrawWindow,
  type Actor,
} from './api'
import { answers, responses, submissions, windows } from './schema'

/**
 * Feedback as KIIT's portal takes it -- per class and teacher, and once for
 * facilities -- with who answered and what they said kept apart, and the
 * database deciding who may answer and when.
 */

const SLUG = 'fb-test-'
let n = 0

interface Campus {
  id: string
  admin: Actor
  teacher: Actor
  otherTeacher: Actor
  asha: Actor
  bilal: Actor
  outsider: Actor
  termId: string
  offeringId: string
  otherOfferingId: string
}

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Feedback College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Office' },
      { email: `t@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Rao' },
      { email: `t2@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Sen' },
      { email: `asha@${tag}.test`, institutionId: id, role: 'student', name: 'Asha' },
      { email: `bilal@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal' },
      { email: `out@${tag}.test`, institutionId: id, role: 'student', name: 'Chen' },
    ])
    .returning({ id: users.id })
  const [adm, t, t2, asha, bilal, out] = people.map((p) => p.id) as [string, string, string, string, string, string]
  const admin: Actor = { id: adm, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const a = admin as AcademicActor
  const dept = await createDepartment(a, { code: 'CSE', name: 'Computing' })
  const prog = await createProgram(a, { departmentId: dept.id, code: 'BTCS', name: 'B.Tech', level: 'undergraduate', durationTerms: 8 })
  const term = await createTerm(a, { code: `F${n}`, name: 'Autumn', startsOn: '2026-07-01', endsOn: '2026-11-30' })
  const ds = await createCourse(a, { departmentId: dept.id, code: `DS${n}`, title: 'Data Structures', credits: 4 })
  const ps = await createCourse(a, { departmentId: dept.id, code: `PS${n}`, title: 'Probability', credits: 3 })
  const secA = await createSection(a, { programId: prog.id, label: 'A', admissionYear: 2025 })
  const secB = await createSection(a, { programId: prog.id, label: 'B', admissionYear: 2025 })
  for (const s of [asha, bilal]) await addSectionMember(a, { sectionId: secA.id, userId: s })
  await addSectionMember(a, { sectionId: secB.id, userId: out })
  const off = await createOffering(a, { termId: term.id, courseId: ds.id, sectionId: secA.id, facultyUserId: t })
  const off2 = await createOffering(a, { termId: term.id, courseId: ps.id, sectionId: secA.id, facultyUserId: t2 })
  await createOffering(a, { termId: term.id, courseId: ds.id, sectionId: secB.id, facultyUserId: t2 })
  return {
    id,
    admin,
    teacher: { id: t, role: 'faculty', institutionId: id },
    otherTeacher: { id: t2, role: 'faculty', institutionId: id },
    asha: { id: asha, role: 'student', institutionId: id },
    bilal: { id: bilal, role: 'student', institutionId: id },
    outsider: { id: out, role: 'student', institutionId: id },
    termId: term.id,
    offeringId: off.id,
    otherOfferingId: off2.id,
  }
}

const code = (e: unknown) => (e as FeedbackError).code
const refusedBy = (constraint: string) => (e: unknown) =>
  String((e as { cause?: { constraint?: string } }).cause?.constraint) === constraint || code(e) === constraint
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()
const H = 3600_000

/** A published teaching questionnaire: three statements, a choice, a comment. */
async function teachingForm(c: Campus) {
  const f = await createForm(c.admin, { name: 'Teaching-learning', audience: 'teaching' })
  await addScaleQuestions(c.admin, {
    formId: f.id,
    section: 'The teacher',
    prompts: 'Explains clearly\nIs prepared for class\nIs available outside class',
  })
  await addQuestion(c.admin, { formId: f.id, kind: 'choice', prompt: 'The pace was', options: 'Too slow\nAbout right\nToo fast' })
  await addQuestion(c.admin, { formId: f.id, kind: 'text', prompt: 'Anything else?' })
  await publishForm(c.admin, { formId: f.id })
  const v = await formView(c.admin, f.id)
  return { formId: f.id, q: v.questions.map((q) => q.id) as [string, string, string, string, string] }
}

async function openWindow(c: Campus, formId: string, over: Record<string, unknown> = {}) {
  const w = await createWindow(c.admin, {
    formId,
    termId: c.termId,
    title: 'End-semester feedback',
    opensAt: iso(-H),
    closesAt: iso(48 * H),
    minResponses: 2,
    ...over,
  })
  await publishWindow(c.admin, { windowId: w.id })
  return w.id
}

const answersFor = (q: string[], scores: [number, number, number], pace = 'About right', comment?: string) => ({
  [`q_${q[0]}`]: String(scores[0]),
  [`q_${q[1]}`]: String(scores[1]),
  [`q_${q[2]}`]: String(scores[2]),
  [`q_${q[3]}`]: pace,
  [`q_${q[4]}`]: comment ?? '',
})

/** Time passes: the window closes, as only the clock can make it. */
async function close(windowId: string) {
  await authDb.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`)
    await tx.execute(sql`update feedback_windows set opens_at = now() - interval '3 days', closes_at = now() - interval '1 minute' where id = ${windowId}`)
  })
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('the institution writes the questionnaire; nobody else does, and it is fixed once published', async () => {
  const c = await campus()
  await assert.rejects(createForm(c.teacher, { name: 'Mine', audience: 'teaching' }), (e) => code(e) === 'forbidden')
  const f = await createForm(c.admin, { name: 'Facilities', audience: 'general' })
  await assert.rejects(publishForm(c.admin, { formId: f.id }), refusedBy('feedback_form_empty'))
  await assert.rejects(
    addQuestion(c.admin, { formId: f.id, kind: 'choice', prompt: 'Pick one', options: 'Only' }),
    refusedBy('feedback_questions_options'),
  )
  await addScaleQuestions(c.admin, { formId: f.id, prompts: 'The library is quiet enough to study\nThe labs have working machines' })
  await publishForm(c.admin, { formId: f.id })
  await assert.rejects(
    addQuestion(c.admin, { formId: f.id, kind: 'scale', prompt: 'A late addition' }),
    refusedBy('feedback_question_frozen'),
  )
  // A window opens only a published questionnaire.
  const draft = await createForm(c.admin, { name: 'Unfinished', audience: 'general' })
  await assert.rejects(
    createWindow(c.admin, { formId: draft.id, termId: c.termId, title: 'Too soon', opensAt: iso(-H), closesAt: iso(H) }),
    refusedBy('feedback_window_form'),
  )
})

test('a student owes one for each of their classes, gives it once, and only while it is open', async () => {
  const c = await campus()
  const { formId, q } = await teachingForm(c)
  const windowId = await openWindow(c, formId)

  const mine = await myFeedback(c.asha)
  assert.equal(mine.due, 2, 'Asha sits two classes in section A')
  assert.deepEqual(mine.items.map((i) => i.state), ['due', 'due'])

  const sheet = await giveView(c.asha, windowId, c.offeringId)
  assert.equal(sheet.questions.length, 5)
  const r = await give(c.asha, { windowId, offeringId: c.offeringId, ...answersFor(q, [4, 5, 3], 'About right', 'Good examples') })
  assert.match(r.notice, /without your name/)
  assert.equal((await myFeedback(c.asha)).due, 1)

  await assert.rejects(
    give(c.asha, { windowId, offeringId: c.offeringId, ...answersFor(q, [1, 1, 1]) }),
    refusedBy('feedback_submissions_once'),
  )
  // Chen is in section B: section A's Data Structures is not his class.
  await assert.rejects(
    give(c.outsider, { windowId, offeringId: c.offeringId, ...answersFor(q, [1, 1, 1]) }),
    refusedBy('feedback_submission_class'),
  )
  await assert.rejects(give(c.teacher, { windowId, offeringId: c.offeringId }), (e) => code(e) === 'forbidden')
  // A required statement left out.
  await assert.rejects(
    give(c.bilal, { windowId, offeringId: c.offeringId, [`q_${q[0]}`]: '4' }),
    refusedBy('feedback_response_incomplete'),
  )
  // Off the scale.
  await assert.rejects(
    give(c.bilal, { windowId, offeringId: c.offeringId, ...answersFor(q, [6, 5, 5]) }),
    refusedBy('feedback_answer_value'),
  )

  // Not yet open, and closed.
  const later = await openWindow(c, formId, { title: 'Next one', opensAt: iso(24 * H), closesAt: iso(48 * H) })
  await assert.rejects(
    give(c.bilal, { windowId: later, offeringId: c.offeringId, ...answersFor(q, [3, 3, 3]) }),
    refusedBy('feedback_submission_not_open'),
  )
  await close(windowId)
  await assert.rejects(
    give(c.bilal, { windowId, offeringId: c.offeringId, ...answersFor(q, [3, 3, 3]) }),
    refusedBy('feedback_submission_closed'),
  )
})

test('who answered and what they said cannot be joined, and neither is changed', async () => {
  const c = await campus()
  const { formId, q } = await teachingForm(c)
  const windowId = await openWindow(c, formId)
  await give(c.asha, { windowId, offeringId: c.offeringId, ...answersFor(q, [4, 4, 4]) })

  // Structurally: no student, no time on what was said.
  const cols = async (table: string) =>
    (
      await authDb.execute(sql`select column_name from information_schema.columns where table_name = ${table}`)
    ).rows.map((r) => String((r as { column_name: string }).column_name))
  for (const t of ['feedback_responses', 'feedback_answers']) {
    const names = await cols(t)
    assert.ok(!names.some((n) => /student|user|created|submitted|_at$/.test(n)), `${t} carries ${names.join(', ')}`)
  }

  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(answers).set({ score: 1 }).where(eq(answers.institutionId, c.id))),
    refusedBy('feedback_answer_kept'),
  )
  await assert.rejects(
    withTenant(c.id, (tx) => tx.delete(responses).where(eq(responses.windowId, windowId))),
    refusedBy('feedback_response_kept'),
  )
  await assert.rejects(
    withTenant(c.id, (tx) => tx.delete(submissions).where(eq(submissions.windowId, windowId))),
    refusedBy('feedback_submission_kept'),
  )
  // Past the module: a response with nobody behind it is refused.
  await assert.rejects(
    withTenant(c.id, (tx) => tx.insert(responses).values({ institutionId: c.id, windowId, offeringId: c.offeringId })),
    refusedBy('feedback_response_unmatched'),
  )
})

test('results: nothing while open, nothing below the threshold, and a teacher sees only their own classes', async () => {
  const c = await campus()
  const { formId, q } = await teachingForm(c)
  const windowId = await openWindow(c, formId, { minResponses: 2 })
  await give(c.asha, { windowId, offeringId: c.offeringId, ...answersFor(q, [4, 5, 3], 'Too fast', 'More worked examples') })

  assert.equal((await classResults(c.teacher, windowId, c.offeringId)).open, true, 'nothing while it is open')
  await assert.rejects(classResults(c.teacher, windowId, c.otherOfferingId), (e) => code(e) === 'forbidden')

  await give(c.asha, { windowId, offeringId: c.otherOfferingId, ...answersFor(q, [2, 2, 2]) })
  await give(c.bilal, { windowId, offeringId: c.offeringId, ...answersFor(q, [2, 3, 3], 'About right', 'Clear notes') })
  await close(windowId)

  const mine = await classResults(c.teacher, windowId, c.offeringId)
  assert.equal(mine.open, false)
  const r = mine.result!
  assert.equal(r.shown, true)
  assert.equal(r.responses, 2)
  assert.equal(r.questions[0]!.mean, 3) // (4 + 2) / 2
  assert.equal(r.questions[1]!.mean, 4)
  assert.deepEqual(r.questions[3]!.spread.map((s) => s.count), [0, 1, 1])
  assert.deepEqual(r.questions[4]!.comments, ['Clear notes', 'More worked examples'], 'alphabetical, not in the order given')

  // One answer for Probability: below the threshold of two, so nothing shows.
  const thin = await classResults(c.otherTeacher, windowId, c.otherOfferingId)
  assert.equal(thin.result!.shown, false)
  assert.equal(thin.result!.questions.length, 0)

  const list = await myClassResults(c.teacher)
  assert.equal(list.find((x) => x.offeringId === c.offeringId)!.responses, 2)

  const w = await windowView(c.admin, windowId)
  assert.equal(w.summary.owed, 5, 'Asha and Bilal for two classes, Chen for one')
  assert.equal(w.summary.given, 3)
  assert.deepEqual(w.pending.map((p) => p.name).sort(), ['Bilal', 'Chen'])
})

test('a general window is answered once per student, and finishing the term is a question others can ask', async () => {
  const c = await campus()
  const t = await teachingForm(c)
  const teachingWindow = await openWindow(c, t.formId)
  const f = await createForm(c.admin, { name: 'Facilities', audience: 'general' })
  await addScaleQuestions(c.admin, { formId: f.id, prompts: 'The classrooms are clean' })
  await publishForm(c.admin, { formId: f.id })
  const facilities = await openWindow(c, f.id, { title: 'Facilities' })

  const before = await completion(c.asha, c.asha.id, c.termId)
  assert.equal(before.complete, false)
  assert.equal(before.owed.length, 3, 'two classes and the facilities form')

  await give(c.asha, { windowId: facilities, [`q_${(await formView(c.admin, f.id)).questions[0]!.id}`]: '4' })
  await assert.rejects(
    give(c.asha, { windowId: facilities, offeringId: c.offeringId, [`q_${(await formView(c.admin, f.id)).questions[0]!.id}`]: '4' }),
    refusedBy('feedback_submission_class'),
  )
  await give(c.asha, { windowId: teachingWindow, offeringId: c.offeringId, ...answersFor(t.q, [3, 3, 3]) })
  await give(c.asha, { windowId: teachingWindow, offeringId: c.otherOfferingId, ...answersFor(t.q, [3, 3, 3]) })
  assert.equal((await completion(c.asha, c.asha.id, c.termId)).complete, true)

  // Bilal let it close: missed, not owed.
  await close(teachingWindow)
  const bilal = await completion(c.admin, c.bilal.id, c.termId)
  assert.equal(bilal.complete, false)
  assert.equal(bilal.missed.length, 2)
  assert.equal(bilal.owed.length, 1, 'facilities is still open')
  await assert.rejects(completion(c.asha, c.bilal.id, c.termId), (e) => code(e) === 'forbidden')

  // A withdrawn window is owed by nobody.
  await withdrawWindow(c.admin, { windowId: facilities, reason: 'the wrong questionnaire was opened' })
  assert.equal((await completion(c.admin, c.bilal.id, c.termId)).owed.length, 0)
})

test('another institution sees none of it', async () => {
  const c = await campus()
  const d = await campus()
  const { formId } = await teachingForm(c)
  const windowId = await openWindow(c, formId)
  await assert.rejects(windowView(d.admin, windowId), (e) => code(e) === 'no_such_window')
  const seen = await withTenant(d.id, (tx) => tx.select().from(windows))
  assert.equal(seen.length, 0)
})
