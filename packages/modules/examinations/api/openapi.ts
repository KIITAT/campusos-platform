import * as z from 'zod'
import { manifest } from '../manifest'
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
}
