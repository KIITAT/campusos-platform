import * as z from 'zod'
import { manifest } from '../manifest'
import {
  addQuestionSchema,
  addScaleQuestionsSchema,
  createFormSchema,
  createWindowSchema,
  formRefSchema,
  giveSchema,
  removeQuestionsSchema,
  retireFormSchema,
  windowRefSchema,
  withdrawWindowSchema,
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
    tags: ['feedback'],
    requestBody: { content: json(schema) },
    responses: ok,
  },
})
const get = (summary: string, query: string[] = [], description?: string) => ({
  get: {
    summary,
    ...(description ? { description } : {}),
    tags: ['feedback'],
    parameters: query.map((name) => ({ name, in: 'query', required: true, schema: { type: 'string' } })),
    responses: ok,
  },
})

export const paths = {
  [`${base}/forms`]: {
    ...get('Questionnaires, with their questions and windows counted'),
    ...post('Start a questionnaire', createFormSchema, 'Teaching questionnaires are answered once per class; general ones once per student.'),
  },
  [`${base}/form`]: get('A questionnaire, its questions and the windows that used it', ['formId']),
  [`${base}/forms/publish`]: post('Publish a questionnaire', formRefSchema, 'Its questions are fixed from here on.'),
  [`${base}/forms/retire`]: post('Retire a questionnaire', retireFormSchema),
  [`${base}/questions`]: post('Add a question: a point on the scale, a choice, or a comment', addQuestionSchema),
  [`${base}/questions/scale`]: post('Add several scale statements at once, one per line', addScaleQuestionsSchema),
  [`${base}/questions/remove`]: post('Remove questions from a draft questionnaire', removeQuestionsSchema),
  [`${base}/windows`]: {
    ...get('Feedback windows, with how many have given and how many owe'),
    ...post('Open a questionnaire to a term, between two moments', createWindowSchema),
  },
  [`${base}/window`]: get(
    'A window: progress per class, who still owes, and -- once closed -- the results',
    ['windowId'],
    'Results for a class are withheld below the window\'s minimum number of responses.',
  ),
  [`${base}/windows/publish`]: post('Publish a window', windowRefSchema),
  [`${base}/windows/withdraw`]: post('Withdraw a window', withdrawWindowSchema, 'Nobody owes it any more; what was said is kept.'),
  [`${base}/class`]: get("One class's results in a closed window", ['windowId', 'offeringId'], 'For the institution, or the class\'s own teacher.'),
  [`${base}/results`]: get("The signed-in teacher's classes and how they were seen"),
  [`${base}/me`]: get('What the signed-in student owes, has given, and missed'),
  [`${base}/give`]: {
    ...get('The questionnaire for one class, or for the term', ['windowId']),
    ...post('Give feedback', giveSchema, 'Recorded in two parts: that you gave it, with your name; what you said, without it.'),
  },
  [`${base}/completion`]: get(
    'Whether a student has finished the required feedback for a term',
    ['studentId', 'termId'],
    'What other modules ask before, say, a grade report.',
  ),
}
