import * as z from 'zod'
import { manifest } from '../manifest'
import {
  addLevelSchema,
  assessSchema,
  createFrameworkSchema,
  createSkillSchema,
  selfAssessSchema,
  retireSkillsSchema,
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
    tags: ['skills'],
    requestBody: { content: json(schema) },
    responses: ok,
  },
})
const get = (summary: string, query: string[] = [], description?: string) => ({
  get: {
    summary,
    ...(description ? { description } : {}),
    tags: ['skills'],
    parameters: query.map((name) => ({ name, in: 'query', required: true, schema: { type: 'string' } })),
    responses: ok,
  },
})

export const paths = {
  [`${base}/frameworks`]: {
    ...get('Skill frameworks, with how many skills and students each has'),
    ...post(
      'Define a framework and its scale',
      createFrameworkSchema,
      'The levels are the institution’s own, lowest first. None are supplied: what "proficient" means is not this module’s to decide.',
    ),
  },
  [`${base}/framework`]: get('A framework: its scale and its skills', ['frameworkId']),
  [`${base}/levels`]: post('Add a level to the top of a scale', addLevelSchema, 'Levels students were judged against are never rewritten.'),
  [`${base}/skills`]: post('Add a skill to a framework', createSkillSchema),
  [`${base}/skills/retire`]: post('Retire skills', retireSkillsSchema, 'Its history stays; no new judgements are taken.'),
  [`${base}/students`]: get('Students, with how often each has been judged'),
  [`${base}/profile`]: get(
    "A student's skills: the latest judgement from each side, the gap, and the history",
    ['studentId'],
    'Separate from grades: nothing here comes from or goes to a mark.',
  ),
  [`${base}/me`]: get('The signed-in student’s own skills profile'),
  [`${base}/assess`]: post(
    "Record a teacher's judgement of a student's skill",
    assessSchema,
    'With the evidence it rests on. Kept as written; a later judgement supersedes it without erasing it.',
  ),
  [`${base}/self-assess`]: post("Record a student's judgement of their own skill", selfAssessSchema, 'Recorded beside the teacher’s, never over it.'),
  [`${base}/coverage`]: get('Per skill: students judged, and the average level each side gives'),
}
