import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
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
import { courseCompletions } from '@campusos/module-academic/schema'
import {
  addItems,
  attemptView,
  createQuestion,
  createQuiz,
  grantExtension,
  listQuestions,
  myQuizzes,
  overrideResponse,
  publishQuiz,
  QuizError,
  quizView,
  retireQuestion,
  reviseQuestion,
  reviseQuiz,
  saveAnswers,
  startAttempt,
  withdrawQuiz,
  type Actor,
} from './api'
import { attempts, questions, quizzes, responses } from './schema'

/**
 * Phase I: a quiz is authored from a bank, taken, and scored by the machine --
 * with the database, not the client, holding the clock, the key and the total.
 */

const SLUG = 'quiz-test-'
let n = 0

interface Campus {
  id: string
  admin: Actor
  teacher: Actor
  otherTeacher: Actor
  asha: Actor
  bilal: Actor
  outsider: Actor
  courseId: string
  otherCourseId: string
  offeringId: string
}

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Quiz College', allowedEmailDomains: [`${tag}.test`] })
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
  const term = await createTerm(a, { code: `Q${n}`, name: 'Monsoon', startsOn: '2026-07-01', endsOn: '2026-11-30' })
  const course = await createCourse(a, { departmentId: dept.id, code: `DB${n}`, title: 'Databases', credits: 4 })
  const other = await createCourse(a, { departmentId: dept.id, code: `OS${n}`, title: 'Operating Systems', credits: 4 })
  const secA = await createSection(a, { programId: prog.id, label: 'A', admissionYear: 2025 })
  const secB = await createSection(a, { programId: prog.id, label: 'B', admissionYear: 2025 })
  for (const s of [asha, bilal]) await addSectionMember(a, { sectionId: secA.id, userId: s })
  await addSectionMember(a, { sectionId: secB.id, userId: out })
  const off = await createOffering(a, { termId: term.id, courseId: course.id, sectionId: secA.id, facultyUserId: t })
  await createOffering(a, { termId: term.id, courseId: other.id, sectionId: secB.id, facultyUserId: t2 })

  return {
    id,
    admin,
    teacher: { id: t, role: 'faculty', institutionId: id },
    otherTeacher: { id: t2, role: 'faculty', institutionId: id },
    asha: { id: asha, role: 'student', institutionId: id },
    bilal: { id: bilal, role: 'student', institutionId: id },
    outsider: { id: out, role: 'student', institutionId: id },
    courseId: course.id,
    otherCourseId: other.id,
    offeringId: off.id,
  }
}

const code = (e: unknown) => (e as QuizError).code
const refusedBy = (constraint: string) => (e: unknown) =>
  String((e as { cause?: { constraint?: string } }).cause?.constraint) === constraint ||
  (e as QuizError).code === constraint
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()
const H = 3600_000

/** Four questions worth 1, 2, 1 and 2: one of each kind a machine can score. */
async function bank(c: Campus) {
  const capital = await createQuestion(c.teacher, {
    courseId: c.courseId,
    kind: 'single',
    prompt: 'Which normal form removes transitive dependencies?',
    options: '2NF\n* 3NF\nBCNF\n1NF',
    topic: 'normalisation',
    explanation: '3NF: no non-key attribute depends on another non-key attribute.',
  })
  const multi = await createQuestion(c.teacher, {
    courseId: c.courseId,
    kind: 'multiple',
    prompt: 'Which are ACID properties?',
    options: '* Atomicity\n* Isolation\nAvailability\n* Durability',
    points: 2,
    partialCredit: 'true',
  })
  const short = await createQuestion(c.teacher, {
    courseId: c.courseId,
    kind: 'short',
    prompt: 'SQL keyword to remove duplicate rows from a result?',
    accepted: 'DISTINCT',
  })
  const number = await createQuestion(c.teacher, {
    courseId: c.courseId,
    kind: 'numeric',
    prompt: 'A relation has 3 attributes. How many superkeys at most?',
    numericAnswer: '7',
    points: 2,
  })
  return { capital, multi, short, number }
}

async function quizFor(c: Campus, over: Record<string, unknown> = {}) {
  const b = await bank(c)
  const q = await createQuiz(c.teacher, {
    offeringId: c.offeringId,
    title: 'Week 3 check',
    opensAt: iso(-H),
    closesAt: iso(2 * H),
    timeLimitMinutes: 20,
    attemptsAllowed: 2,
    ...over,
  })
  await addItems(c.teacher, { quizId: q.id, questionIds: [b.capital.id, b.multi.id, b.short.id, b.number.id] })
  await publishQuiz(c.teacher, { quizId: q.id })
  const v = await quizView(c.teacher, q.id)
  const item = Object.fromEntries(v.items.map((i) => [i.questionId, i.id]))
  return { quizId: q.id, b, item: { capital: item[b.capital.id]!, multi: item[b.multi.id]!, short: item[b.short.id]!, number: item[b.number.id]! } }
}

