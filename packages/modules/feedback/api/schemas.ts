import * as z from 'zod'

const uuid = z.uuid()
const reason = z.string().trim().min(5).max(500)
const bool = z.preprocess((v) => (v === 'true' || v === 'on' ? true : v === 'false' ? false : v), z.boolean())

/** A form posts one id, or ticked rows as a list; the API takes a list. */
const idList = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
  z.array(uuid).min(1),
)

const lines = (max: number, each = 300) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.string().trim().min(1).max(each)).max(max),
  )

/** An ISO instant with its offset, or a wall-clock time read in the window's zone. */
const moment = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/, 'a date and time')

export const createFormSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    audience: z.enum(['teaching', 'general']),
    description: z.string().trim().max(2000).optional(),
    scalePoints: z.coerce.number().int().min(3).max(10).default(5),
    scaleLow: z.string().trim().min(1).max(40).default('Strongly disagree'),
    scaleHigh: z.string().trim().min(1).max(40).default('Strongly agree'),
  })
  .meta({ id: 'FeedbackFormCreate' })

export const formRefSchema = z.object({ formId: uuid }).meta({ id: 'FeedbackFormRef' })

export const retireFormSchema = z.object({ formId: uuid, reason }).meta({ id: 'FeedbackFormRetire' })

export const addQuestionSchema = z
  .object({
    formId: uuid,
    kind: z.enum(['scale', 'choice', 'text']),
    prompt: z.string().trim().min(3).max(500),
    /** A heading the question sits under. */
    section: z.string().trim().max(80).optional(),
    /** For a choice question: one option per line. */
    options: lines(12, 120).optional(),
    required: bool.default(true),
  })
  .meta({ id: 'FeedbackQuestionAdd' })

/** Several statements on the scale at once, one per line -- how a rubric is typed. */
export const addScaleQuestionsSchema = z
  .object({
    formId: uuid,
    section: z.string().trim().max(80).optional(),
    prompts: lines(40, 500).pipe(z.array(z.string()).min(1)),
  })
  .meta({ id: 'FeedbackScaleQuestionsAdd' })

export const removeQuestionsSchema = z
  .object({ formId: uuid, questionIds: idList })
  .meta({ id: 'FeedbackQuestionsRemove' })

export const createWindowSchema = z
  .object({
    formId: uuid,
    termId: uuid,
    title: z.string().trim().min(3).max(160),
    opensAt: moment,
    closesAt: moment,
    timeZone: z.string().trim().min(1).max(64).default('Asia/Kolkata'),
    required: bool.default(true),
    minResponses: z.coerce.number().int().min(1).max(50).default(5),
  })
  .meta({ id: 'FeedbackWindowCreate' })

export const windowRefSchema = z.object({ windowId: uuid }).meta({ id: 'FeedbackWindowRef' })

export const withdrawWindowSchema = z.object({ windowId: uuid, reason }).meta({ id: 'FeedbackWindowWithdraw' })

const answer = z.union([z.string().max(2000), z.number(), z.null()])

/**
 * Answers keyed by question id. A form sends each as its own field,
 * `q_<questionId>`, and those are gathered in with the rest.
 */
export const giveSchema = z
  .looseObject({
    windowId: uuid,
    /** The class, for a teaching window; absent for a general one. */
    offeringId: z.preprocess((v) => (v === '' ? undefined : v), uuid.optional()),
    answers: z.record(z.string(), answer).default({}),
  })
  .meta({ id: 'FeedbackGive' })
