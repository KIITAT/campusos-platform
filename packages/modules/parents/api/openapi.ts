import * as z from 'zod'
import { manifest } from '../manifest'
import {
  childOverviewSchema,
  claimLinkSchema,
  decideLinkSchema,
  inviteGuardianSchema,
  linkRowSchema,
  withdrawGuardianSchema,
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
  [`${base}/guardians`]: {
    get: {
      summary: 'Guardian invitations: open, accepted, expired or withdrawn, and for which children',
      tags: ['parents'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
  },
  [`${base}/guardians/invite`]: {
    post: {
      summary: 'Invite a guardian, at their own address, for a child',
      description:
        'Returns a link, once, which the office sends to the guardian. The link is good for ' +
        'accepting for up to 30 days; signing in afterwards still proves the address, by Google ' +
        'or an emailed sign-in link, so a forwarded link admits nobody else. An address already ' +
        'belonging to an account elsewhere, or inside the institution’s own email domain, is ' +
        'refused. Inviting again for a second child replaces the link and carries the first child over.',
      tags: ['parents'],
      requestBody: { content: json(inviteGuardianSchema) },
      responses: {
        '200': { description: 'Invited, or linked straight away for an existing guardian' },
        ...gated,
        '409': { description: 'That address cannot be invited here', content: json(err) },
      },
    },
  },
  [`${base}/guardians/withdraw`]: {
    post: {
      summary: 'Withdraw a guardian invitation, and the access it gave',
      description:
        'After acceptance this removes the links it made, returns the account to pending and ends ' +
        'its sessions: access stops now, not when a cookie expires. Audited with the reason.',
      tags: ['parents'],
      requestBody: { content: json(withdrawGuardianSchema) },
      responses: {
        '204': { description: 'Withdrawn' },
        ...gated,
        '409': { description: 'Already withdrawn', content: json(err) },
      },
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
