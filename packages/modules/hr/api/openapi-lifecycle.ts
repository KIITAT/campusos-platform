import * as z from 'zod'
import { manifest } from '../manifest'
import {
  changeRowSchema,
  completeActivitySchema,
  createGradeSchema,
  createOnboardingTemplateSchema,
  gradeRowSchema,
  onboardingViewSchema,
  recordChangeSchema,
  recordExitInterviewSchema,
  separateSchema,
  separationRowSchema,
  startOnboardingSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const gated = {
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
}
const ok = (schema?: z.ZodType) => ({
  '200': schema ? { description: 'OK', content: json(schema) } : { description: 'OK' },
  ...gated,
})

export const lifecyclePaths = {
  [`${base}/grades`]: {
    get: {
      summary: 'Grades, with how many people are on each',
      tags: ['hr'],
      responses: ok(z.array(gradeRowSchema)),
    },
    post: {
      summary: 'Define a grade',
      description: 'The band is advisory: pay outside it is recorded, not refused.',
      tags: ['hr'],
      requestBody: { content: json(createGradeSchema) },
      responses: { ...ok(), '409': { description: 'Code taken', content: json(err) } },
    },
  },
  [`${base}/onboarding/templates`]: {
    get: { summary: 'Onboarding checklists and their steps', tags: ['hr'], responses: ok() },
    post: {
      summary: 'Define an onboarding checklist',
      description: 'Each step is due a number of days from the joining date; negative is ordinary.',
      tags: ['hr'],
      requestBody: { content: json(createOnboardingTemplateSchema) },
      responses: ok(),
    },
  },
  [`${base}/onboarding`]: {
    get: {
      summary: "One person's onboarding, or null",
      tags: ['hr'],
      parameters: [{ name: 'staffId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: ok(onboardingViewSchema.nullable()),
    },
    post: {
      summary: 'Start an onboarding from a checklist',
      description:
        'The checklist is copied, so editing it later does not rewrite what this person was ' +
        'asked to do. Due dates count from the joining date.',
      tags: ['hr'],
      requestBody: { content: json(startOnboardingSchema) },
      responses: {
        ...ok(),
        '409': { description: 'Already being onboarded', content: json(err) },
      },
    },
  },
  [`${base}/onboarding/open`]: {
    get: { summary: 'Every open onboarding activity, oldest due first', tags: ['hr'], responses: ok() },
  },
  [`${base}/onboarding/complete`]: {
    post: {
      summary: 'Mark an activity done',
      description: 'The onboarding completes itself, by trigger, when its last activity does.',
      tags: ['hr'],
      requestBody: { content: json(completeActivitySchema) },
      responses: ok(),
    },
  },
  [`${base}/changes`]: {
    get: {
      summary: 'Transfers, promotions, confirmations and separations, newest first',
      tags: ['hr'],
      responses: ok(z.array(changeRowSchema)),
    },
    post: {
      summary: 'Record a dated change to somebody’s post',
      description:
        'Applied to the staff record and kept, with a snapshot of what it replaced. Omitted ' +
        'fields do not move. Refused before the joining date or after the leaving date.',
      tags: ['hr'],
      requestBody: { content: json(recordChangeSchema) },
      responses: ok(),
    },
  },
  [`${base}/separations`]: {
    get: { summary: 'Separations, newest first', tags: ['hr'], responses: ok(z.array(separationRowSchema)) },
    post: {
      summary: 'End an employment and record how',
      description:
        'The leaving date, the change and the separation are one act. Audited; the database ' +
        'refuses to let the leaving date move underneath a recorded separation.',
      tags: ['hr'],
      requestBody: { content: json(separateSchema) },
      responses: { ...ok(), '409': { description: 'Already ended', content: json(err) } },
    },
  },
  [`${base}/separations/outstanding`]: {
    get: { summary: 'Separations with no exit interview held', tags: ['hr'], responses: ok() },
  },
  [`${base}/separations/interview`]: {
    post: {
      summary: 'Record the exit interview',
      description: 'Once. rehireEligible may stay null: asked, and not decided.',
      tags: ['hr'],
      requestBody: { content: json(recordExitInterviewSchema) },
      responses: ok(),
    },
  },
  [`${base}/service`]: {
    get: {
      summary: 'Days served, to a date or to the leaving date',
      tags: ['hr'],
      parameters: [
        { name: 'staffId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'on', in: 'query', required: false, schema: { type: 'string' } },
      ],
      responses: ok(),
    },
  },
}
