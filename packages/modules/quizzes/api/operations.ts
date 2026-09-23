import { randomInt } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import {
  amendDocument,
  audit,
  cancelDocument,
  submitDocument,
  users,
  withTenant,
} from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { courses, offerings, sectionMembers, sections, terms } from '@campusos/module-academic/schema'
import { attempts, extensions, items, questions, quizzes, responses, type Attempt, type Question, type Quiz } from '../schema'
import {
  choicesForTaker,
  describeAnswer,
  describeKey,
  isBlank,
  parseChoices,
  scoreAnswer,
  type Answer,
  type AnswerKey,
  type Choice,
  type QuestionKind,
} from './scoring'
import {
  addItemsSchema,
  attemptRefSchema,
  createQuestionSchema,
  createQuizSchema,
  extensionSchema,
  overrideSchema,
  questionRefSchema,
  quizRefSchema,
  removeItemsSchema,
  reviseQuestionSchema,
  saveAnswersSchema,
  updateQuizSchema,
  withdrawQuizSchema,
} from './schemas'
import { assertZone, instant, wallClock, ZoneError } from './time'

const MODULE = 'quizzes'

/** Seconds after the deadline an answer is still taken: the network's share. */
export const GRACE_SECONDS = 30

export interface Actor {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class QuizError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const tenantOf = (actor: Actor) => {
  if (!actor.institutionId) throw new QuizError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
const isAdmin = (r: Role) => r === 'institution_admin' || r === 'super_admin'
/** Sees every course and quiz in the institution. */
const seesAll = (r: Role) => isAdmin(r) || r === 'hod'
const isStaff = (r: Role) => seesAll(r) || r === 'faculty'
const requireStaff = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!isStaff(actor.role)) throw new QuizError(403, 'forbidden', 'not permitted')
  return t
}
const requireStudent = (actor: Actor) => {
  const t = tenantOf(actor)
  if (actor.role !== 'student') throw new QuizError(403, 'forbidden', 'only a student takes a quiz')
  return t
}
const who = (actor: Actor, tenant: string) => ({
  institutionId: tenant,
  actorId: actor.id,
  actorEmail: actor.email ?? null,
  moduleId: MODULE,
})
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v))
const pct = (score: number | null, max: number | null) =>
  score === null || !max ? null : Math.round((score / max) * 1000) / 10

/** Named refusals raised by this module's triggers, in words a person can act on. */
const REFUSALS: Record<string, [number, string]> = {
  quiz_question_key: [400, 'that question has no answer it can be scored against'],
  quiz_question_frozen: [409, 'a question is never edited; revise it into a new one'],
  quiz_items_frozen: [409, 'a published quiz is not changed; withdraw it and revise'],
  quiz_items_retired: [409, 'that question is retired'],
  quiz_items_course: [409, "that question is from another course's bank"],
  quiz_items_once: [409, 'that question is already on this quiz'],
  quiz_publish_empty: [409, 'add a question before publishing'],
  quiz_publish_closed: [409, 'that quiz has already closed; change its window first'],
  quiz_attempt_unpublished: [409, 'that quiz is not published'],
  quiz_attempt_not_enrolled: [403, 'that quiz is for another class'],
  quiz_attempt_not_open: [409, 'that quiz is not open yet'],
  quiz_attempt_closed: [409, 'that quiz has closed'],
  quiz_attempt_limit: [409, 'you have no attempts left'],
  quiz_attempts_open: [409, 'an attempt is already in progress'],
  quiz_response_locked: [409, 'that attempt is submitted; its answers are final'],
  quiz_response_late: [409, 'time is up for that attempt'],
  quiz_response_withdrawn: [409, 'that quiz was withdrawn'],
  quiz_quizzes_window: [400, 'a quiz must close after it opens'],
}

async function named<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const constraint = (e as { cause?: { constraint?: string }; constraint?: string }).cause?.constraint ??
      (e as { constraint?: string }).constraint
    const known = constraint ? REFUSALS[constraint] : undefined
    if (known) throw new QuizError(known[0] as 400 | 403 | 409, constraint!, known[1])
    if (e instanceof ZoneError) throw new QuizError(400, 'bad_time_zone', e.message)
    throw e
  }
}

// --- who may touch what ------------------------------------------------------

/** A teacher writes questions for a course they teach, in any term. */
async function assertCourse(tx: Tx, actor: Actor, courseId: string) {
  const [c] = await tx.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId))
  if (!c) throw new QuizError(404, 'no_such_course', 'no such course')
  if (seesAll(actor.role)) return
  const [teaches] = await tx
    .select({ id: offerings.id })
    .from(offerings)
    .where(and(eq(offerings.courseId, courseId), eq(offerings.facultyUserId, actor.id)))
    .limit(1)
  if (!teaches) throw new QuizError(403, 'not_your_course', 'you do not teach that course')
}

async function assertOffering(tx: Tx, actor: Actor, offeringId: string) {
  const [o] = await tx
    .select({ id: offerings.id, faculty: offerings.facultyUserId, courseId: offerings.courseId, sectionId: offerings.sectionId })
    .from(offerings)
    .where(eq(offerings.id, offeringId))
  if (!o) throw new QuizError(404, 'no_such_offering', 'no such offering')
  if (!seesAll(actor.role) && o.faculty !== actor.id) {
    throw new QuizError(403, 'not_your_offering', 'that is not your class')
  }
  return o
}

async function quizIn(tx: Tx, actor: Actor, quizId: string) {
  const [q] = await tx.select().from(quizzes).where(eq(quizzes.id, quizId))
  if (!q) throw new QuizError(404, 'no_such_quiz', 'no such quiz')
  const o = await assertOffering(tx, actor, q.offeringId)
  return { quiz: q, offering: o }
}

