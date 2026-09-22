import * as z from 'zod'
import { manifest } from '../manifest'
import {
  aidAssessmentSchema,
  awardScholarshipSchema,
  createFeeItemSchema,
  createScholarshipSchema,
  prorateDropsSchema,
  revokeAwardSchema,
  setRefundRulesSchema,
  duesReportSchema,
  grantWaiverSchema,
  issueInvoicesSchema,
  recordPaymentSchema,
  reconcilePaymentSchema,
  refundPaymentSchema,
  revokeWaiverSchema,
  studentLedgerSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const gated = {
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
}

export const paths = {
  [`${base}/scholarships`]: {
    get: {
      summary: 'The scholarships this institution funds and defines',
      tags: ['fees'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Define a scholarship: who qualifies, and how much',
      tags: ['fees'],
      requestBody: { content: json(createScholarshipSchema) },
      responses: { '200': { description: 'Created' }, ...gated },
    },
  },
  [`${base}/aid`]: {
    get: {
      summary:
        "Every live scholarship against one student's term, with the amount and, where not eligible, why not",
      tags: ['fees'],
      responses: {
        '200': { description: 'OK', content: json(aidAssessmentSchema) },
        ...gated,
      },
    },
  },
  [`${base}/aid/award`]: {
    post: {
      summary: 'Award a scholarship, settling the amount and posting it to the ledger',
      tags: ['fees'],
      requestBody: { content: json(awardScholarshipSchema) },
      responses: { '200': { description: 'Awarded' }, ...gated },
    },
  },
  [`${base}/aid/revoke`]: {
    post: {
      summary: 'Withdraw an award, with a reason and a reversal in the books',
      tags: ['fees'],
      requestBody: { content: json(revokeAwardSchema) },
      responses: { '200': { description: 'Revoked' }, ...gated },
    },
  },
  [`${base}/aid/awards`]: {
    get: {
      summary: 'Awards made in a term',
      tags: ['fees'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
  },
  [`${base}/refund-rules`]: {
    get: {
      summary: "A term's refund brackets, by the date a drop counts from",
      tags: ['fees'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: "Replace a term's refund brackets as a set",
      tags: ['fees'],
      requestBody: { content: json(setRefundRulesSchema) },
      responses: { '200': { description: 'Applied' }, ...gated },
    },
  },
  [`${base}/drops`]: {
    get: {
      summary: 'Credits already worked out for courses dropped in a term',
      tags: ['fees'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
  },
  [`${base}/drops/prorate`]: {
    post: {
      summary: "Work a term's drops into credits, once each, and post them",
      tags: ['fees'],
      requestBody: { content: json(prorateDropsSchema) },
      responses: {
        '200': { description: 'Applied' },
        ...gated,
        '409': {
          description: 'This institution does not keep registrations in the product',
          content: json(err),
        },
      },
    },
  },
  [`${base}/items`]: {
    get: {
      summary: 'Charged fee lines, optionally for one term',
      tags: ['fees'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Define a charge for a programme and term',
      tags: ['fees'],
      requestBody: { content: json(createFeeItemSchema) },
      responses: {
        '200': { description: 'Created' },
        ...gated,
        '409': { description: 'That label already exists for the term', content: json(err) },
      },
    },
  },

  [`${base}/invoices`]: {
    get: {
      summary: 'What has been issued for a term, and for how much',
      tags: ['fees'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: "Issue a term's charges and post them to the books",
      description:
        'Turns the price list into money owed for every student in the term. ' +
        'Safe to run again: a student already issued is skipped, and a charge ' +
        'added since goes out on a supplementary entry for the difference.',
      tags: ['fees'],
      requestBody: { content: json(issueInvoicesSchema) },
      responses: {
        '200': { description: 'Issued' },
        '404': { description: 'No such term', content: json(err) },
        ...gated,
      },
    },
  },

  [`${base}/refunds`]: {
    post: {
      summary: 'Return money against the payment it came in on',
      description:
        'The payment itself is never deleted or amended. Never more can go ' +
        'back than came in, which the database enforces as well as this module.',
      tags: ['fees'],
      requestBody: { content: json(refundPaymentSchema) },
      responses: {
        '200': { description: 'Refunded' },
        '400': { description: 'More than the payment has left to refund', content: json(err) },
        '404': { description: 'No such payment', content: json(err) },
        ...gated,
      },
    },
  },

  [`${base}/waivers`]: {
    post: {
      summary: 'Grant or revise a scholarship or waiver. Reason mandatory and audited.',
      description:
        'A waiver cannot exceed the charge it applies to: that would be a refund owed rather ' +
        'than a fee forgiven. Revising an existing waiver updates the same row and records the ' +
        'previous amount in the audit trail.',
      tags: ['fees'],
      requestBody: { content: json(grantWaiverSchema) },
      responses: { '200': { description: 'Granted' }, ...gated },
    },
  },
  [`${base}/waivers/revoke`]: {
    post: {
      summary: 'Withdraw a waiver. Reason mandatory and audited.',
      tags: ['fees'],
      requestBody: { content: json(revokeWaiverSchema) },
      responses: { '204': { description: 'Revoked' }, ...gated },
    },
  },

  [`${base}/payments`]: {
    post: {
      summary: 'Record a payment and issue a receipt number',
      tags: ['fees'],
      requestBody: { content: json(recordPaymentSchema) },
      responses: { '200': { description: 'Recorded' }, ...gated },
    },
  },
  [`${base}/payments/reconcile`]: {
    post: {
      summary: 'Confirm a payment against the bank. Reason mandatory and audited.',
      description:
        'The act that turns a recorded claim into cleared funds. A reconciled payment cannot ' +
        'afterwards be altered or deleted without an audited reason; a database trigger enforces ' +
        'that rather than trusting a code path to remember.',
      tags: ['fees'],
      requestBody: { content: json(reconcilePaymentSchema) },
      responses: {
        '204': { description: 'Reconciled' },
        ...gated,
        '409': { description: 'Already reconciled', content: json(err) },
      },
    },
  },

  [`${base}/ledger`]: {
    get: {
      summary: 'One student’s charges, waivers and payments for a term',
      tags: ['fees'],
      responses: {
        '200': { description: 'OK', content: json(studentLedgerSchema) },
        ...gated,
      },
    },
  },
  [`${base}/dues`]: {
    get: {
      summary: 'Outstanding balances for a term, worst first',
      tags: ['fees'],
      responses: {
        '200': { description: 'OK', content: json(duesReportSchema) },
        ...gated,
      },
    },
  },
  [`${base}/receipt.pdf`]: {
    get: {
      summary: 'A payment receipt as a PDF',
      tags: ['fees'],
      responses: {
        '200': { description: 'OK', content: { 'application/pdf': {} } },
        ...gated,
      },
    },
  },
}
