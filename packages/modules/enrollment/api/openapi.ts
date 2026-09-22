import * as z from 'zod'
import { manifest } from '../manifest'
import {
  creditLoadSchema,
  dropSchema,
  registerSchema,
  registrationSchema,
  setOfferingLimitSchema,
} from './schemas'

/**
 * The module contributes its own paths to the single OpenAPI document.
 * api-contracts merges these -- one import line per module, mirroring the
 * registry, rather than a growing hand-written spec.
 */
const base = manifest.apiBasePath

const errorRef = z.object({ error: z.string(), message: z.string() })

const post = (summary: string, schema: z.ZodType) => ({
  post: {
    summary,
    tags: ['enrollment'],
    requestBody: { content: { 'application/json': { schema } } },
    responses: {
      '200': { description: 'Applied' },
      '403': {
        description: 'Forbidden, or the module is not enabled',
        content: { 'application/json': { schema: errorRef } },
      },
      '409': {
        description:
          'The window is closed, the prerequisites are unmet, the class is full, or the deadline has passed',
        content: { 'application/json': { schema: errorRef } },
      },
    },
  },
})

const get = (summary: string, schema?: z.ZodType) => ({
  get: {
    summary,
    tags: ['enrollment'],
    responses: {
      '200': {
        description: 'OK',
        ...(schema ? { content: { 'application/json': { schema } } } : {}),
      },
      '403': {
        description: 'Forbidden, or the module is not enabled',
        content: { 'application/json': { schema: errorRef } },
      },
    },
  },
})

export const paths = {
  [`${base}/register`]: post(
    'Register a student for an offering, or place them on its waiting list',
    registerSchema,
  ),
  [`${base}/drop`]: post(
    'Drop or withdraw from an offering, whichever the term calendar allows',
    dropSchema,
  ),
  [`${base}/seats`]: {
    ...post('Set how many may sit in an offering, and how many may queue', setOfferingLimitSchema),
    ...get('Every capped offering, with seats taken and queued'),
  },
  [`${base}/roster`]: get('Who is on an offering, with waiting-list places in order'),
  [`${base}/registrations`]: get(
    "A student's registrations; the caller's own without a studentId",
    z.array(registrationSchema),
  ),
  [`${base}/credit-load`]: get(
    'Registered credits for a student in a term, which is what aid eligibility reads',
    creditLoadSchema,
  ),
  [`${base}/events`]: get(
    'Every add and drop in a term, with the date each counts from, for fee proration',
  ),
}
