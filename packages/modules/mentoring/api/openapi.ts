import * as z from 'zod'
import { manifest } from '../manifest'
import {
  applyLeaveSchema,
  assignSchema,
  cancelLeaveSchema,
  decideLeaveSchema,
  endAssignmentSchema,
  leaveTypeSchema,
  messageSchema,
  noteSchema,
  retireLeaveTypeSchema,
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
  post: { summary, ...(description ? { description } : {}), tags: ['mentoring'], requestBody: { content: json(schema) }, responses: ok },
})
const get = (summary: string, query: string[] = [], description?: string) => ({
  get: {
    summary,
    ...(description ? { description } : {}),
    tags: ['mentoring'],
    parameters: query.map((name) => ({ name, in: 'query', required: true, schema: { type: 'string' } })),
    responses: ok,
  },
})

export const paths = {
  [`${base}/assignments`]: get('Every student, with their mentor and co-mentor now'),
  [`${base}/assign`]: post(
    'Give students a mentor and co-mentor: one, several, or a whole section',
    assignSchema,
    'A student who had one has it ended today; the history is kept.',
  ),
  [`${base}/assignments/end`]: post('End mentoring for students, with a reason', endAssignmentSchema),
  [`${base}/mentees`]: get("The signed-in teacher's mentees, with low attendance, waiting leave and unread messages"),
  [`${base}/mentee`]: get(
    'The whole of a mentee: profile, attendance by class, results, fees, housing, leave, notes and the conversation',
    ['studentId'],
    'For their mentor, co-mentor, or the office; each part only where its module is on.',
  ),
  [`${base}/notes`]: post('Write a note about a mentee, private or shared with them', noteSchema),
  [`${base}/messages`]: post('Write in a student’s thread with their mentors', messageSchema),
  [`${base}/leave-types`]: {
    ...get('The kinds of leave a student may ask for'),
    ...post('Add a kind of leave', leaveTypeSchema),
  },
  [`${base}/leave-types/retire`]: post('Stop offering a kind of leave', retireLeaveTypeSchema),
  [`${base}/leave`]: post('Ask for leave (the student), with a supporting PDF where the kind needs one', applyLeaveSchema),
  [`${base}/leave/pending`]: get('Leave waiting on the signed-in mentor, or on the office'),
  [`${base}/leave/decide`]: post('Approve or refuse a leave application', decideLeaveSchema, 'Approved leave reaches the hostel roll call, where the hostel is on.'),
  [`${base}/leave/cancel`]: post('Cancel one’s own leave before going', cancelLeaveSchema),
  [`${base}/leave/document.pdf`]: {
    get: {
      ...get('The supporting document of a leave application', ['applicationId']).get,
      responses: { ...ok, '200': { description: 'OK', content: { 'application/pdf': {} } } },
    },
  },
  [`${base}/me`]: get("The signed-in student's mentors, conversation, shared notes and leave"),
}
