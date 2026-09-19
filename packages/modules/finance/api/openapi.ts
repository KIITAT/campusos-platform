import * as z from 'zod'
import { manifest } from '../manifest'
import {
  archiveAccountSchema,
  createAccountSchema,
  postEntrySchema,
  reverseEntrySchema,
  trialBalanceRowSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const gated = {
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
}

export const paths = {
  [`${base}/accounts`]: {
    get: {
      summary: 'The chart of accounts',
      description:
        'An institution that has never opened this screen gets the standard chart ' +
        'written for it on first read, so posting works before anyone configures ' +
        'anything.',
      tags: ['finance'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Add an account to the chart',
      tags: ['finance'],
      requestBody: { content: json(createAccountSchema) },
      responses: {
        '200': { description: 'Created' },
        ...gated,
        '409': {
          description: 'That code exists, or another account already has that purpose',
          content: json(err),
        },
      },
    },
  },

  [`${base}/accounts/archive`]: {
    post: {
      summary: 'Close an account to new postings, or reopen it',
      description:
        'Never a delete: an account with history cannot be removed without ' +
        'removing the history, which is the one thing a ledger exists to keep.',
      tags: ['finance'],
      requestBody: { content: json(archiveAccountSchema) },
      responses: { '200': { description: 'Done' }, ...gated },
    },
  },

  [`${base}/journal`]: {
    get: {
      summary: 'Posted entries, most recent first',
      tags: ['finance'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Post one balanced entry',
      description:
        'The two sides must agree, and (sourceModule, sourceRef) is unique per ' +
        'institution -- a retry after a dropped connection collides rather than ' +
        'posting the same payment twice.',
      tags: ['finance'],
      requestBody: { content: json(postEntrySchema) },
      responses: {
        '200': { description: 'Posted' },
        '400': { description: 'Unbalanced, empty, or an unknown account', content: json(err) },
        ...gated,
        '409': { description: 'That source reference is already posted', content: json(err) },
      },
    },
  },

  [`${base}/journal/lines`]: {
    get: {
      summary: 'The lines of one entry',
      tags: ['finance'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
  },

  [`${base}/journal/reverse`]: {
    post: {
      summary: 'Post the mirror image of an entry',
      description:
        'The only correction there is. A posted entry is never edited or deleted, ' +
        'so the error and its correction both stay readable.',
      tags: ['finance'],
      requestBody: { content: json(reverseEntrySchema) },
      responses: {
        '200': { description: 'Reversed' },
        ...gated,
        '409': { description: 'Already reversed, or itself a reversal', content: json(err) },
      },
    },
  },

  [`${base}/trial-balance`]: {
    get: {
      summary: 'Every account with its debits, credits and balance',
      tags: ['finance'],
      responses: {
        '200': { description: 'OK', content: json(z.array(trialBalanceRowSchema)) },
        ...gated,
      },
    },
  },
}