// --- pickers -----------------------------------------------------------------

export async function courseChoices(actor: Actor) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, (tx) =>
    tx
      .selectDistinct({ id: courses.id, code: courses.code, title: courses.title })
      .from(courses)
      .leftJoin(offerings, eq(offerings.courseId, courses.id))
      .where(seesAll(actor.role) ? undefined : eq(offerings.facultyUserId, actor.id))
      .orderBy(asc(courses.code)),
  )
}

export async function offeringChoices(actor: Actor) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: offerings.id,
        courseId: offerings.courseId,
        course: courses.code,
        title: courses.title,
        section: sections.label,
        admissionYear: sections.admissionYear,
        term: terms.code,
      })
      .from(offerings)
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .innerJoin(terms, eq(terms.id, offerings.termId))
      .where(seesAll(actor.role) ? undefined : eq(offerings.facultyUserId, actor.id))
      .orderBy(desc(terms.startsOn), asc(courses.code)),
  )
}

// --- the question bank -------------------------------------------------------

type QuestionInput = ReturnType<typeof createQuestionSchema.parse>

/** The key a question is scored against, from what the form sent. */
function keyFrom(d: Omit<QuestionInput, 'courseId'>) {
  const kind = d.kind as QuestionKind
  let choices: Choice[] = []
  if (kind === 'single' || kind === 'multiple') choices = parseChoices(d.options ?? '')
  if (kind === 'true_false') {
    if (!d.answer) throw new QuizError(400, 'no_answer', 'say whether the statement is true or false')
    choices = [
      { id: 'true', label: 'True', correct: d.answer === 'true' },
      { id: 'false', label: 'False', correct: d.answer === 'false' },
    ]
  }
  if (kind === 'single' && choices.filter((c) => c.correct).length !== 1) {
    throw new QuizError(400, 'quiz_question_key', 'mark exactly one option right with a leading *')
  }
  if (kind === 'multiple' && choices.filter((c) => c.correct).length < 1) {
    throw new QuizError(400, 'quiz_question_key', 'mark the right options with a leading *')
  }
  if ((kind === 'single' || kind === 'multiple') && choices.length < 2) {
    throw new QuizError(400, 'quiz_question_key', 'give at least two options, one per line')
  }
  if (kind === 'short' && !d.accepted?.length) {
    throw new QuizError(400, 'quiz_question_key', 'give at least one accepted answer')
  }
  if (kind === 'numeric' && d.numericAnswer === undefined) {
    throw new QuizError(400, 'quiz_question_key', 'give the right number')
  }
  return {
    kind,
    choices,
    acceptedAnswers: kind === 'short' ? (d.accepted ?? []) : [],
    numericAnswer: kind === 'numeric' ? String(d.numericAnswer) : null,
    tolerance: kind === 'numeric' ? String(d.tolerance) : '0',
    partialCredit: kind === 'multiple' ? d.partialCredit : false,
    points: d.points.toFixed(2),
    prompt: d.prompt,
    topic: d.topic || null,
    explanation: d.explanation || null,
  }
}

export const keyOf = (q: Pick<Question, 'kind' | 'choices' | 'acceptedAnswers' | 'numericAnswer' | 'tolerance' | 'partialCredit'>): AnswerKey => ({
  kind: q.kind,
  choices: q.choices,
  acceptedAnswers: q.acceptedAnswers,
  numericAnswer: q.numericAnswer,
  tolerance: q.tolerance,
  partialCredit: q.partialCredit,
})

export async function createQuestion(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = createQuestionSchema.parse(input)
  const key = keyFrom(d)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await assertCourse(tx, actor, d.courseId)
      const [row] = await tx
        .insert(questions)
        .values({ institutionId: tenant, courseId: d.courseId, ...key, createdBy: actor.id })
        .returning()
      return { ...row!, notice: 'Question added to the bank.' }
    }),
  )
}

/**
 * A correction: a new question naming the one it replaces, which is retired.
 * Quizzes already taken keep the question they were scored against.
 */
export async function reviseQuestion(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = reviseQuestionSchema.parse(input)
  const key = keyFrom(d)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [old] = await tx.select().from(questions).where(eq(questions.id, d.questionId)).for('update')
      if (!old) throw new QuizError(404, 'no_such_question', 'no such question')
      await assertCourse(tx, actor, old.courseId)
      if (old.retiredAt) throw new QuizError(409, 'retired', 'that question is retired; revise its latest version')
      await tx.update(questions).set({ retiredAt: new Date() }).where(eq(questions.id, old.id))
      const [row] = await tx
        .insert(questions)
        .values({ institutionId: tenant, courseId: old.courseId, ...key, revisionOf: old.id, createdBy: actor.id })
        .returning()
      await audit(tx, {
        ...who(actor, tenant),
        action: 'quizzes.question_revised',
        entity: 'quiz_questions',
        entityId: row!.id,
        reason: `revises ${old.id}`,
        detail: { revisionOf: old.id },
      })
      return { ...row!, notice: 'Revised. The old version is retired; quizzes already set keep it.' }
    }),
  )
}

export async function retireQuestion(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = questionRefSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [q] = await tx.select().from(questions).where(eq(questions.id, d.questionId))
      if (!q) throw new QuizError(404, 'no_such_question', 'no such question')
      await assertCourse(tx, actor, q.courseId)
      if (q.retiredAt) throw new QuizError(409, 'retired', 'already retired')
      const [row] = await tx.update(questions).set({ retiredAt: new Date() }).where(eq(questions.id, q.id)).returning()
      return { ...row!, notice: 'Retired. It stays on the quizzes that used it.' }
    }),
  )
}

