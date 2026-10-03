import * as z from 'zod'
import { manifest } from '../manifest'
import { instrumentSchema } from './instruments'
import {
  acceptSchema,
  askSchema,
  bookSchema,
  cancelAppointmentSchema,
  closeSchema,
  counsellorActiveSchema,
  counsellorSchema,
  deleteResultSchema,
  handoverSchema,
  noteSchema,
  recordSchema,
  retireInstrumentSchema,
  settingsSchema,
  takeCheckSchema,
  withdrawSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const ok = {
  '200': { description: 'OK' },
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
  '404': { description: 'Not found, or not this reader’s to see', content: json(err) },
  '409': { description: 'Refused', content: json(err) },
}
const post = (summary: string, schema: z.ZodType, description?: string) => ({
  post: { summary, ...(description ? { description } : {}), tags: ['care'], requestBody: { content: json(schema) }, responses: ok },
})
const get = (summary: string, query: string[] = [], description?: string, optional: string[] = []) => ({
  get: {
    summary,
    ...(description ? { description } : {}),
    tags: ['care'],
    parameters: [
      ...query.map((name) => ({ name, in: 'query', required: true, schema: { type: 'string' } })),
      ...optional.map((name) => ({ name, in: 'query', required: false, schema: { type: 'string' } })),
    ],
    responses: ok,
  },
})

export const paths = {
  [`${base}/home`]: get(
    'A student’s own: the checks offered, their results, requests and appointments, the counsellors and the helpline',
  ),
  [`${base}/check`]: get('One check, to take', ['code']),
  [`${base}/checks`]: post(
    'Take a self-check',
    takeCheckSchema,
    'Scored as the check is published. The result is the student’s alone until they share it with a request. A safety question answered above “not at all” is flagged, and the student is shown the helpline.',
  ),
  [`${base}/result`]: get(
    'One result, for the student who took it or a counsellor it was shared with',
    ['id'],
    'Anyone else -- the office included -- is told it does not exist.',
  ),
  [`${base}/results/delete`]: post('Delete one of my results; counsellors it was shared with no longer see it', deleteResultSchema),
  [`${base}/requests`]: post(
    'Ask to see a counsellor, sharing any of my results',
    askSchema,
    'One request open at a time: asking again adds the results to the open one, and raises its urgency if it is now more urgent.',
  ),
  [`${base}/requests/withdraw`]: post('Withdraw my request; anything booked for it is cancelled', withdrawSchema),
  [`${base}/appointments/cancel`]: post('Cancel an appointment, by the student or the counsellor; the other is told', cancelAppointmentSchema),

  [`${base}/queue`]: get('A counsellor’s work: requests waiting, most urgent first; their cases; their appointments'),
  [`${base}/case`]: get(
    'One case, for a counsellor',
    ['id'],
    'Any counsellor while it waits; then only the counsellor holding it. Notes are theirs.',
  ),
  [`${base}/requests/accept`]: post('Take a waiting request', acceptSchema),
  [`${base}/requests/handover`]: post(
    'Hand a case to another counsellor',
    handoverSchema,
    'The reason goes into the case notes for the next counsellor, not into the audit log. Times booked are cancelled and the student told.',
  ),
  [`${base}/requests/close`]: post('Close a case with its outcome', closeSchema),
  [`${base}/appointments`]: post(
    'Offer the student a time',
    bookSchema,
    'A wall-clock time in the institution’s zone. Refused over another appointment of the counsellor’s.',
  ),
  [`${base}/appointments/record`]: post('Record an appointment held or missed, once it has begun', recordSchema),
  [`${base}/notes`]: post('Add a note to a case; kept as written', noteSchema),

  [`${base}/statistics`]: get(
    'Counselling statistics, as counts',
    [],
    'For the office and the counsellors. Counts that describe students -- topics, how checks came out -- show 1 to 4 as “fewer than 5”, and hide the next smallest where one could be worked out from the total.',
    ['period'],
  ),
  [`${base}/settings`]: {
    ...get('The helpline, the counselling centre, the counsellors and the checks'),
    ...post('Set the helpline, the counselling centre and the time zone', settingsSchema),
  },
  [`${base}/counsellors`]: post('Name a member of staff a counsellor', counsellorSchema),
  [`${base}/counsellors/active`]: post('Make a counsellor inactive, or active again', counsellorActiveSchema),
  [`${base}/instruments`]: {
    ...get('The self-checks offered: questions, answers, bands and where each comes from'),
    ...post('Write a check of the institution’s own, with its source', instrumentSchema),
  },
  [`${base}/instruments/retire`]: post('Stop offering one of the institution’s checks', retireInstrumentSchema),
}
