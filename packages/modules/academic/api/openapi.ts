import * as z from 'zod'
import { manifest } from '../manifest'
import {
  addSectionMemberSchema,
  createCourseSchema,
  createDepartmentSchema,
  createOfferingSchema,
  createProgramSchema,
  createRoomSchema,
  createSectionSchema,
  createSlotSchema,
  createTermSchema,
  setCurrentTermSchema,
  timetableSchema,
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
    tags: ['academic'],
    requestBody: { content: { 'application/json': { schema } } },
    responses: {
      '200': { description: 'Created' },
      '204': { description: 'Applied' },
      '403': {
        description: 'Forbidden, or the module is not enabled',
        content: { 'application/json': { schema: errorRef } },
      },
      '409': {
        description: 'Conflicts with an existing row or a constraint',
        content: { 'application/json': { schema: errorRef } },
      },
    },
  },
})

export const paths = {
  [`${base}/timetable`]: {
    get: {
      summary:
        'The weekly timetable for the current term, scoped to the caller: their cohorts if a student, what they teach if a lecturer, the whole institution for an admin',
      tags: ['academic'],
      responses: {
        '200': {
          description: 'OK. An empty timetable when no term is current.',
          content: { 'application/json': { schema: timetableSchema } },
        },
        '403': {
          description: 'Module not enabled for this institution',
          content: { 'application/json': { schema: errorRef } },
        },
      },
    },
  },
  [`${base}/departments`]: post('Create a department', createDepartmentSchema),
  [`${base}/programs`]: post('Create a programme', createProgramSchema),
  [`${base}/courses`]: post('Create a course', createCourseSchema),
  [`${base}/rooms`]: post('Create a room', createRoomSchema),
  [`${base}/terms`]: post('Create an academic term', createTermSchema),
  [`${base}/terms/current`]: post('Mark a term as current', setCurrentTermSchema),
  [`${base}/sections`]: post('Create a cohort', createSectionSchema),
  [`${base}/sections/members`]: post('Add a student to a cohort', addSectionMemberSchema),
  [`${base}/offerings`]: post('Offer a course to a cohort in a term', createOfferingSchema),
  [`${base}/slots`]: post('Add a weekly timetable slot', createSlotSchema),
}