export async function listQuestions(actor: Actor, courseId: string) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    await assertCourse(tx, actor, courseId)
    const rows = await tx
      .select({
        q: questions,
        used: sql<number>`(select count(distinct i.quiz_id)::int from quiz_items i where i.question_id = quiz_questions.id)`,
      })
      .from(questions)
      .where(eq(questions.courseId, courseId))
      .orderBy(asc(questions.retiredAt), desc(questions.createdAt))
    return rows.map(({ q, used }) => ({
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      topic: q.topic,
      points: num(q.points),
      key: describeKey(keyOf(q)),
      used,
      retired: !!q.retiredAt,
      retiredAt: q.retiredAt,
      revisionOf: q.revisionOf,
      createdAt: q.createdAt,
    }))
  })
}

export async function questionView(actor: Actor, questionId: string) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const [q] = await tx.select().from(questions).where(eq(questions.id, questionId))
    if (!q) throw new QuizError(404, 'no_such_question', 'no such question')
    await assertCourse(tx, actor, q.courseId)
    const [course] = await tx.select({ code: courses.code, title: courses.title }).from(courses).where(eq(courses.id, q.courseId))
    const [revisedBy] = await tx.select({ id: questions.id }).from(questions).where(eq(questions.revisionOf, q.id))
    const usedOn = await tx
      .select({ id: quizzes.id, title: quizzes.title, docstatus: quizzes.docstatus })
      .from(items)
      .innerJoin(quizzes, eq(quizzes.id, items.quizId))
      .where(eq(items.questionId, q.id))
    const [by] = q.createdBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, q.createdBy)) : []
    return {
      ...q,
      points: num(q.points),
      course: course ? `${course.code} ${course.title}` : '',
      key: describeKey(keyOf(q)),
      revisedBy: revisedBy?.id ?? null,
      usedOn,
      createdByName: by?.name ?? null,
    }
  })
}

// --- quizzes -----------------------------------------------------------------

function windowOf(d: { opensAt: string; closesAt: string; timeZone: string }) {
  const zone = assertZone(d.timeZone)
  const opensAt = instant(d.opensAt, zone)
  const closesAt = instant(d.closesAt, zone)
  if (Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime())) {
    throw new QuizError(400, 'bad_time', 'that is not a date and time')
  }
  if (closesAt <= opensAt) throw new QuizError(400, 'quiz_quizzes_window', 'a quiz must close after it opens')
  return { opensAt, closesAt, timeZone: zone }
}

export async function createQuiz(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = createQuizSchema.parse(input)
  return named(async () => {
    const w = windowOf(d)
    return withTenant(tenant, async (tx) => {
      await assertOffering(tx, actor, d.offeringId)
      const [row] = await tx
        .insert(quizzes)
        .values({
          institutionId: tenant,
          offeringId: d.offeringId,
          title: d.title,
          instructions: d.instructions || null,
          ...w,
          timeLimitMinutes: d.timeLimitMinutes ?? null,
          attemptsAllowed: d.attemptsAllowed,
          keep: d.keep,
          penaltyPercent: d.penaltyPercent.toFixed(2),
          reveal: d.reveal,
          shuffle: d.shuffle,
          createdBy: actor.id,
        })
        .returning()
      return { ...row!, notice: 'Draft quiz created. Add questions, then publish.', link: `/m/quizzes/quiz?quizId=${row!.id}` }
    })
  })
}

/** A draft changes freely; a published quiz does not change at all. */
export async function updateQuiz(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = updateQuizSchema.parse(input)
  return named(async () => {
    const w = windowOf(d)
    return withTenant(tenant, async (tx) => {
      const { quiz } = await quizIn(tx, actor, d.quizId)
      if (quiz.docstatus !== 'draft') {
        throw new QuizError(409, 'not_a_draft', 'a published quiz is not changed; withdraw it and revise')
      }
      const [row] = await tx
        .update(quizzes)
        .set({
          title: d.title,
          instructions: d.instructions || null,
          ...w,
          timeLimitMinutes: d.timeLimitMinutes ?? null,
          attemptsAllowed: d.attemptsAllowed,
          keep: d.keep,
          penaltyPercent: d.penaltyPercent.toFixed(2),
          reveal: d.reveal,
          shuffle: d.shuffle,
        })
        .where(eq(quizzes.id, quiz.id))
        .returning()
      return { ...row!, notice: 'Saved.' }
    })
  })
}

export async function addItems(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = addItemsSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const { quiz } = await quizIn(tx, actor, d.quizId)
      if (quiz.docstatus !== 'draft') {
        throw new QuizError(409, 'quiz_items_frozen', 'a published quiz is not changed; withdraw it and revise')
      }
      const qs = await tx.select().from(questions).where(inArray(questions.id, d.questionIds))
      if (qs.length !== new Set(d.questionIds).size) throw new QuizError(404, 'no_such_question', 'no such question')
      const [{ top } = { top: 0 }] = await tx
        .select({ top: sql<number>`coalesce(max(${items.position}), 0)::int` })
        .from(items)
        .where(eq(items.quizId, quiz.id))
      // In the order asked for, after what is already there.
      const ordered = d.questionIds.map((id) => qs.find((q) => q.id === id)!)
      await tx.insert(items).values(
        ordered.map((q, i) => ({
          institutionId: tenant,
          quizId: quiz.id,
          questionId: q.id,
          position: top + i + 1,
          points: d.points !== undefined ? d.points.toFixed(2) : q.points,
        })),
      )
      return { added: ordered.length, notice: `${ordered.length} question${ordered.length === 1 ? '' : 's'} added.` }
    }),
  )
}