/** The clock moved on: an attempt's deadline put in the past, as only time can. */
async function expire(attemptId: string, seconds = 120) {
  await authDb.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`)
    await tx.execute(sql`update quiz_attempts set deadline = now() - make_interval(secs => ${seconds}) where id = ${attemptId}`)
  })
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

// --- the bank ------------------------------------------------------------------

test('a teacher writes questions for a course they teach, and only that course', async () => {
  const c = await campus()
  await bank(c)
  assert.equal((await listQuestions(c.teacher, c.courseId)).length, 4)
  await assert.rejects(
    createQuestion(c.otherTeacher, { courseId: c.courseId, kind: 'short', prompt: 'Not mine to write', accepted: 'x' }),
    (e) => code(e) === 'not_your_course',
  )
  await assert.rejects(listQuestions(c.asha, c.courseId), (e) => code(e) === 'forbidden')
})

test('a question the machine cannot score is refused, by the module and by the database', async () => {
  const c = await campus()
  await assert.rejects(
    createQuestion(c.teacher, { courseId: c.courseId, kind: 'single', prompt: 'Two right answers?', options: '* a\n* b\nc' }),
    (e) => code(e) === 'quiz_question_key',
  )
  // Straight to the table, past the module: still refused.
  await assert.rejects(
    withTenant(c.id, (tx) =>
      tx.insert(questions).values({
        institutionId: c.id,
        courseId: c.courseId,
        kind: 'single',
        prompt: 'no right answer',
        choices: [
          { id: 'a', label: 'x', correct: false },
          { id: 'b', label: 'y', correct: false },
        ],
      }),
    ),
    refusedBy('quiz_question_key'),
  )
})

test('a question is never edited: a revision replaces it, and the old one is retired', async () => {
  const c = await campus()
  const { capital } = await bank(c)
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(questions).set({ prompt: 'quietly changed' }).where(eq(questions.id, capital.id))),
    refusedBy('quiz_question_frozen'),
  )
  const v2 = await reviseQuestion(c.teacher, {
    questionId: capital.id,
    kind: 'single',
    prompt: 'Which normal form removes transitive dependencies on the key?',
    options: '2NF\n* 3NF\nBCNF',
  })
  assert.equal(v2.revisionOf, capital.id)
  const list = await listQuestions(c.teacher, c.courseId)
  assert.equal(list.find((q) => q.id === capital.id)?.retired, true)
  await assert.rejects(
    reviseQuestion(c.teacher, { questionId: capital.id, kind: 'short', prompt: 'again', accepted: 'x' }),
    (e) => code(e) === 'retired',
  )
})

// --- authoring a quiz ------------------------------------------------------------

test('a quiz is a draft until published, and frozen after', async () => {
  const c = await campus()
  const b = await bank(c)
  const q = await createQuiz(c.teacher, {
    offeringId: c.offeringId,
    title: 'Draft',
    opensAt: iso(-H),
    closesAt: iso(H),
  })
  await assert.rejects(publishQuiz(c.teacher, { quizId: q.id }), (e) => code(e) === 'quiz_publish_empty')

  const retired = await createQuestion(c.teacher, { courseId: c.courseId, kind: 'short', prompt: 'Old question', accepted: 'x' })
  await retireQuestion(c.teacher, { questionId: retired.id })
  await assert.rejects(addItems(c.teacher, { quizId: q.id, questionIds: [retired.id] }), (e) => code(e) === 'quiz_items_retired')

  const foreign = await createQuestion(c.otherTeacher, { courseId: c.otherCourseId, kind: 'short', prompt: 'Scheduling?', accepted: 'x' })
  await assert.rejects(addItems(c.teacher, { quizId: q.id, questionIds: [foreign.id] }), (e) => code(e) === 'quiz_items_course')

  await addItems(c.teacher, { quizId: q.id, questionIds: [b.capital.id, b.short.id] })
  await assert.rejects(addItems(c.teacher, { quizId: q.id, questionIds: [b.short.id] }), (e) => code(e) === 'quiz_items_once')
  await publishQuiz(c.teacher, { quizId: q.id })

  await assert.rejects(addItems(c.teacher, { quizId: q.id, questionIds: [b.multi.id] }), (e) => code(e) === 'quiz_items_frozen')
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(quizzes).set({ closesAt: new Date(Date.now() + 99 * H) }).where(eq(quizzes.id, q.id))),
    refusedBy('docstatus_locked'),
  )
  // Another teacher cannot so much as look.
  await assert.rejects(quizView(c.otherTeacher, q.id), (e) => code(e) === 'not_your_offering')
})

test('wall-clock times are read in the quiz zone', async () => {
  const c = await campus()
  const q = await createQuiz(c.teacher, {
    offeringId: c.offeringId,
    title: 'Zoned',
    opensAt: '2026-10-05T09:00',
    closesAt: '2026-10-05T17:00',
    timeZone: 'Asia/Kolkata',
  })
  assert.equal(q.closesAt.toISOString(), '2026-10-05T11:30:00.000Z')
  await assert.rejects(
    createQuiz(c.teacher, { offeringId: c.offeringId, title: 'Backwards', opensAt: '2026-10-05T17:00', closesAt: '2026-10-05T09:00' }),
    (e) => code(e) === 'quiz_quizzes_window',
  )
  await assert.rejects(
    createQuiz(c.teacher, { offeringId: c.offeringId, title: 'Nowhere', opensAt: iso(0), closesAt: iso(H), timeZone: 'Mars/Olympus' }),
    (e) => code(e) === 'bad_time_zone',
  )
})

// --- taking it ---------------------------------------------------------------------

test('a student sits a quiz without ever seeing the key, and the machine scores it', async () => {
  const c = await campus()
  const { quizId, item } = await quizFor(c, { penaltyPercent: 50, reveal: 'after_submit' })

  const a = await startAttempt(c.asha, { quizId })
  assert.equal(a.number, 1)
  // The deadline is the time limit, not the close two hours off.
  const minutes = (a.deadline.getTime() - a.startedAt.getTime()) / 60000
  assert.ok(Math.abs(minutes - 20) < 0.1, `deadline ${minutes} minutes after start`)

  const sheet = await attemptView(c.asha, a.id)
  const wire = JSON.stringify(sheet)
  for (const leak of ['"correct"', 'DISTINCT', 'numericAnswer', 'explanation', '3NF: no']) {
    assert.ok(!wire.includes(leak), `the answer sheet leaks ${leak}`)
  }

  // Starting again carries on with the same attempt.
  assert.equal((await startAttempt(c.asha, { quizId })).id, a.id)

  // Saved in two goes, as a form would send them.
  await saveAnswers(c.asha, { attemptId: a.id, [`q_${item.capital}`]: 'a', [`q_${item.short}`]: ' distinct ' })
  await saveAnswers(c.asha, { attemptId: a.id, [`q_${item.capital}`]: 'b' })
  const done = await saveAnswers(c.asha, {
    attemptId: a.id,
    answers: { [item.multi]: ['a', 'b'], [item.number]: '8' },
    finish: 'true',
  })
  // capital right (1) + multi two of three (2 * 2/3 = 1.33) + short right (1) + number wrong (-50% of 2 = -1)
  assert.equal(done.score, 2.33)
  assert.equal(done.max, 6)

  const result = await attemptView(c.asha, a.id)
  assert.equal(result.revealed, true)
  const byItem = Object.fromEntries(result.questions.map((q) => [q.itemId, q as typeof q & { awarded: number; correct: boolean | null }]))
  assert.equal(byItem[item.number]!.awarded, -1)
  assert.equal(byItem[item.multi]!.correct, false)

  // Submitted means final.
  await assert.rejects(
    saveAnswers(c.asha, { attemptId: a.id, [`q_${item.number}`]: '7' }),
    (e) => code(e) === 'quiz_response_locked',
  )
})

test('who may sit it, and how often, is the database’s call', async () => {
  const c = await campus()
  const { quizId } = await quizFor(c, { attemptsAllowed: 1 })
  await assert.rejects(startAttempt(c.outsider, { quizId }), (e) => code(e) === 'quiz_attempt_not_enrolled')
  await assert.rejects(startAttempt(c.teacher, { quizId }), (e) => code(e) === 'forbidden')

  const a = await startAttempt(c.bilal, { quizId })
  await saveAnswers(c.bilal, { attemptId: a.id, finish: 'true' })
  await assert.rejects(startAttempt(c.bilal, { quizId }), (e) => code(e) === 'quiz_attempt_limit')

  // Past the module: the database numbers, times and totals an attempt itself.
  const forged = await withTenant(c.id, (tx) =>
    tx
      .insert(attempts)
      .values({
        institutionId: c.id,
        quizId,
        studentId: c.asha.id,
        number: 7,
        deadline: new Date(Date.now() + 99 * H),
        maxScore: '1000',
      })
      .returning(),
  )
  assert.equal(forged[0]!.number, 1)
  assert.equal(Number(forged[0]!.maxScore), 6)
  assert.ok(forged[0]!.deadline.getTime() < Date.now() + 21 * 60_000)
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(attempts).set({ deadline: new Date(Date.now() + 99 * H) }).where(eq(attempts.id, forged[0]!.id))),
    refusedBy('quiz_attempt_fixed'),
  )
})

test('a score cannot be written: it is always the sum of the marks', async () => {
  const c = await campus()
  const { quizId, item } = await quizFor(c)
  const a = await startAttempt(c.asha, { quizId })
  await saveAnswers(c.asha, { attemptId: a.id, [`q_${item.capital}`]: 'b' })
  // No marks exist before submission, whoever writes them.
  await withTenant(c.id, (tx) => tx.update(responses).set({ awarded: '99' }).where(eq(responses.attemptId, a.id)))
  const [r] = await withTenant(c.id, (tx) => tx.select().from(responses).where(eq(responses.attemptId, a.id)))
  assert.equal(r!.awarded, null)

  await saveAnswers(c.asha, { attemptId: a.id, finish: 'true' })
  await withTenant(c.id, (tx) => tx.update(attempts).set({ score: '100' }).where(eq(attempts.id, a.id)))
  const [after] = await withTenant(c.id, (tx) => tx.select().from(attempts).where(eq(attempts.id, a.id)))
  assert.equal(Number(after!.score), 1)
  await assert.rejects(
    withTenant(c.id, (tx) => tx.delete(attempts).where(eq(attempts.id, a.id))),
    refusedBy('quiz_attempt_kept'),
  )
})

test('time up: late answers are refused, and the clock submits what was saved', async () => {
  const c = await campus()
  const { quizId, item } = await quizFor(c)
  const a = await startAttempt(c.asha, { quizId })
  await saveAnswers(c.asha, { attemptId: a.id, [`q_${item.capital}`]: 'b' })

  // Within the thirty seconds' grace an answer still lands.
  await expire(a.id, 10)
  await saveAnswers(c.asha, { attemptId: a.id, [`q_${item.short}`]: 'distinct' })

  await expire(a.id, 120)
  await assert.rejects(
    saveAnswers(c.asha, { attemptId: a.id, [`q_${item.number}`]: '7' }),
    (e) => code(e) === 'quiz_response_late',
  )
  const mine = await myQuizzes(c.asha)
  const q = mine.find((x) => x.id === quizId)!
  assert.equal(q.state, 'retake')
  assert.equal(q.score, 2)
  const [row] = await withTenant(c.id, (tx) => tx.select().from(attempts).where(eq(attempts.id, a.id)))
  assert.equal(row!.autoSubmitted, true)
  assert.equal(row!.submittedAt?.getTime(), row!.deadline.getTime())
})

test('answers are shown only as the quiz allows; a teacher always sees them', async () => {
  const c = await campus()
  const { quizId, item } = await quizFor(c, { reveal: 'after_close' })
  const a = await startAttempt(c.asha, { quizId })
  await saveAnswers(c.asha, { attemptId: a.id, [`q_${item.short}`]: 'unique', finish: 'true' })
  const student = await attemptView(c.asha, a.id)
  assert.equal(student.revealed, false)
  assert.ok(!JSON.stringify(student).includes('DISTINCT'))
  assert.equal(student.attempt.score, 0)

  const teacher = await attemptView(c.teacher, a.id)
  assert.equal(teacher.revealed, true)
  assert.ok(JSON.stringify(teacher).includes('DISTINCT'))
  // Nobody else's attempt is anybody's business.
  await assert.rejects(attemptView(c.bilal, a.id), (e) => code(e) === 'no_such_attempt')
  await assert.rejects(attemptView(c.otherTeacher, a.id), (e) => code(e) === 'not_your_offering')
})

test('a teacher changes a mark, never an answer; the total follows, on the record', async () => {
  const c = await campus()
  const { quizId, item } = await quizFor(c, { reveal: 'after_submit' })
  const a = await startAttempt(c.asha, { quizId })
  await saveAnswers(c.asha, { attemptId: a.id, [`q_${item.short}`]: 'SELECT DISTINCT', finish: 'true' })
  const view = await attemptView(c.teacher, a.id)
  const resp = view.questions.find((q) => q.itemId === item.short) as { responseId: string }

  await assert.rejects(
    overrideResponse(c.asha, { responseId: resp.responseId, awarded: 1, reason: 'I think so' }),
    (e) => code(e) === 'forbidden',
  )
  await assert.rejects(
    overrideResponse(c.teacher, { responseId: resp.responseId, awarded: 5, reason: 'too generous' }),
    (e) => code(e) === 'out_of_range',
  )
  const out = await overrideResponse(c.teacher, {
    responseId: resp.responseId,
    awarded: 1,
    reason: 'the keyword with SELECT is the same answer',
  })
  assert.equal(out.score, 1)
  const logged = await authDb
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, a.id), eq(auditLog.action, 'quizzes.mark_overridden')))
  assert.equal(logged.length, 1)
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(responses).set({ answer: 'DISTINCT' }).where(eq(responses.id, resp.responseId))),
    refusedBy('quiz_response_locked'),
  )
})

test('with two attempts, the best or the latest counts, as the quiz says', async () => {
  for (const keep of ['best', 'latest'] as const) {
    const c = await campus()
    const { quizId, item } = await quizFor(c, { keep })
    const first = await startAttempt(c.asha, { quizId })
    await saveAnswers(c.asha, { attemptId: first.id, [`q_${item.capital}`]: 'b', [`q_${item.short}`]: 'distinct', finish: 'true' })
    const second = await startAttempt(c.asha, { quizId })
    await saveAnswers(c.asha, { attemptId: second.id, [`q_${item.capital}`]: 'b', finish: 'true' })
    const q = (await myQuizzes(c.asha)).find((x) => x.id === quizId)!
    assert.equal(q.score, keep === 'best' ? 2 : 1, keep)
    assert.equal(q.state, 'done')
  }
})

test('more time for one student moves their deadline, and nobody else’s', async () => {
  const c = await campus()
  const { quizId } = await quizFor(c)
  await assert.rejects(
    grantExtension(c.teacher, { quizId, studentId: c.outsider.id, extraMinutes: 10, reason: 'not in this class' }),
    (e) => code(e) === 'not_in_class',
  )
  await grantExtension(c.teacher, { quizId, studentId: c.asha.id, extraMinutes: 10, reason: 'accommodation on file' })
  const a = await startAttempt(c.asha, { quizId })
  const b = await startAttempt(c.bilal, { quizId })
  assert.ok(Math.abs((a.deadline.getTime() - a.startedAt.getTime()) / 60000 - 30) < 0.1)
  assert.ok(Math.abs((b.deadline.getTime() - b.startedAt.getTime()) / 60000 - 20) < 0.1)
})

test('a withdrawn quiz takes no more answers, and revises into a new draft', async () => {
  const c = await campus()
  const { quizId, item, b } = await quizFor(c)
  const a = await startAttempt(c.asha, { quizId })
  await withdrawQuiz(c.teacher, { quizId, reason: 'question 4 has a typo' })
  await assert.rejects(
    saveAnswers(c.asha, { attemptId: a.id, [`q_${item.capital}`]: 'b' }),
    (e) => code(e) === 'quiz_response_withdrawn',
  )
  await assert.rejects(startAttempt(c.bilal, { quizId }), (e) => code(e) === 'quiz_attempt_unpublished')

  await reviseQuestion(c.teacher, { questionId: b.number.id, kind: 'numeric', prompt: 'A relation has 3 attributes. How many superkeys at most, if one is the key?', numericAnswer: '4' })
  const draft = await reviseQuiz(c.teacher, { quizId })
  const v = await quizView(c.teacher, draft.id)
  assert.equal(v.quiz.docstatus, 'draft')
  assert.equal(v.quiz.amendedFrom, quizId)
  assert.equal(v.items.length, 3, 'the retired question is not carried over')
})

test('another institution cannot see a quiz, and a quiz never touches a grade', async () => {
  const c = await campus()
  const d = await campus()
  const { quizId, item } = await quizFor(c)
  await assert.rejects(quizView(d.admin, quizId), (e) => code(e) === 'no_such_quiz')
  await assert.rejects(startAttempt(d.asha, { quizId }), (e) => code(e) === 'no_such_quiz')

  const a = await startAttempt(c.asha, { quizId })
  await saveAnswers(c.asha, { attemptId: a.id, [`q_${item.capital}`]: 'b', finish: 'true' })
  const completions = await withTenant(c.id, (tx) => tx.select().from(courseCompletions))
  assert.equal(completions.length, 0, 'a quiz wrote a course completion')
})
