import * as z from 'zod'
import { manifest } from '../manifest'
import {
  childOverviewSchema,
  claimLinkSchema,
  decideLinkSchema,
  linkRowSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const gated = {
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
}

export const paths = {
  [`${base}/links`]: {
    get: {
      summary: 'Parent-student links, optionally only those awaiting a decision',
      tags: ['parents'],
      responses: {
        '200': { description: 'OK', content: json(z.array(linkRowSchema)) },
        ...gated,
      },
    },
    post: {
      summary: 'Claim a link to a student',
      description:
        'Never self-service: anybody can assert they are somebody\u2019s father. The link exists ' +
        'immediately and shows nothing until the institution verifies it. A link an ' +
        'administrator registers is verified by that act.',
      tags: ['parents'],
      requestBody: { content: json(claimLinkSchema) },
      responses: {
        '200': { description: 'Claimed' },
        ...gated,
        '409': { description: 'That pair is already linked', content: json(err) },
      },
    },
  },
  [`${base}/links/decide`]: {
    post: {
      summary: 'Verify or refuse a claimed link. Reason mandatory and audited.',
      tags: ['parents'],
      requestBody: { content: json(decideLinkSchema) },
      responses: {
        '200': { description: 'Decided' },
        ...gated,
        '409': { description: 'Already verified', content: json(err) },
      },
    },
  },
  [`${base}/links/revoke`]: {
    post: {
      summary: 'Withdraw a verified link. Reason mandatory and audited.',
      description:
        'A parent losing sight of a child is usually a custody or safeguarding decision, so the ' +
        'reason is part of the record rather than a formality.',
      tags: ['parents'],
      requestBody: { content: json(decideLinkSchema) },
      responses: { '204': { description: 'Revoked' }, ...gated },
    },
  },
  [`${base}/children`]: {
    get: {
      summary: 'This parent\u2019s claims, verified or not',
      tags: ['parents'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
  },
  [`${base}/child`]: {
    get: {
      summary: 'One child, across whichever modules the institution has enabled',
      description:
        'The portal computes nothing. Every figure is read through the module that owns it, so ' +
        'what a parent sees is what the office sees. A section is absent -- not zero -- when its ' +
        'module is off, which is the honest rendering of "this institution does not use that".',
      tags: ['parents'],
      responses: {
        '200': { description: 'OK', content: json(childOverviewSchema) },
        ...gated,
        '404': { description: 'No such student', content: json(err) },
      },
    },
  },
}
