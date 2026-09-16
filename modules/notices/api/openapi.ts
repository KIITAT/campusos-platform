import * as z from 'zod'
import { manifest } from '../manifest'
import {
  createNoticeSchema,
  inboxSchema,
  markReadSchema,
  noticeRowSchema,
  publishNoticeSchema,
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
        'Whoever may post also sees drafts.',
      tags: ['notices'],
      responses: {
        '200': { description: 'OK', content: json(z.array(noticeRowSchema)) },
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
  [`${base}/board/email`]: {
    post: {
      summary: 'Send an email copy of a published notice',
      description:
        'Separate from publishing on purpose: publishing must not fail because a mail provider ' +
        'is down, and the inbox is the delivery that matters. Without a provider configured this ' +
        'reports that it sent nothing and changes nothing.',
      tags: ['notices'],
      responses: { '200': { description: 'OK' }, ...gated },
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
}
