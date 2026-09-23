import * as z from 'zod'
import { KINDS } from './scoring'

const uuid = z.uuid()
const reason = z.string().trim().min(5).max(500)
const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())

/** A form posts one id, or ticked rows as a list; the API takes a list. */
const idList = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
  z.array(uuid).min(1),
)

/**
 * A moment: an ISO instant with its offset, or a wall-clock time as a
 * datetime-local input sends it -- `2026-10-05T09:30` -- read in the quiz's
 * time zone.
 */
const moment = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/, 'a date and time')

const lines = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : v),
  z.array(z.string().trim().min(1).max(200)).max(20),
)

const questionFields = {
  kind: z.enum(KINDS as [string, ...string[]]),
  prompt: z.string().trim().min(3).max(4000),
  /** Single or multiple choice: one option per line, the right ones starting with `*`. */
  options: z.string().max(4000).optional(),
  /** True or false: which is right. */
  answer: z.enum(['true', 'false']).optional(),
  /** Short answer: each accepted answer on its own line. */
  accepted: lines.optional(),
  numericAnswer: z.coerce.number().finite().optional(),
  tolerance: z.coerce.number().min(0).default(0),
  partialCredit: bool.default(false),
  points: z.coerce.number().positive().max(100).default(1),
  topic: z.string().trim().max(80).optional(),
  explanation: z.string().trim().max(2000).optional(),
}

export const createQuestionSchema = z
  .object({ courseId: uuid, ...questionFields })
  .meta({ id: 'QuizQuestionCreate' })

export const reviseQuestionSchema = z
  .object({ questionId: uuid, ...questionFields })
  .meta({ id: 'QuizQuestionRevise' })

export const questionRefSchema = z.object({ questionId: uuid }).meta({ id: 'QuizQuestionRef' })

const quizFields = {
  title: z.string().trim().min(3).max(160),
  instructions: z.string().trim().max(4000).optional(),
  opensAt: moment,
  closesAt: moment,
  /** An IANA zone. The times are read in it and shown in it. */
  timeZone: z.string().trim().min(1).max(64).default('Asia/Kolkata'),
  timeLimitMinutes: z.coerce.number().int().min(1).max(600).optional(),
  attemptsAllowed: z.coerce.number().int().min(1).max(10).default(1),
  keep: z.enum(['best', 'latest']).default('best'),
  penaltyPercent: z.coerce.number().min(0).max(100).default(0),
  reveal: z.enum(['after_submit', 'after_close', 'never']).default('after_close'),
  shuffle: bool.default(false),
}

export const createQuizSchema = z.object({ offeringId: uuid, ...quizFields }).meta({ id: 'QuizCreate' })

export const updateQuizSchema = z.object({ quizId: uuid, ...quizFields }).meta({ id: 'QuizUpdate' })

export const quizRefSchema = z.object({ quizId: uuid }).meta({ id: 'QuizRef' })

export const withdrawQuizSchema = z.object({ quizId: uuid, reason }).meta({ id: 'QuizWithdraw' })

export const addItemsSchema = z
  .object({
    quizId: uuid,
    questionIds: idList,
    /** The marks on this quiz; absent means each question's own. */
    points: z.coerce.number().positive().max(100).optional(),
  })
  .meta({ id: 'QuizItemsAdd' })

export const removeItemsSchema = z.object({ quizId: uuid, itemIds: idList }).meta({ id: 'QuizItemsRemove' })

export const extensionSchema = z
  .object({
    quizId: uuid,
    studentId: z.string().min(1),
    closesAt: moment.optional(),
    extraMinutes: z.coerce.number().int().min(0).max(600).default(0),
    reason,
  })
  .meta({ id: 'QuizExtension' })

export const attemptRefSchema = z.object({ attemptId: uuid }).meta({ id: 'QuizAttemptRef' })

const answer = z.union([z.string().max(2000), z.number(), z.array(z.string().max(64)).max(26), z.null()])

/**
 * Answers keyed by item id. A form sends each as its own field, `q_<itemId>`
 * -- a list for boxes ticked -- and those are gathered in with the rest.
 */
export const saveAnswersSchema = z
  .looseObject({
    attemptId: uuid,
    answers: z.record(z.string(), answer).default({}),
    /** Submit after saving: "I have finished". */
    finish: bool.default(false),
  })
  .meta({ id: 'QuizAnswersSave' })

export const overrideSchema = z
  .object({
    responseId: uuid,
    awarded: z.coerce.number().min(-100).max(100),
    reason,
  })
  .meta({ id: 'QuizResponseOverride' })
