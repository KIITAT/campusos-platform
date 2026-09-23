import * as z from 'zod'
import { manifest } from '../manifest'
import {
  assignShiftSchema,
  createShiftTypeSchema,
  decideShiftSchema,
  requestShiftSchema,
  rotateShiftsSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const ok = {
  '200': { description: 'OK' },
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
}
const post = (summary: string, schema: z.ZodType, description?: string) => ({
  post: {
    summary,
    ...(description ? { description } : {}),
    tags: ['hr'],
    requestBody: { content: json(schema) },
    responses: { ...ok, '409': { description: 'Refused', content: json(err) } },
  },
})
const get = (summary: string, query: string[] = []) => ({
  get: {
    summary,
    tags: ['hr'],
    parameters: query.map((name) => ({ name, in: 'query', required: true, schema: { type: 'string' } })),
    responses: ok,
  },
})

export const shiftsPaths = {
  [`${base}/shifts/types`]: {
    ...get('Shift types, with paid hours and whether they cross midnight'),
    ...post(
      'Define a shift type',
      createShiftTypeSchema,
      'The allowance is paid per day actually worked on the shift: rostered, employed, and not on leave.',
    ),
  },
  [`${base}/shifts/assign`]: post(
    'Put somebody on a shift over dates',
    assignShiftSchema,
    'Existing assignments are carved around it: the part before stays, the part after resumes. ' +
      'Refused for a month payroll has already run for.',
  ),
  [`${base}/shifts/rotate`]: post(
    'A weekly rotation across people and shift types',
    rotateShiftsSchema,
    'Person i gets shift (i + week) mod n, written as ordinary assignments.',
  ),
  [`${base}/shifts/roster`]: get('Who is on what, day by day, with approved leave shown through', [
    'from',
    'to',
  ]),
  [`${base}/shifts/coverage`]: get('How many people are on each shift on a day'),
  [`${base}/shifts/requests`]: {
    ...get('Shift requests'),
    ...post('Ask to work a different shift for a while', requestShiftSchema),
  },
  [`${base}/shifts/requests/decide`]: post(
    'Approve or reject a shift request',
    decideShiftSchema,
    'Approval places the shift, carving the roster around it.',
  ),
}
