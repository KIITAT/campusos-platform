import * as z from 'zod'
import { manifest } from '../manifest'
import {
  bookBacklogSchema,
  cancelBacklogSchema,
  cancelEnrolmentSchema,
  enrolSchema,
  setEligibilityWaiverSchema,
  setSettingsSchema,
  setWindowSchema,
  uploadPaperSchema,
} from './cycle-schemas'
import {
  decideMarkReviewSchema,
  markReviewPageSchema,
  markReviewResultSchema,
  requestMarkReviewSchema,
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
import { schoolTemplateSchema } from './school-policy'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const identity = { termId: z.uuid(), sectionId: z.uuid(), studentId: z.string() }
const reportCardTemplateBody = z
  .object({ termId: z.uuid(), programId: z.uuid(), expectedRevision: z.number().int().min(0), template: z.union([schoolTemplateSchema, z.string()]) })
  .meta({ id: 'ExamReportCardTemplate' })
const reportCardEntryBody = z.object({ ...identity, area: z.string(), value: z.string() }).meta({ id: 'ExamReportCardEntry' })
const reportCardPublicationBody = z
  .object({ ...identity, published: z.boolean(), reason: z.string().min(10).max(240) })
  .meta({ id: 'ExamReportCardPublication' })
const reportCardErrors = {
  '400': { description: 'invalid_report_card_template or unknown_report_card_value', content: json(err) },
  '404': { description: 'no_such_school_pupil', content: json(err) },
  '409': {
    description: 'report_card_stale, report_card_template_locked, report_card_published, report_card_incomplete, report_card_unpublished or no_report_card_template',
    content: json(err),
  },
}
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
      summary: 'Propose a different score or an absence for a published mark',
      description:
        'A proposal, not a change: the mark moves only when a different administrator approves it ' +
        '(POST /marks/decide). A database trigger refuses any other write to a published mark, ' +
        'so this cannot be bypassed by a future code path or by a direct SQL session. Naming ' +
        'requestId answers a student’s open review; otherwise a correction is started.',
      tags: ['examinations'],
      requestBody: { content: json(reviseMarkSchema) },
      responses: {
        '200': { description: 'Proposed', content: json(markReviewResultSchema) },
        '400': { description: 'Invalid proposal, or above the exam’s maximum', content: json(err) },
        ...gated,
        '404': { description: 'No such mark', content: json(err) },
        '409': {
          description: 'A review is already open, the proposal is stale or unchanged, or results are not published',
          content: json(err),
        },
      },
    },
  },
  [`${base}/marks/recheck`]: {
    post: {
      summary: 'A student asks for a recheck or re-evaluation of their own published mark',
      description: 'No charge and no files. One open request per mark.',
      tags: ['examinations'],
      requestBody: { content: json(requestMarkReviewSchema) },
      responses: {
        '200': { description: 'Requested', content: json(markReviewResultSchema) },
        '400': { description: 'Invalid request', content: json(err) },
        ...gated,
        '404': { description: 'No such mark', content: json(err) },
        '409': { description: 'A review is already open for this mark', content: json(err) },
      },
    },
  },
  [`${base}/marks/decide`]: {
    post: {
      summary: 'Approve a proposed revision, or close a review. Administrator only, never the proposer.',
      description:
        'Approval writes the audit row, the decision and the new mark in one transaction; the ' +
        'course must then be finalised again before official output.',
      tags: ['examinations'],
      requestBody: { content: json(decideMarkReviewSchema) },
      responses: {
        '200': { description: 'Decided', content: json(markReviewResultSchema) },
        '400': { description: 'Invalid decision', content: json(err) },
        '403': { description: 'Forbidden, or the proposer tried to decide', content: json(err) },
        '404': { description: 'No such mark request', content: json(err) },
        '409': { description: 'The review is closed or no longer matches the mark', content: json(err) },
      },
    },
  },
  [`${base}/marks/requests`]: {
    get: {
      summary: 'Reviews of marks, newest first, 50 at a time',
      description:
        'A student sees their own reviews without the staff detail; staff pass examId for an exam ' +
        'they may mark. Pass the previous page’s next as after.',
      tags: ['examinations'],
      responses: {
        '200': { description: 'A page', content: json(markReviewPageSchema) },
        '400': { description: 'Staff must choose an exam', content: json(err) },
        ...gated,
        '404': { description: 'No such exam', content: json(err) },
      },
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
    [`${base}/enrol`]: post(
      'Enrol for the term’s examinations, confirming one’s details',
      enrolSchema,
      'Refused with 409 exam_attendance_short, exam_attendance_unavailable or exam_dues_outstanding while the term’s attendance or posted fees block it and no waiver stands.',
    ),
    [`${base}/enrolments`]: get('Who is enrolled for a term, and who has classes but is not', ['termId']),
    [`${base}/enrolments/cancel`]: post('Cancel an enrolment, with a reason', cancelEnrolmentSchema),
    [`${base}/admit-card.pdf`]: pdf(
      'The admit card for an enrolment',
      ['termId', 'studentId?'],
      'Checked on every request: refused with 409 exam_attendance_short, exam_attendance_unavailable or exam_dues_outstanding while the term’s attendance or posted fees block it and no waiver stands.',
    ),
    [`${base}/eligibility/waiver`]: {
      post: {
        summary: 'Grant or revoke a per-term eligibility waiver (attendance or posted fees), with an audited reason',
        description: 'Administrators only. A repeat changes nothing and writes no audit event. The reason is an administrative one; leave out medical and payment details.',
        tags: ['examinations'],
        requestBody: { content: json(setEligibilityWaiverSchema) },
        responses: {
          '200': {
            description: 'OK',
            content: json(z.object({ termId: z.string(), studentId: z.string(), check: z.enum(['attendance', 'dues']), waived: z.boolean(), changed: z.boolean(), notice: z.string() })),
          },
          ...gated,
          '404': { description: 'No such examination candidate', content: json(err) },
        },
      },
    },
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
    [`${base}/report-card/template`]: {
      post: {
        summary: 'Save a class’s school report template for a term (administrators)',
        description: 'Compare-and-swap on expectedRevision (0 when no template has been saved). Refused once any pupil entry exists for the class and term. A repeat of the stored template changes nothing.',
        tags: ['examinations'],
        requestBody: { content: json(reportCardTemplateBody) },
        responses: { '200': { description: 'OK', content: json(z.object({ revision: z.number(), notice: z.string() })) }, ...gated, ...reportCardErrors },
      },
    },
    [`${base}/report-card/entry`]: {
      post: {
        summary: 'Set one area’s grade, or the remark, on a pupil’s school report (the class teacher or an administrator)',
        description: 'value is a key from the template; __clear removes it. area remark sets the class teacher’s remark.',
        tags: ['examinations'],
        requestBody: { content: json(reportCardEntryBody) },
        responses: { '200': { description: 'OK', content: json(z.object({ changed: z.boolean(), notice: z.string() })) }, ...gated, ...reportCardErrors },
      },
    },
    [`${base}/report-card/publication`]: {
      post: {
        summary: 'Publish or withdraw a pupil’s school report, with a reason (the class teacher or an administrator)',
        description: 'Publishing needs every subject’s result, or every scholastic area’s rating, to be complete.',
        tags: ['examinations'],
        requestBody: { content: json(reportCardPublicationBody) },
        responses: { '200': { description: 'OK', content: json(z.object({ changed: z.boolean(), notice: z.string() })) }, ...gated, ...reportCardErrors },
      },
    },
    [`${base}/report-card.pdf`]: {
      get: {
        summary: 'A published school term report as a PDF, read live from the published marks',
        description: 'The pupil, a verified guardian (who names studentId) and staff related to the pupil. The pupil’s name, class, section, term and roll number only.',
        tags: ['examinations'],
        parameters: ['termId', 'sectionId', 'studentId?'].map((name) => ({ name: name.replace('?', ''), in: 'query', required: !name.endsWith('?'), schema: { type: 'string' } })),
        responses: { '200': { description: 'OK', content: { 'application/pdf': {} } }, ...gated, ...reportCardErrors },
      },
    },
    [`${base}/papers`]: {
      ...get('The sealed question papers for an exam, without their contents', ['examId']),
      ...post('Upload a question paper (PDF), sealed until shortly before the exam', uploadPaperSchema),
    },
    [`${base}/paper.pdf`]: pdf('A question paper, for the examination cell, from its release time', ['paperId']),
    [`${base}/stats`]: get('How an exam went: spread, middle, pass rate', ['examId']),
    [`${base}/performance`]: get('One student across every published exam, beside their class', ['studentId?']),
  }
}
