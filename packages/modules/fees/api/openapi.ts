import * as z from 'zod'
import { manifest } from '../manifest'
import { cancelStudentChargeSchema, chargeStudentSchema } from './charges'
import {
  addBankAccountSchema,
  claimTransferSchema,
  issueLetterSchema,
  letterSettingsSchema,
  rejectClaimSchema,
  retireBankAccountSchema,
  verifyClaimSchema,
} from './transfers'
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
  ...transfersAndLetters(),
  [`${base}/charges`]: {
    get: {
      summary: 'Charges on single students -- a backlog paper, a duplicate admit card -- optionally for one term',
      tags: ['fees'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Charge one student, billed on their next invoice',
      tags: ['fees'],
      requestBody: { content: json(chargeStudentSchema) },
      responses: { '200': { description: 'Created' }, ...gated },
    },
  },
  [`${base}/charges/cancel`]: {
    post: {
      summary: 'Cancel a charge not yet invoiced',
      description: 'Once an invoice carries it, the way back is a waiver or a refund.',
      tags: ['fees'],
      requestBody: { content: json(cancelStudentChargeSchema) },
      responses: { '200': { description: 'Cancelled' }, ...gated, '409': { description: 'Already invoiced', content: json(err) } },
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

/** Paying by bank transfer, and demand letters. */
function transfersAndLetters() {
  const post = (summary: string, schema: z.ZodType, description?: string) => ({
    post: {
      summary,
      ...(description ? { description } : {}),
      tags: ['fees'],
      requestBody: { content: json(schema) },
      responses: { '200': { description: 'OK' }, ...gated, '409': { description: 'Refused', content: json(err) } },
    },
  })
  const get = (summary: string, query: string[] = [], description?: string) => ({
    get: {
      summary,
      ...(description ? { description } : {}),
      tags: ['fees'],
      parameters: query.map((name) => ({ name: name.replace('?', ''), in: 'query', required: !name.endsWith('?'), schema: { type: 'string' } })),
      responses: { '200': { description: 'OK' }, ...gated },
    },
  })
  return {
    [`${base}/bank-accounts`]: {
      ...get("The institution's accounts fees are paid into"),
      ...post('Add an account', addBankAccountSchema),
    },
    [`${base}/bank-accounts/retire`]: post('Retire an account', retireBankAccountSchema, 'Claims already made into it stand.'),
    [`${base}/transfers`]: {
      ...get('Reported transfers, pending first', ['status?']),
      ...post('Report an RTGS, NEFT or IMPS transfer (the student who made it)', claimTransferSchema, 'A UTR already claimed is refused.'),
    },
    [`${base}/transfers/mine`]: get("The signed-in student's reported transfers"),
    [`${base}/transfers/verify`]: post(
      'Verify a transfer against the bank statement',
      verifyClaimSchema,
      'Records the payment, receipted and reconciled, in the same act.',
    ),
    [`${base}/transfers/reject`]: post('Reject a reported transfer, with a reason', rejectClaimSchema),
    [`${base}/letters/settings`]: {
      ...get('Who signs demand letters, and what they say'),
      ...post('Set them', letterSettingsSchema),
    },
    [`${base}/letters`]: {
      ...get("Demand letters: a student's own, or the office's register"),
      ...post('Issue a numbered demand letter for a term', issueLetterSchema),
    },
    [`${base}/letters/verify`]: get('Confirm a letter by its number', ['number']),
    [`${base}/demand-letter.pdf`]: {
      get: {
        ...get('A demand letter as a PDF', ['letterId']).get,
        responses: { '200': { description: 'OK', content: { 'application/pdf': {} } }, ...gated },
      },
    },
  }
}
