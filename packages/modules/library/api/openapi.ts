import * as z from 'zod'
import { manifest } from '../manifest'
import {
  addCopiesSchema,
  borrowerStatusSchema,
  catalogueRowSchema,
  createTitleSchema,
  enterSchema,
  issueSchema,
  librarySettingsSchema,
  loanRowSchema,
  overdueReportSchema,
  renewSchema,
  returnSchema,
  scanSchema,
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

const lookup = (summary: string) => ({
  get: {
    summary,
    tags: ['library'],
    parameters: [{ name: 'q', in: 'query', required: true, description: 'One to 100 characters', schema: { type: 'string', minLength: 1, maxLength: 100 } }],
    responses: {
      '200': { description: 'At most 12 hits: id, title, detail (the author) and href' },
      '400': { description: 'invalid_search' },
      '403': { description: 'Forbidden, or the module is not enabled' },
      '429': { description: 'Too many lookups (120 a minute); see Retry-After' },
    },
  },
})

export const paths = {
  [`${base}/record-search`]: lookup('Find a book by title, author or ISBN (the catalogue readers)'),
  [`${base}/titles`]: {
    get: {
      summary: 'Search the catalogue by title, author or ISBN',
      description:
        'Readable by anyone signed in to the institution: a catalogue nobody can search is a ' +
        'filing cabinet. Counts of total and available copies come back with each row.',
      tags: ['library'],
      responses: {
        '200': { description: 'OK', content: json(z.object({ rows: z.array(catalogueRowSchema), total: z.number().int(), next: z.string().nullable() })) },
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
      summary: 'Everything currently out, soonest due first, a page at a time',
      tags: ['library'],
      responses: {
        '200': { description: 'OK', content: json(z.object({ rows: z.array(loanRowSchema), total: z.number().int(), next: z.string().nullable(), late: z.number().int() })) },
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
      summary: 'Forgive part or all of a fine not yet settled. Reason mandatory and audited.',
      tags: ['library'],
      requestBody: { content: json(waiveFineSchema) },
      responses: { '200': { description: 'Waived' }, ...gated, '409': { description: 'Already settled', content: json(err) } },
    },
  },
  [`${base}/fines/settle`]: {
    post: {
      summary: "Record how a fine was paid: cash, UPI, bank transfer, or moved to the student's fee account",
      description:
        'Cash posts to cash and UPI or a transfer to the bank, when the institution keeps books. ' +
        "To the fee account raises a charge on the term running today, billed with the term's fees; " +
        'the library then posts nothing. A settled fine cannot be waived.',
      tags: ['library'],
      requestBody: { content: json(settleFineSchema) },
      responses: {
        '200': { description: 'Settled' },
        ...gated,
        '409': { description: 'Already settled; or, to the fee account: Fees not enabled, not a student, or no term running', content: json(err) },
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
      summary: 'Loans past their due date, longest overdue first, a page at a time; the fine total covers all of them',
      tags: ['library'],
      responses: {
        '200': { description: 'OK', content: json(overdueReportSchema) },
        ...gated,
      },
    },
  },
  [`${base}/door/qr`]: {
    get: {
      summary: 'The library door code for the screen at the door, rotating every 20 seconds (needs the Attendance module)',
      tags: ['library'],
      responses: { '200': { description: 'OK' }, ...gated, '409': { description: 'door_scan_unavailable', content: json(err) } },
    },
  },
  [`${base}/door/scan`]: {
    post: {
      summary: 'A student scans the door code to enter or leave. Outside opening hours (less 15 minutes before opening) the answer is library_closed.',
      tags: ['library'],
      requestBody: { content: json(scanSchema) },
      responses: {
        '200': { description: 'Session opened (idempotent) or closed' },
        ...gated,
        '409': { description: 'not_inside, library_closed, door_scan_unavailable, stale_code or invalid_code', content: json(err) },
      },
    },
  },
  [`${base}/sessions/enter`]: {
    post: {
      summary: 'Desk entry: record a student walking in, at any hour. Idempotent while they are inside.',
      tags: ['library'],
      requestBody: { content: json(enterSchema) },
      responses: { '200': { description: 'Session' }, ...gated, '404': { description: 'no_such_student', content: json(err) } },
    },
  },
  [`${base}/sessions/exit`]: {
    post: {
      summary: 'Desk exit: record a student leaving',
      tags: ['library'],
      requestBody: { content: json(enterSchema) },
      responses: { '200': { description: 'Session closed' }, ...gated, '409': { description: 'not_inside', content: json(err) } },
    },
  },
  [`${base}/sessions`]: {
    get: { summary: 'Who is inside now, newest first, a page at a time', tags: ['library'], responses: { '200': { description: 'OK' }, ...gated } },
  },
  [`${base}/occupancy`]: {
    get: { summary: 'How many are inside now', tags: ['library'], responses: { '200': { description: 'OK' }, ...gated } },
  },
  [`${base}/sessions/mine`]: {
    get: { summary: 'A student\'s own recent visits and whether they are inside', tags: ['library'], responses: { '200': { description: 'OK' }, ...gated } },
  },
  [`${base}/settings`]: {
    get: {
      summary: 'Circulation rules in force, or the built-in defaults, with door hours and presence timings',
      tags: ['library'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    put: {
      summary: 'Set the circulation rules. Reason mandatory and audited.',
      tags: ['library'],
      requestBody: { content: json(librarySettingsSchema) },
      responses: { '200': { description: 'Saved' }, ...gated },
    },
  },
}
