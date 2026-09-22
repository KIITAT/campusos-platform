import * as z from 'zod'
import { manifest } from '../manifest'
import {
  addEquivalenceSchema,
  addPrerequisiteSchema,
  addSectionMemberSchema,
  createCourseSchema,
  createDepartmentSchema,
  createOfferingSchema,
  createProgramSchema,
  createRoomSchema,
  createSectionSchema,
  correctCompletionSchema,
  createCurriculumSchema,
  createRequirementSchema,
  createSlotSchema,
  createTermSchema,
  declareProgramSchema,
  degreeAuditQuerySchema,
  degreeAuditSchema,
  eligibilityResultSchema,
  eligibilitySchema,
  endStudentProgramSchema,
  recordCompletionSchema,
  setCurrentTermSchema,
  setTermCalendarSchema,
  timetableSchema,
  waivePrerequisiteSchema,
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

const list = (summary: string) => ({
  get: {
    summary,
    tags: ['academic'],
    responses: {
      '200': { description: 'OK' },
      '403': {
        description: 'Forbidden, or the module is not enabled',
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

  [`${base}/terms/calendar`]: post(
    "Set a term's registration and drop dates",
    setTermCalendarSchema,
  ),
  [`${base}/curricula`]: {
    ...post('Create a curriculum for a catalogue year', createCurriculumSchema),
    ...list('Every curriculum, with its requirements'),
  },
  [`${base}/requirements`]: post(
    'Add a degree requirement and the courses that satisfy it',
    createRequirementSchema,
  ),
  [`${base}/prerequisites`]: {
    ...post('Require one course before another', addPrerequisiteSchema),
    ...list('Every prerequisite edge'),
  },
  [`${base}/prerequisites/waivers`]: {
    ...post('Excuse a named student from a prerequisite', waivePrerequisiteSchema),
    ...list('Waivers on file, newest first'),
  },
  [`${base}/equivalences`]: post(
    'Record two courses as the same course, cross-listed or accepted in transfer',
    addEquivalenceSchema,
  ),
  [`${base}/students/programs`]: {
    ...post('Declare a programme for a student', declareProgramSchema),
    ...list("A student's declared programmes; the caller's own without a studentId"),
  },
  [`${base}/students/programs/end`]: post(
    'Complete, withdraw from or transfer out of a programme',
    endStudentProgramSchema,
  ),
  [`${base}/completions`]: {
    ...post('Record a passed course, earned here or accepted in transfer', recordCompletionSchema),
    ...list("A student's completed courses"),
  },
  [`${base}/completions/correct`]: post(
    'Correct a completed course, with a reason that goes on the record',
    correctCompletionSchema,
  ),
  [`${base}/degree-audit`]: {
    post: {
      summary: "What a student's degree still needs, and what the average is",
      tags: ['academic'],
      requestBody: { content: { 'application/json': { schema: degreeAuditQuerySchema } } },
      responses: {
        '200': {
          description: 'OK',
          content: { 'application/json': { schema: degreeAuditSchema } },
        },
        '403': {
          description: 'Forbidden, or the module is not enabled',
          content: { 'application/json': { schema: errorRef } },
        },
        '404': {
          description: 'No such student, or no programme declared',
          content: { 'application/json': { schema: errorRef } },
        },
      },
    },
  },
  [`${base}/eligibility`]: {
    post: {
      summary: 'Whether a student may take a course, and what is missing if not',
      tags: ['academic'],
      requestBody: { content: { 'application/json': { schema: eligibilitySchema } } },
      responses: {
        '200': {
          description: 'OK',
          content: { 'application/json': { schema: eligibilityResultSchema } },
        },
        '403': {
          description: 'Forbidden, or the module is not enabled',
          content: { 'application/json': { schema: errorRef } },
        },
        '404': {
          description: 'No such course',
          content: { 'application/json': { schema: errorRef } },
        },
      },
    },
  },
}
