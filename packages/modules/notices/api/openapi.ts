import * as z from 'zod'
import { manifest } from '../manifest'
import {
  attachSchema,
  createNoticeSchema,
  inboxSchema,
  mandatorySchema,
  markReadSchema,
  noticeRowSchema,
  preferenceSchema,
  publishNoticeSchema,
  removeAttachmentSchema,
  withdrawNoticeSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const gated = {
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
}

export const paths = {
  [`${base}/board`]: {
    get: {
      summary: 'The notice board as this reader sees it',
      description:
        'Anybody signed in gets what is published, current and addressed to their role. ' +
        'Whoever may post also sees drafts. ' +
        'Paged: q, sort (when or title), dir, n (at most 500), after (the next value of the previous answer).',
      tags: ['notices'],
      responses: {
        '200': {
          description: 'OK',
          content: json(z.object({ rows: z.array(noticeRowSchema), total: z.number().int(), next: z.string().nullable() })),
        },
        ...gated,
      },
    },
    post: {
      summary: 'Write a notice, published straight away or left as a draft',
      description:
        'Publishing fans out one inbox row per recipient in a single insert-select. A lecturer ' +
        'may address students; wider audiences come from the office.',
      tags: ['notices'],
      requestBody: { content: json(createNoticeSchema) },
      responses: { '200': { description: 'Created' }, ...gated },
    },
  },
  [`${base}/board/publish`]: {
    post: {
      summary: 'Publish a draft and deliver it',
      description: 'Set queued=true to defer publication and inbox delivery to the PostgreSQL worker. A queued response includes jobId and reach=0; live posting authority is checked again at execution.',
      tags: ['notices'],
      requestBody: { content: json(publishNoticeSchema) },
      responses: {
        '200': { description: 'Published' },
        ...gated,
        '409': { description: 'Already published', content: json(err) },
      },
    },
  },
  [`${base}/board/withdraw`]: {
    post: {
      summary: 'Take a notice down. Reason mandatory and audited.',
      description:
        'The inbox copies go with it: an item linking to a withdrawn notice is a dead end the ' +
        'reader cannot resolve.',
      tags: ['notices'],
      requestBody: { content: json(withdrawNoticeSchema) },
      responses: { '204': { description: 'Withdrawn' }, ...gated },
    },
  },
  [`${base}/board/notice`]: {
    get: {
      summary: 'One notice, whole: its text and the documents that go with it',
      tags: ['notices'],
      parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK' }, ...gated, '404': { description: 'No such notice, or not addressed to this reader', content: json(err) } },
    },
  },
  [`${base}/board/attachments`]: {
    post: {
      summary: 'Attach a document to a draft: PDF, PNG or JPEG, five at most',
      description:
        'Checked to be what it says it is. Once the notice is published its documents are fixed, ' +
        'so what everybody was sent is what stays.',
      tags: ['notices'],
      requestBody: { content: json(attachSchema) },
      responses: { '200': { description: 'Attached' }, ...gated, '409': { description: 'Published already, or five attached', content: json(err) } },
    },
  },
  [`${base}/board/attachments/remove`]: {
    post: {
      summary: 'Take a document off a draft',
      tags: ['notices'],
      requestBody: { content: json(removeAttachmentSchema) },
      responses: { '200': { description: 'Taken off' }, ...gated, '409': { description: 'The notice is published', content: json(err) } },
    },
  },
  [`${base}/board/attachment`]: {
    get: {
      summary: 'A document on a notice, for whoever may read the notice',
      tags: ['notices'],
      parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'The document as it was attached', content: { 'application/pdf': {}, 'image/png': {}, 'image/jpeg': {} } },
        ...gated,
        '404': { description: 'No such document, or not this reader’s to see', content: json(err) },
      },
    },
  },

  [`${base}/inbox`]: {
    get: {
      summary: 'This user’s notification centre',
      description:
        'Written by notices and by every other module -- a fee recorded, a book overdue, a leave ' +
        'decision -- so one query answers "what happened to me".',
      tags: ['notices'],
      responses: {
        '200': { description: 'OK', content: json(inboxSchema) },
        ...gated,
      },
    },
    post: {
      summary: 'Mark one notification read, or the whole inbox',
      tags: ['notices'],
      requestBody: { content: json(markReadSchema) },
      responses: { '200': { description: 'Marked' }, ...gated },
    },
  },

  [`${base}/preferences`]: {
    get: {
      summary: 'Your notification categories',
      description: 'Every category with whether you muted it and whether the institution made it mandatory.',
      tags: ['notices'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Mute or unmute a category for yourself',
      description: 'Refused with 409 for a category the institution has made mandatory.',
      tags: ['notices'],
      requestBody: { content: json(preferenceSchema) },
      responses: { '200': { description: 'Saved' }, ...gated, '409': { description: 'The category is mandatory', content: json(err) } },
    },
  },
  [`${base}/preferences/mandatory`]: {
    post: {
      summary: 'Make a category mandatory, or optional again',
      description: 'Administrators only. Audited with the reason.',
      tags: ['notices'],
      requestBody: { content: json(mandatorySchema) },
      responses: { '200': { description: 'Saved' }, ...gated },
    },
  },
}