export async function removeItems(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = removeItemsSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const { quiz } = await quizIn(tx, actor, d.quizId)
      const gone = await tx
        .delete(items)
        .where(and(eq(items.quizId, quiz.id), inArray(items.id, d.itemIds)))
        .returning({ id: items.id })
      return { removed: gone.length, notice: `${gone.length} removed.` }
    }),
  )
}

export async function publishQuiz(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = quizRefSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await quizIn(tx, actor, d.quizId)
      const row = await submitDocument(tx, quizzes, d.quizId, who(actor, tenant))
      return { ...row, notice: 'Published. Students in the class can take it once it opens.' }
    }),
  )
}

/** Withdraw, with a reason. Attempts already made stay on record; no more are taken. */
export async function withdrawQuiz(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = withdrawQuizSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await quizIn(tx, actor, d.quizId)
      const row = await cancelDocument(tx, quizzes, d.quizId, { ...who(actor, tenant), reason: d.reason })
      return { ...row, notice: 'Withdrawn. Revise it into a new draft to set it again.' }
    }),
  )
}

/** A withdrawn quiz, copied into a new draft with the same questions. */
export async function reviseQuiz(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = quizRefSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await quizIn(tx, actor, d.quizId)
      const draft = await amendDocument(tx, quizzes, d.quizId, who(actor, tenant), { created_by: actor.id })
      const from = await tx.select().from(items).where(eq(items.quizId, d.quizId)).orderBy(asc(items.position))
      // A retired question is not carried: it was retired for a reason.
      const live = await tx
        .select({ id: questions.id })
        .from(questions)
        .where(and(inArray(questions.id, from.length ? from.map((i) => i.questionId) : ['00000000-0000-0000-0000-000000000000']), isNull(questions.retiredAt)))
      const keep = new Set(live.map((q) => q.id))
      const carried = from.filter((i) => keep.has(i.questionId))
      if (carried.length) {
        await tx.insert(items).values(
          carried.map((i, n) => ({
            institutionId: tenant,
            quizId: String(draft.id),
            questionId: i.questionId,
            position: n + 1,
            points: i.points,
          })),
        )
      }
      const dropped = from.length - carried.length
      return {
        id: String(draft.id),
        notice: `New draft made with ${carried.length} question${carried.length === 1 ? '' : 's'}` +
          (dropped ? `; ${dropped} retired since were left out.` : '.'),
        link: `/m/quizzes/quiz?quizId=${String(draft.id)}`,
      }
    }),
  )
}

export async function grantExtension(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = extensionSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const { quiz, offering } = await quizIn(tx, actor, d.quizId)
      if (quiz.docstatus === 'cancelled') throw new QuizError(409, 'withdrawn', 'that quiz was withdrawn')
      const [member] = await tx
        .select({ id: sectionMembers.userId })
        .from(sectionMembers)
        .where(and(eq(sectionMembers.sectionId, offering.sectionId), eq(sectionMembers.userId, d.studentId)))
      if (!member) throw new QuizError(404, 'not_in_class', 'that student is not in this class')
      const closesAt = d.closesAt ? instant(d.closesAt, quiz.timeZone) : null
      if (closesAt && closesAt <= quiz.closesAt) {
        throw new QuizError(400, 'not_later', 'an extension closes later than the quiz does')
      }
      if (!closesAt && d.extraMinutes === 0) {
        throw new QuizError(400, 'nothing_extended', 'give a later close, extra minutes, or both')
      }
      const values = { closesAt, extraMinutes: d.extraMinutes, reason: d.reason, grantedBy: actor.id }
      const [row] = await tx
        .insert(extensions)
        .values({ institutionId: tenant, quizId: quiz.id, studentId: d.studentId, ...values })
        .onConflictDoUpdate({ target: [extensions.quizId, extensions.studentId], set: values })
        .returning()
      await audit(tx, {
        ...who(actor, tenant),
        action: 'quizzes.extension_granted',
        entity: 'quiz_quizzes',
        entityId: quiz.id,
        reason: d.reason,
        detail: { studentId: d.studentId, closesAt: closesAt?.toISOString() ?? null, extraMinutes: d.extraMinutes },
      })
      return { ...row!, notice: 'Extension granted.' }
    }),
  )
}

// --- scoring an attempt ------------------------------------------------------

/**
 * Close an attempt and score it. The attempt is locked first, so a student
 * pressing submit twice, or the clock and the student at once, score it once.
 * The database sums the marks into the attempt's score.
 */
async function finalise(tx: Tx, attemptId: string, auto: boolean) {
  const [a] = await tx.select().from(attempts).where(eq(attempts.id, attemptId)).for('update')
  if (!a || a.submittedAt) return a ?? null
  const [quiz] = await tx.select().from(quizzes).where(eq(quizzes.id, a.quizId))
  const late = Date.now() > a.deadline.getTime() + GRACE_SECONDS * 1000
  await tx
    .update(attempts)
    .set({ submittedAt: auto || late ? a.deadline : new Date(), autoSubmitted: auto || late })
    .where(eq(attempts.id, a.id))
  const rows = await tx
    .select({ r: responses, points: items.points, q: questions })
    .from(responses)
    .innerJoin(items, eq(items.id, responses.itemId))
    .innerJoin(questions, eq(questions.id, items.questionId))
    .where(eq(responses.attemptId, a.id))
  const penalty = Number(quiz!.penaltyPercent)
  for (const { r, points, q } of rows) {
    const s = scoreAnswer(keyOf(q), r.answer as Answer, Number(points), penalty)
    await tx
      .update(responses)
      .set({ correct: s.correct, awarded: s.awarded.toFixed(2) })
      .where(eq(responses.id, r.id))
  }
  const [done] = await tx.select().from(attempts).where(eq(attempts.id, a.id))
  return done!
}

