import * as z from 'zod'
import { manifest } from '../manifest'
import {
  addCopiesSchema,
  borrowerStatusSchema,
  catalogueRowSchema,
  createTitleSchema,
  issueSchema,
  librarySettingsSchema,
  loanRowSchema,
  overdueReportSchema,
  renewSchema,
  returnSchema,
  setCopyStatusSchema,
  settleFineSchema,
  waiveFineSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const gated = {
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
}

export const paths = {
  [`${base}/titles`]: {
    get: {
      summary: 'Search the catalogue by title, author or ISBN',
      description:
        'Readable by anyone signed in to the institution: a catalogue nobody can search is a ' +
        'filing cabinet. Counts of total and available copies come back with each row.',
      tags: ['library'],
      responses: {
        '200': { description: 'OK', content: json(z.array(catalogueRowSchema)) },
        ...gated,
      },
    },
    post: {
      summary: 'Catalogue a new title',
      tags: ['library'],
      requestBody: { content: json(createTitleSchema) },
      responses: {
        '200': { description: 'Catalogued' },
        ...gated,
        '409': { description: 'That ISBN is already catalogued', content: json(err) },
      },
    },
  },

  [`${base}/copies`]: {
    get: {
      summary: 'The physical copies of one title, with who holds each',
      tags: ['library'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Add copies of a title, one accession number each',
      description:
        'A batch, because that is how books arrive. All or nothing: a partial success would ' +
        'leave the librarian guessing which accession numbers landed.',
      tags: ['library'],
      requestBody: { content: json(addCopiesSchema) },
      responses: {
        '200': { description: 'Added' },
        ...gated,
        '409': { description: 'An accession number is already in use', content: json(err) },
      },
    },
  },
  [`${base}/copies/status`]: {
    post: {
      summary: 'Withdraw a copy, write it off as lost, or return it to service',
      description:
        'Audited with a mandatory reason. A copy that is out on loan cannot be written off ' +
        'underneath its borrower; a database trigger refuses that rather than trusting the ' +
        'caller to check.',
      tags: ['library'],
      requestBody: { content: json(setCopyStatusSchema) },
      responses: { '200': { description: 'Changed' }, ...gated },
    },
  },

  [`${base}/loans`]: {
    get: {
      summary: 'Everything currently out, soonest due first',
      tags: ['library'],
      responses: {
        '200': { description: 'OK', content: json(z.array(loanRowSchema)) },
        ...gated,
      },
    },
  },
  [`${base}/loans/issue`]: {
    post: {
      summary: 'Issue a copy to a borrower',
      description:
        'Refuses with the rule that said no -- loan limit reached, fines outstanding, copy not ' +
        'available -- because the desk has to tell the student standing in front of it why.',
      tags: ['library'],
      requestBody: { content: json(issueSchema) },
      responses: {
        '200': { description: 'Issued' },
        ...gated,
        '409': { description: 'A circulation rule refused it', content: json(err) },
      },
    },
  },
  [`${base}/loans/return`]: {
    post: {
      summary: 'Take a copy back and settle the fine',
      description:
        'The fine is computed once, here, and stored: it is what the borrower was told to pay, ' +
        'and a later change to the rules must not silently restate a closed loan.',
      tags: ['library'],
      requestBody: { content: json(returnSchema) },
      responses: {
        '200': { description: 'Returned' },
        ...gated,
        '409': { description: 'That copy is not out on loan', content: json(err) },
      },
    },
  },
  [`${base}/loans/renew`]: {
    post: {
      summary: 'Extend a loan from its current due date',
      description:
        'Refused on an already-overdue loan: renewal extends a loan in good standing, and ' +
        'quietly extending a late one erases the fine already accrued.',
      tags: ['library'],
      requestBody: { content: json(renewSchema) },
      responses: {
        '200': { description: 'Renewed' },
        ...gated,
        '409': { description: 'Overdue, closed, or out of renewals', content: json(err) },
      },
    },
  },

  [`${base}/fines/waive`]: {
    post: {
      summary: 'Forgive part or all of a fine. Reason mandatory and audited.',
      tags: ['library'],
      requestBody: { content: json(waiveFineSchema) },
      responses: { '200': { description: 'Waived' }, ...gated },
    },
  },
  [`${base}/fines/settle`]: {
    post: {
      summary: 'Record a fine paid at the desk',
      description:
        'Deliberately not a Fees charge: Fees is an optional module, and a library that cannot ' +
        'take a five-rupee fine because the institution did not buy the finance module is a ' +
        'library that has stopped working.',
      tags: ['library'],
      requestBody: { content: json(settleFineSchema) },
      responses: {
        '200': { description: 'Settled' },
        ...gated,
        '409': { description: 'Already settled', content: json(err) },
      },
    },
  },

  [`${base}/status`]: {
    get: {
      summary: "One borrower's open loans, history, fines and whether they may borrow",
      tags: ['library'],
      responses: {
        '200': { description: 'OK', content: json(borrowerStatusSchema) },
        ...gated,
      },
    },
  },
  [`${base}/overdue`]: {
    get: {
      summary: 'Loans past their due date, longest overdue first',
      tags: ['library'],
      responses: {
        '200': { description: 'OK', content: json(overdueReportSchema) },
        ...gated,
      },
    },
  },
  [`${base}/settings`]: {
    get: {
      summary: 'Circulation rules in force, or the built-in defaults',
      tags: ['library'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    put: {
      summary: 'Set the circulation rules',
      tags: ['library'],
      requestBody: { content: json(librarySettingsSchema) },
      responses: { '200': { description: 'Saved' }, ...gated },
    },
  },
}
