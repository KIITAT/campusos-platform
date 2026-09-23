import * as z from 'zod'
import { manifest } from '../manifest'
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

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const ok = {
  '200': { description: 'OK' },
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
  '409': { description: 'Refused', content: json(err) },
}
const post = (summary: string, schema: z.ZodType, description?: string) => ({
  post: {
    summary,
    ...(description ? { description } : {}),
    tags: ['quizzes'],
    requestBody: { content: json(schema) },
    responses: ok,
  },
})
const get = (summary: string, query: string[] = [], description?: string) => ({
  get: {
    summary,
    ...(description ? { description } : {}),
    tags: ['quizzes'],
    parameters: query.map((name) => ({ name, in: 'query', required: true, schema: { type: 'string' } })),
    responses: ok,
  },
})

export const paths = {
  [`${base}/courses`]: get('Courses whose bank this teacher may write in'),
  [`${base}/questions`]: {
    ...get("A course's question bank, with each key", ['courseId']),
    ...post(
      'Add a question to a course bank',
      createQuestionSchema,
      'Single choice, multiple choice, true or false, short answer, or a number within a tolerance. The key is checked as it is written: a question the machine cannot score is refused.',
    ),
  },
  [`${base}/questions/revise`]: post(
    'Correct a question',
    reviseQuestionSchema,
    'Questions are never edited. A revision is a new question naming the one it replaces, which is retired; quizzes already taken keep the question they were scored against.',
  ),
  [`${base}/questions/retire`]: post('Retire a question from the bank', questionRefSchema),
  [`${base}/question`]: get('One question: its key, its revisions, and the quizzes that used it', ['questionId']),

  [`${base}/quizzes`]: {
    ...get('Quizzes on the classes this teacher sees'),
    ...post('Set a draft quiz for a class', createQuizSchema, 'Times may carry an offset, or be wall-clock times read in the quiz time zone.'),
  },
  [`${base}/quizzes/update`]: post('Change a draft quiz', updateQuizSchema, 'A published quiz is frozen; withdraw it and revise.'),
  [`${base}/quiz`]: get('A quiz: its questions, results, item analysis and extensions', ['quizId']),
  [`${base}/quizzes/items`]: post('Put bank questions on a draft quiz', addItemsSchema),
  [`${base}/quizzes/items/remove`]: post('Take questions off a draft quiz', removeItemsSchema),
  [`${base}/quizzes/publish`]: post('Publish a quiz', quizRefSchema, 'Refused with no questions, or once its close has passed.'),
  [`${base}/quizzes/withdraw`]: post('Withdraw a published quiz, with a reason', withdrawQuizSchema, 'Attempts already made stay on record; no more are taken.'),
  [`${base}/quizzes/revise`]: post('Revise a withdrawn quiz into a new draft', quizRefSchema),
  [`${base}/quizzes/extensions`]: post(
    'More time for one student',
    extensionSchema,
    'A later close, extra minutes on the time limit, or both; with a reason, audited.',
  ),

  [`${base}/me`]: get("A student's quizzes: open, in progress, done, and what each scored"),
  [`${base}/attempts/start`]: post(
    'Start an attempt, or carry on with the one open',
    quizRefSchema,
    'The database decides whether it may start and sets its number and deadline: the earlier of the time limit and the close.',
  ),
  [`${base}/attempts/answers`]: post(
    'Save answers, and submit when finished',
    saveAnswersSchema,
    'Answers are keyed by item id. Taken until the deadline, with thirty seconds of grace; frozen once submitted.',
  ),
  [`${base}/attempts/submit`]: post('Submit an attempt to be scored', attemptRefSchema),
  [`${base}/attempt`]: get(
    'One attempt',
    ['attemptId'],
    'To the student sitting it: questions without the key. Once submitted: the score, and answers only as far as the quiz reveals them.',
  ),
  [`${base}/responses/override`]: post(
    "Change the machine's mark on one answer, with a reason",
    overrideSchema,
    'The answer itself never changes. Audited; the attempt total follows.',
  ),
}