/** Attempts whose time is up and grace spent, submitted by the clock. */
async function finaliseExpired(tx: Tx, where: { quizId?: string; studentId?: string }) {
  const due = await tx
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        isNull(attempts.submittedAt),
        lt(attempts.deadline, sql`now() - make_interval(secs => ${GRACE_SECONDS})`),
        where.quizId ? eq(attempts.quizId, where.quizId) : undefined,
        where.studentId ? eq(attempts.studentId, where.studentId) : undefined,
      ),
    )
  for (const { id } of due) await finalise(tx, id, true)
  return due.length
}

/** The attempt that counts: best or latest, as the quiz says. */
const counted = <A extends Pick<Attempt, 'score' | 'number'>>(quiz: Pick<Quiz, 'keep'>, done: A[]): A | null => {
  if (!done.length) return null
  return quiz.keep === 'latest'
    ? done.reduce((a, b) => (b.number > a.number ? b : a))
    : done.reduce((a, b) => (Number(b.score) > Number(a.score) ? b : a))
}

// --- the teacher's view of a quiz -------------------------------------------

export async function listQuizzes(actor: Actor) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: quizzes.id,
        title: quizzes.title,
        course: courses.code,
        section: sections.label,
        term: terms.code,
        opensAt: quizzes.opensAt,
        closesAt: quizzes.closesAt,
        timeZone: quizzes.timeZone,
        docstatus: quizzes.docstatus,
        questions: sql<number>`(select count(*)::int from quiz_items i where i.quiz_id = quiz_quizzes.id)`,
        takers: sql<number>`(select count(distinct a.student_id)::int from quiz_attempts a where a.quiz_id = quiz_quizzes.id and a.submitted_at is not null)`,
        classSize: sql<number>`(select count(*)::int from academic_section_members m where m.section_id = academic_offerings.section_id)`,
      })
      .from(quizzes)
      .innerJoin(offerings, eq(offerings.id, quizzes.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .innerJoin(terms, eq(terms.id, offerings.termId))
      .where(seesAll(actor.role) ? undefined : eq(offerings.facultyUserId, actor.id))
      .orderBy(desc(quizzes.opensAt)),
  )
}

/** Where a quiz stands in time, for a reader: before, during, after. */
const phaseOf = (q: Pick<Quiz, 'docstatus' | 'opensAt' | 'closesAt'>, now = new Date()) =>
  q.docstatus === 'draft'
    ? 'draft'
    : q.docstatus === 'cancelled'
      ? 'withdrawn'
      : now < q.opensAt
        ? 'upcoming'
        : now < q.closesAt
          ? 'open'
          : 'closed'

