import * as z from 'zod'
import { manifest } from '../manifest'
import {
  bookBacklogSchema,
  cancelBacklogSchema,
  cancelEnrolmentSchema,
  enrolSchema,
  setSettingsSchema,
  setWindowSchema,
  uploadPaperSchema,
} from './cycle-schemas'
import {
  createExamSchema,
  createSchemeSchema,
  enterMarksSchema,
  finaliseCourseSchema,
  setProgramSchemeSchema,
  publishExamSchema,
  reviseMarkSchema,
  transcriptSchema,
  unpublishExamSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const gated = {
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
}

export const paths = {
  [`${base}/exams`]: {
    get: {
      summary: 'Exams scheduled against one offering',
      tags: ['examinations'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Schedule an exam against a course offering',
      tags: ['examinations'],
      requestBody: { content: json(createExamSchema) },
      responses: {
        '200': { description: 'Created' },
        ...gated,
        '409': { description: 'Name taken, or total weight would exceed 100%', content: json(err) },
      },
    },
  },
  [`${base}/marks`]: {
    get: {
      summary: 'The marks sheet for one exam, absent students included',
      description:
        'Usable as a register: every enrolled student appears, marked or not, so the sheet is ' +
        'the same shape before and after entry.',
      tags: ['examinations'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Enter or amend marks for an unpublished exam',
      tags: ['examinations'],
      requestBody: { content: json(enterMarksSchema) },
      responses: {
        '204': { description: 'Recorded' },
        ...gated,
        '409': { description: 'Exam is published — revise instead', content: json(err) },
      },
    },
  },
  [`${base}/marks/revise`]: {
    post: {
      summary: 'Change a published mark. The reason is mandatory and audited.',
      description:
        'The only path that can alter a mark once results are published. A database trigger ' +
        'refuses any other write to a published exam, so this cannot be bypassed by a future ' +
        'code path or by a direct SQL session.',
      tags: ['examinations'],
      requestBody: { content: json(reviseMarkSchema) },
      responses: { '204': { description: 'Revised' }, ...gated },
    },
  },
  [`${base}/exams/publish`]: {
    post: {
      summary: 'Publish results, locking every mark under this exam',
      tags: ['examinations'],
      requestBody: { content: json(publishExamSchema) },
      responses: { '204': { description: 'Published' }, ...gated },
    },
  },
  [`${base}/exams/unpublish`]: {
    post: {
      summary: 'Withdraw published results. Admin only, reason mandatory.',
      tags: ['examinations'],
      requestBody: { content: json(unpublishExamSchema) },
      responses: { '204': { description: 'Withdrawn' }, ...gated },
    },
  },
  [`${base}/scales`]: {
    post: {
      summary: 'Define a grading scheme: percentage, GPA, or a custom scale',
      tags: ['examinations'],
      requestBody: { content: json(createSchemeSchema) },
      responses: { '200': { description: 'Created' }, ...gated },
    },
    get: {
      summary: 'Grading schemes for this institution',
      tags: ['examinations'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
  },
  [`${base}/finalise`]: {
    post: {
      summary:
        'Turn a course’s published marks into the academic record, correcting it where a mark has since been revised',
      tags: ['examinations'],
      requestBody: { content: json(finaliseCourseSchema) },
      responses: {
        '200': { description: 'Posted' },
        ...gated,
        '409': { description: 'Nothing has been published for that course', content: json(err) },
      },
    },
  },
  [`${base}/scales/programs`]: {
    get: {
      summary: 'Programmes that grade on their own scale rather than the default',
      tags: ['examinations'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Point a programme at its own grading scale',
      tags: ['examinations'],
      requestBody: { content: json(setProgramSchemeSchema) },
      responses: { '200': { description: 'Applied' }, ...gated },
    },
  },
  [`${base}/transcript/official`]: {
    get: {
      summary:
        'The transcript as the record has it: finalised courses and transfer credit only, nothing provisional',
      tags: ['examinations'],
      responses: {
        '200': { description: 'OK', content: json(transcriptSchema) },
        ...gated,
      },
    },
  },
  [`${base}/transcript`]: {
    get: {
      summary: 'A student transcript. Students may read only their own.',
      tags: ['examinations'],
      responses: {
        '200': { description: 'OK', content: json(transcriptSchema) },
        ...gated,
      },
    },
  },
  [`${base}/transcript.pdf`]: {
    get: {
      summary: 'The same transcript as a PDF',
      tags: ['examinations'],
      responses: {
        '200': { description: 'OK', content: { 'application/pdf': {} } },
        ...gated,
      },
    },
  },
  ...cycle(),
}

/** The examination cycle: windows, enrolment, admit cards, backlogs, grade reports, sealed papers. */
function cycle() {
  const post = (summary: string, schema: z.ZodType, description?: string) => ({
    post: {
      summary,
      ...(description ? { description } : {}),
      tags: ['examinations'],
      requestBody: { content: json(schema) },
      responses: { '200': { description: 'OK' }, ...gated, '409': { description: 'Refused', content: json(err) } },
    },
  })
  const get = (summary: string, query: string[] = [], description?: string) => ({
    get: {
      summary,
      ...(description ? { description } : {}),
      tags: ['examinations'],
      parameters: query.map((name) => ({ name: name.replace('?', ''), in: 'query', required: !name.endsWith('?'), schema: { type: 'string' } })),
      responses: { '200': { description: 'OK' }, ...gated },
    },
  })
  const pdf = (summary: string, query: string[], description?: string) => ({
    get: {
      ...get(summary, query, description).get,
      responses: { '200': { description: 'OK', content: { 'application/pdf': {} } }, ...gated, '409': { description: 'Refused', content: json(err) } },
    },
  })
  return {
    [`${base}/cycle/settings`]: {
      ...get('How long before an exam its paper opens, and whether a grade report waits for feedback'),
      ...post('Set them', setSettingsSchema),
    },
    [`${base}/windows`]: {
      ...get("Every term's enrolment and backlog windows"),
      ...post('Open or move a term’s enrolment or backlog window', setWindowSchema, 'Outside it the database refuses the enrolment or booking.'),
    },
    [`${base}/booking`]: get(
      "The signed-in student's term: feedback, enrolment, admit card, backlogs and grade reports",
      ['termId?'],
    ),
    [`${base}/enrol`]: post('Enrol for the term’s examinations, confirming one’s details', enrolSchema),
    [`${base}/enrolments`]: get('Who is enrolled for a term, and who has classes but is not', ['termId']),
    [`${base}/enrolments/cancel`]: post('Cancel an enrolment, with a reason', cancelEnrolmentSchema),
    [`${base}/admit-card.pdf`]: pdf('The admit card for an enrolment', ['termId', 'studentId?']),
    [`${base}/backlogs`]: {
      ...get('Backlog papers booked for a term', ['termId']),
      ...post('Book a failed paper to sit again', bookBacklogSchema, 'The fee is the window’s, worked out by the database, and charged through fees where it is on.'),
    },
    [`${base}/backlogs/cancel`]: post('Cancel a backlog booking and its fee', cancelBacklogSchema),
    [`${base}/grade-report.pdf`]: pdf(
      'A term’s grade report from the official record, with SGPA and CGPA',
      ['termId', 'studentId?'],
      'Held for a student whose required feedback is outstanding, where the institution says so.',
    ),
    [`${base}/papers`]: {
      ...get('The sealed question papers for an exam, without their contents', ['examId']),
      ...post('Upload a question paper (PDF), sealed until shortly before the exam', uploadPaperSchema),
    },
    [`${base}/paper.pdf`]: pdf('A question paper, for the examination cell, from its release time', ['paperId']),
    [`${base}/stats`]: get('How an exam went: spread, middle, pass rate', ['examId']),
    [`${base}/performance`]: get('One student across every published exam, beside their class', ['studentId?']),
  }
}
