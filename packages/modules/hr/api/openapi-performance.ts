import * as z from 'zod'
import { manifest } from '../manifest'
import {
  createCycleSchema,
  createKraSchema,
  enrolSchema,
  giveAppraisalFeedbackSchema,
  reviewSchema,
  selfReviewSchema,
  setCycleStatusSchema,
  setGoalSchema,
  updateGoalSchema,
} from './schemas'

const base = `${manifest.apiBasePath}/performance`
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const ok = {
  '200': { description: 'OK' },
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
  '409': { description: 'Refused at this step', content: json(err) },
}
const post = (summary: string, schema: z.ZodType, description?: string) => ({
  post: {
    summary,
    ...(description ? { description } : {}),
    tags: ['hr'],
    requestBody: { content: json(schema) },
    responses: ok,
  },
})
const get = (summary: string, query?: string) => ({
  get: {
    summary,
    tags: ['hr'],
    ...(query ? { parameters: [{ name: query, in: 'query', required: true, schema: { type: 'string' } }] } : {}),
    responses: ok,
  },
})

export const performancePaths = {
  [`${base}/cycles`]: {
    ...get('Review cycles, with how many appraisals stand at each step'),
    ...post('Create a review cycle', createCycleSchema),
  },
  [`${base}/cycles/status`]: post(
    'Open or close a cycle',
    setCycleStatusSchema,
    'Draft to open to closed, one way. A closed cycle takes no more ratings; a trigger enforces it.',
  ),
  [`${base}/kras`]: { ...get('Key result areas'), ...post('Define a key result area', createKraSchema) },
  [`${base}/enrol`]: post(
    'Put people into a cycle with a reviewer and weighted KRAs',
    enrolSchema,
    'Weights add up to 100. Nobody reviews themselves. Anybody already enrolled is skipped.',
  ),
  [`${base}/appraisals`]: get('Appraisals in a cycle', 'cycleId'),
  [`${base}/appraisal`]: get(
    'One appraisal: KRAs, both sets of ratings, the score, colleague feedback',
    'appraisalId',
  ),
  [`${base}/mine`]: get('Appraisals where you are appraised or reviewing, and what waits on you'),
  [`${base}/self-review`]: post(
    'Submit your self review',
    selfReviewSchema,
    'Every KRA rated once. Also accepts rating:<kraId> and comment:<kraId> fields from a form.',
  ),
  [`${base}/review`]: post(
    'Submit the review, which completes the appraisal',
    reviewSchema,
    'After the self review, by the assigned reviewer. The weighted score is frozen on completion.',
  ),
  [`${base}/feedback`]: post(
    'Give colleague feedback',
    giveAppraisalFeedbackSchema,
    'Once per colleague, never from the person appraised. Shown to them without names.',
  ),
  [`${base}/goals`]: { ...get('Goals'), ...post('Set a goal', setGoalSchema) },
  [`${base}/goals/update`]: post('Record progress on a goal', updateGoalSchema),
}