export async function quizView(actor: Actor, quizId: string) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const { quiz, offering } = await quizIn(tx, actor, quizId)
    await finaliseExpired(tx, { quizId: quiz.id })

    const [meta] = await tx
      .select({ course: courses.code, title: courses.title, section: sections.label, term: terms.code })
      .from(offerings)
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .innerJoin(terms, eq(terms.id, offerings.termId))
      .where(eq(offerings.id, offering.id))

    const itemRows = await tx
      .select({ item: items, q: questions })
      .from(items)
      .innerJoin(questions, eq(questions.id, items.questionId))
      .where(eq(items.quizId, quiz.id))
      .orderBy(asc(items.position))

    const roster = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(sectionMembers)
      .innerJoin(users, eq(users.id, sectionMembers.userId))
      .where(and(eq(sectionMembers.sectionId, offering.sectionId), eq(users.role, 'student')))
      .orderBy(asc(users.name))

    const all = await tx.select().from(attempts).where(eq(attempts.quizId, quiz.id)).orderBy(asc(attempts.number))
    const exts = await tx
      .select({ e: extensions, name: users.name })
      .from(extensions)
      .innerJoin(users, eq(users.id, extensions.studentId))
      .where(eq(extensions.quizId, quiz.id))

    const results = roster.map((s) => {
      const mine = all.filter((a) => a.studentId === s.id)
      const done = mine.filter((a) => a.submittedAt)
      const c = counted(quiz, done)
      const open = mine.find((a) => !a.submittedAt)
      const score = c ? Number(c.score) : null
      const max = c ? Number(c.maxScore) : null
      return {
        studentId: s.id,
        name: s.name ?? s.email,
        attempts: mine.length,
        state: open ? 'in_progress' : done.length ? 'submitted' : 'not_started',
        score,
        max,
        percent: pct(score, max),
        attemptId: c?.id ?? open?.id ?? null,
        submittedAt: c?.submittedAt ?? null,
        auto: c?.autoSubmitted ?? false,
      }
    })

    // Item analysis over every submitted attempt: how many got it right, how
    // many left it blank, and the average mark -- the facility of the question.
    const submitted = all.filter((a) => a.submittedAt)
    const resp = submitted.length
      ? await tx
          .select({ itemId: responses.itemId, answer: responses.answer, correct: responses.correct, awarded: responses.awarded })
          .from(responses)
          .where(inArray(responses.attemptId, submitted.map((a) => a.id)))
      : []
    const analysis = itemRows.map(({ item, q }, i) => {
      const rs = resp.filter((r) => r.itemId === item.id)
      const answered = rs.filter((r) => !isBlank(r.answer as Answer))
      const right = rs.filter((r) => r.correct === true).length
      const marks = rs.reduce((s, r) => s + Number(r.awarded ?? 0), 0)
      return {
        itemId: item.id,
        n: i + 1,
        prompt: q.prompt,
        kind: q.kind,
        topic: q.topic,
        points: Number(item.points),
        key: describeKey(keyOf(q)),
        attempted: submitted.length,
        answered: answered.length,
        blank: submitted.length - answered.length,
        right,
        facility: submitted.length ? Math.round((right / submitted.length) * 100) : null,
        average: submitted.length ? Math.round((marks / submitted.length) * 100) / 100 : null,
        retired: !!q.retiredAt,
      }
    })

    // How the class did, in tenths.
    const bands = Array.from({ length: 10 }, (_, i) => ({ band: `${i * 10}-${i === 9 ? 100 : i * 10 + 9}%`, students: 0 }))
    for (const r of results) {
      if (r.percent === null) continue
      bands[Math.min(9, Math.floor(r.percent / 10))]!.students++
    }

    const [replacedBy] = await tx.select({ id: quizzes.id }).from(quizzes).where(eq(quizzes.amendedFrom, quiz.id))
    const scored = results.filter((r) => r.percent !== null)
    return {
      quiz: {
        ...quiz,
        penaltyPercent: Number(quiz.penaltyPercent),
        phase: phaseOf(quiz),
        opens: wallClock(quiz.opensAt, quiz.timeZone),
        closes: wallClock(quiz.closesAt, quiz.timeZone),
        course: meta ? `${meta.course} ${meta.title}` : '',
        className: meta ? `${meta.section}, ${meta.term}` : '',
        courseId: offering.courseId,
        maxScore: itemRows.reduce((s, r) => s + Number(r.item.points), 0),
        replacedBy: replacedBy?.id ?? null,
      },
      items: itemRows.map(({ item, q }, i) => ({
        id: item.id,
        n: i + 1,
        questionId: q.id,
        kind: q.kind,
        prompt: q.prompt,
        points: Number(item.points),
        key: describeKey(keyOf(q)),
        retired: !!q.retiredAt,
      })),
      results,
      analysis,
      bands,
      extensions: exts.map(({ e, name }) => ({
        ...e,
        name,
        closes: e.closesAt ? wallClock(e.closesAt, quiz.timeZone) : '',
      })),
      roster,
      summary: {
        classSize: roster.length,
        took: scored.length,
        inProgress: results.filter((r) => r.state === 'in_progress').length,
        average: scored.length ? Math.round((scored.reduce((s, r) => s + r.percent!, 0) / scored.length) * 10) / 10 : null,
        median: scored.length ? median(scored.map((r) => r.percent!)) : null,
      },
    }
  })
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : Math.round(((s[m - 1]! + s[m]!) / 2) * 10) / 10
}

/** Questions from the course's bank that are live and not on this quiz yet. */
export async function bankChoices(actor: Actor, quizId: string) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const { offering } = await quizIn(tx, actor, quizId)
    return tx
      .select({ id: questions.id, prompt: questions.prompt, kind: questions.kind, points: questions.points, topic: questions.topic })
      .from(questions)
      .where(
        and(
          eq(questions.courseId, offering.courseId),
          isNull(questions.retiredAt),
          sql`not exists (select 1 from quiz_items i where i.quiz_id = ${quizId} and i.question_id = quiz_questions.id)`,
        ),
      )
      .orderBy(asc(questions.topic), asc(questions.createdAt))
  })
}

export async function overrideResponse(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = overrideSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [r] = await tx
        .select({ r: responses, a: attempts, points: items.points })
        .from(responses)
        .innerJoin(attempts, eq(attempts.id, responses.attemptId))
        .innerJoin(items, eq(items.id, responses.itemId))
        .where(eq(responses.id, d.responseId))
      if (!r) throw new QuizError(404, 'no_such_response', 'no such answer')
      await quizIn(tx, actor, r.a.quizId)
      if (!r.a.submittedAt) throw new QuizError(409, 'not_submitted', 'that attempt is still in progress')
      const max = Number(r.points)
      if (d.awarded > max || d.awarded < -max) {
        throw new QuizError(400, 'out_of_range', `this question is worth ${max}`)
      }
      await tx
        .update(responses)
        .set({
          awarded: d.awarded.toFixed(2),
          correct: d.awarded >= max,
          overriddenBy: actor.id,
          overriddenAt: new Date(),
          overrideReason: d.reason,
        })
        .where(eq(responses.id, r.r.id))
      await audit(tx, {
        ...who(actor, tenant),
        action: 'quizzes.mark_overridden',
        entity: 'quiz_attempts',
        entityId: r.a.id,
        reason: d.reason,
        detail: { responseId: r.r.id, from: num(r.r.awarded), to: d.awarded },
      })
      const [a] = await tx.select({ score: attempts.score }).from(attempts).where(eq(attempts.id, r.a.id))
      return { score: num(a?.score ?? null), notice: `Mark changed. The attempt now scores ${num(a?.score ?? null)}.` }
    }),
  )
}

// --- the student -------------------------------------------------------------

export async function myQuizzes(actor: Actor) {
  const tenant = requireStudent(actor)
  return withTenant(tenant, async (tx) => {
    await finaliseExpired(tx, { studentId: actor.id })
    const rows = await tx
      .select({
        quiz: quizzes,
        course: courses.code,
        courseTitle: courses.title,
        extClosesAt: extensions.closesAt,
        extMinutes: extensions.extraMinutes,
      })
      .from(quizzes)
      .innerJoin(offerings, eq(offerings.id, quizzes.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sectionMembers, and(eq(sectionMembers.sectionId, offerings.sectionId), eq(sectionMembers.userId, actor.id)))
      .leftJoin(extensions, and(eq(extensions.quizId, quizzes.id), eq(extensions.studentId, actor.id)))
      .where(inArray(quizzes.docstatus, ['submitted', 'cancelled']))
      .orderBy(desc(quizzes.opensAt))
    const mine = rows.length
      ? await tx
          .select()
          .from(attempts)
          .where(and(eq(attempts.studentId, actor.id), inArray(attempts.quizId, rows.map((r) => r.quiz.id))))
      : []
    const now = new Date()
    return rows
      // A quiz withdrawn before anybody sat it is simply gone for the student.
      .filter((r) => r.quiz.docstatus === 'submitted' || mine.some((a) => a.quizId === r.quiz.id))
      .map(({ quiz, course, courseTitle, extClosesAt, extMinutes }) => {
        const closes = extClosesAt && extClosesAt > quiz.closesAt ? extClosesAt : quiz.closesAt
        const ts = mine.filter((a) => a.quizId === quiz.id)
        const done = ts.filter((a) => a.submittedAt)
        const open = ts.find((a) => !a.submittedAt)
        const c = counted(quiz, done)
        const left = quiz.attemptsAllowed - ts.length
        const state =
          quiz.docstatus === 'cancelled'
            ? 'withdrawn'
            : open
              ? 'in_progress'
              : now < quiz.opensAt
                ? 'upcoming'
                : now < closes && left > 0
                  ? done.length
                    ? 'retake'
                    : 'open'
                  : done.length
                    ? 'done'
                    : now >= closes
                      ? 'missed'
                      : 'done'
        const score = c ? Number(c.score) : null
        const max = c ? Number(c.maxScore) : null
        return {
          id: quiz.id,
          title: quiz.title,
          course: `${course} ${courseTitle}`,
          opens: wallClock(quiz.opensAt, quiz.timeZone),
          closes: wallClock(closes, quiz.timeZone),
          timeLimit: quiz.timeLimitMinutes ? `${quiz.timeLimitMinutes + (extMinutes ?? 0)} min` : 'none',
          attempts: `${ts.length} of ${quiz.attemptsAllowed}`,
          state,
          score,
          max,
          percent: pct(score, max),
          resultId: c?.id ?? null,
          openAttemptId: open?.id ?? null,
        }
      })
  })
}

const shuffled = <T>(xs: T[]) => {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/**
 * Start, or carry on with the attempt already open. Whether a student may
 * start at all -- published, open, in the class, attempts left -- is the
 * database's call, made as the attempt is inserted.
 */
export async function startAttempt(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const d = quizRefSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [quiz] = await tx.select().from(quizzes).where(eq(quizzes.id, d.quizId))
      if (!quiz) throw new QuizError(404, 'no_such_quiz', 'no such quiz')
      await finaliseExpired(tx, { quizId: quiz.id, studentId: actor.id })
      const [open] = await tx
        .select()
        .from(attempts)
        .where(and(eq(attempts.quizId, quiz.id), eq(attempts.studentId, actor.id), isNull(attempts.submittedAt)))
      const link = `/m/quizzes/take?quizId=${quiz.id}`
      if (open) return { ...open, notice: 'Carrying on with the attempt already started.', link }
      const order = quiz.shuffle
        ? shuffled((await tx.select({ id: items.id }).from(items).where(eq(items.quizId, quiz.id))).map((i) => i.id))
        : []
      const [row] = await tx
        .insert(attempts)
        .values({
          institutionId: tenant,
          quizId: quiz.id,
          studentId: actor.id,
          // The database numbers it, times it and totals it; these are overwritten.
          number: 0,
          deadline: new Date(),
          maxScore: '0',
          itemOrder: order,
        })
        .returning()
      return {
        ...row!,
        notice: `Attempt ${row!.number} started. Time is up at ${wallClock(row!.deadline, quiz.timeZone)}.`,
        link,
      }
    }),
  )
}

async function myAttempt(tx: Tx, actor: Actor, attemptId: string) {
  const [a] = await tx.select().from(attempts).where(eq(attempts.id, attemptId)).for('update')
  if (!a || a.studentId !== actor.id) throw new QuizError(404, 'no_such_attempt', 'no such attempt')
  return a
}

/**
 * Save answers, as often as the student likes until time is up, and submit
 * when they say they have finished. A form sends `q_<itemId>` fields; an app
 * sends `answers`. Unknown items are refused by the database.
 */
export async function saveAnswers(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const d = saveAnswersSchema.parse(input)
  const given: Record<string, Answer> = { ...(d.answers as Record<string, Answer>) }
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith('q_')) given[k.slice(2)] = v as Answer
  }
  return named(() =>
    withTenant(tenant, async (tx) => {
      const a = await myAttempt(tx, actor, d.attemptId)
      if (a.submittedAt) throw new QuizError(409, 'quiz_response_locked', 'that attempt is submitted; its answers are final')
      const ids = Object.keys(given)
      if (ids.some((id) => !a.itemOrder.includes(id))) {
        throw new QuizError(400, 'quiz_response_item', 'that question is not on this quiz')
      }
      for (const id of ids) {
        const v = given[id]
        const value = isBlank(v) ? null : v
        await tx
          .insert(responses)
          .values({ institutionId: tenant, attemptId: a.id, itemId: id, answer: value })
          .onConflictDoUpdate({ target: [responses.attemptId, responses.itemId], set: { answer: value } })
      }
      if (!d.finish) {
        return { saved: ids.length, notice: `Saved ${ids.length} answer${ids.length === 1 ? '' : 's'}. Not submitted yet.` }
      }
      const done = await finalise(tx, a.id, false)
      return {
        saved: ids.length,
        score: num(done?.score ?? null),
        max: num(done?.maxScore ?? null),
        notice: `Submitted. You scored ${num(done?.score ?? null)} of ${num(done?.maxScore ?? null)}.`,
        link: `/m/quizzes/result?attemptId=${a.id}`,
      }
    }),
  )
}

export async function submitAttempt(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const d = attemptRefSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const a = await myAttempt(tx, actor, d.attemptId)
    if (a.submittedAt) throw new QuizError(409, 'already_submitted', 'already submitted')
    const done = await finalise(tx, a.id, false)
    return {
      score: num(done?.score ?? null),
      max: num(done?.maxScore ?? null),
      notice: `Submitted. You scored ${num(done?.score ?? null)} of ${num(done?.maxScore ?? null)}.`,
      link: `/m/quizzes/result?attemptId=${a.id}`,
    }
  })
}

/**
 * One attempt. For the student sitting it: the questions -- never the key --
 * with what they have saved and the time left. Once submitted: the score, and
 * the answers and explanations only as far as the quiz reveals them. A teacher
 * of the class sees all of it.
 */
export async function attemptView(actor: Actor, attemptId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const [pre] = await tx.select().from(attempts).where(eq(attempts.id, attemptId))
    if (!pre) throw new QuizError(404, 'no_such_attempt', 'no such attempt')
    const staff = isStaff(actor.role)
    if (staff) await quizIn(tx, actor, pre.quizId)
    else if (pre.studentId !== actor.id) throw new QuizError(404, 'no_such_attempt', 'no such attempt')
    if (!pre.submittedAt && pre.deadline.getTime() + GRACE_SECONDS * 1000 < Date.now()) await finalise(tx, pre.id, true)
    const [a] = await tx.select().from(attempts).where(eq(attempts.id, attemptId))
    const [quiz] = await tx.select().from(quizzes).where(eq(quizzes.id, a!.quizId))
    const [student] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, a!.studentId))
    const rows = await tx
      .select({ item: items, q: questions })
      .from(items)
      .innerJoin(questions, eq(questions.id, items.questionId))
      .where(eq(items.quizId, a!.quizId))
    const saved = await tx.select().from(responses).where(eq(responses.attemptId, a!.id))
    const byId = new Map(rows.map((r) => [r.item.id, r]))
    const ordered = a!.itemOrder.map((id) => byId.get(id)).filter(Boolean) as typeof rows

    const submitted = !!a!.submittedAt
    const reveal =
      staff ||
      (submitted &&
        (quiz!.reveal === 'after_submit' || (quiz!.reveal === 'after_close' && Date.now() >= quiz!.closesAt.getTime())))

    const questionsOut = ordered.map(({ item, q }, i) => {
      const r = saved.find((x) => x.itemId === item.id)
      const base = {
        itemId: item.id,
        n: i + 1,
        kind: q.kind,
        prompt: q.prompt,
        points: Number(item.points),
        choices: choicesForTaker(q.choices),
        answer: (r?.answer ?? null) as Answer,
      }
      if (!submitted || !reveal) return base
      return {
        ...base,
        responseId: r?.id ?? null,
        yourAnswer: describeAnswer(keyOf(q), r?.answer as Answer),
        key: describeKey(keyOf(q)),
        correct: r?.correct ?? null,
        awarded: num(r?.awarded ?? null) ?? 0,
        explanation: q.explanation,
        overridden: r?.overrideReason ?? null,
      }
    })

    return {
      attempt: {
        id: a!.id,
        number: a!.number,
        studentId: a!.studentId,
        student: student?.name ?? student?.email ?? '',
        startedAt: a!.startedAt,
        started: wallClock(a!.startedAt, quiz!.timeZone),
        deadline: wallClock(a!.deadline, quiz!.timeZone),
        deadlineAt: a!.deadline.toISOString(),
        submitted: submitted ? wallClock(a!.submittedAt, quiz!.timeZone) : '',
        autoSubmitted: a!.autoSubmitted,
        score: num(a!.score),
        max: num(a!.maxScore),
        percent: pct(num(a!.score), num(a!.maxScore)),
      },
      quiz: {
        id: quiz!.id,
        title: quiz!.title,
        instructions: quiz!.instructions,
        reveal: quiz!.reveal,
        closes: wallClock(quiz!.closesAt, quiz!.timeZone),
        penaltyPercent: Number(quiz!.penaltyPercent),
      },
      revealed: submitted && reveal,
      questions: questionsOut,
    }
  })
}

/** For the take page: the student's quiz, and the attempt open on it, if any. */
export async function takeView(actor: Actor, quizId: string) {
  const list = await myQuizzes(actor)
  const entry = list.find((q) => q.id === quizId) ?? null
  if (!entry) return { entry: null, attempt: null }
  const attempt = entry.openAttemptId ? await attemptView(actor, entry.openAttemptId) : null
  const tenant = tenantOf(actor)
  const [quiz] = await withTenant(tenant, (tx) =>
    tx
      .select({ instructions: quizzes.instructions, penaltyPercent: quizzes.penaltyPercent, reveal: quizzes.reveal })
      .from(quizzes)
      .where(eq(quizzes.id, quizId)),
  )
  return { entry, attempt, instructions: quiz?.instructions ?? null, penaltyPercent: Number(quiz?.penaltyPercent ?? 0), reveal: quiz?.reveal }
}

export type QuizViewData = Awaited<ReturnType<typeof quizView>>
export type AttemptViewData = Awaited<ReturnType<typeof attemptView>>
