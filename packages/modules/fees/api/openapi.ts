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
  setAccountUpiSchema,
  verifyClaimSchema,
} from './transfers'
import { receiptLineSchema } from './statement'
import {
  aidAssessmentSchema,
  awardScholarshipSchema,
  bouncePaymentSchema,
  voidInvoiceSchema,
  voidPaymentSchema,
  createFeeItemSchema,
  createScholarshipSchema,
  prorateDropsSchema,
  revokeAwardSchema,
  setRefundRulesSchema,
  duesReportSchema,
  receivableReportSchema,
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

/**
 * An act that moves money, done once per idempotency key (ACC-18, NEW-15,
 * decision 187). The portal sends one with every form; an API client should.
 */
const idempotent = (act: string) => ({
  parameters: [
    {
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description:
        `Says "the same ${act}". Sent again by the same person, it is answered with the first ${act}, ` +
        'with "replayed": true, and nothing is done twice. 8 to 128 characters from A-Z a-z 0-9 . _ : - ' +
        '(a UUID fits). Kept for the life of the record.',
      schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,128}$' },
    },
  ],
})
const keyRefusals = {
  '400': { description: 'invalid_idempotency_key: a malformed Idempotency-Key', content: json(err) },
  '409': {
    description:
      'idempotency_key_reused: the key was already used for a different request; ' +
      'idempotent_result_gone: what it produced no longer exists',
    content: json(err),
  },
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
      ...idempotent('charge'),
      requestBody: { content: json(chargeStudentSchema) },
      responses: { '200': { description: 'Created, or replayed' }, ...gated, ...keyRefusals },
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
      summary: 'What has been issued for a term, and for how much, a page at a time',
      tags: ['fees'],
      responses: {
        '200': {
          description: 'OK',
          content: json(
            z.object({
              rows: z.array(
                z.object({
                  id: z.string(),
                  studentId: z.string(),
                  studentName: z.string().nullable(),
                  studentEmail: z.string().nullable(),
                  chargedPaise: z.number().int(),
                  version: z.number().int(),
                  issuedAt: z.string(),
                }),
              ),
              total: z.number().int(),
              next: z.string().nullable(),
            }),
          ),
        },
        ...gated,
      },
    },
    post: {
      summary: "Issue a term's charges and post them to the books",
      description:
        'Turns the price list into money owed for every student enrolled in the term: ' +
        'a programme declaration whose dates overlap it, or a charge of their own for it. ' +
        'The answer lists, as notEnrolled, section members never declared into the programme. ' +
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
      ...idempotent('refund'),
      requestBody: { content: json(refundPaymentSchema) },
      responses: {
        '200': { description: 'Refunded, or replayed' },
        ...keyRefusals,
        '400': {
          description: 'More than the payment has left to refund, or invalid_idempotency_key',
          content: json(err),
        },
        '404': { description: 'No such payment', content: json(err) },
        ...gated,
      },
    },
  },

  [`${base}/payments/void`]: {
    post: {
      summary: 'Void a receipt recorded by mistake',
      description:
        'The receipt stays on record marked void; its journal entry is reversed today in the ' +
        "institution's zone and the amount is owed again. An administrator who did not record " +
        'the payment voids it; the student and their guardians are told.',
      tags: ['fees'],
      requestBody: { content: json(voidPaymentSchema) },
      responses: {
        '200': { description: 'Voided' },
        '400': { description: 'Invalid input', content: json(err) },
        '403': { description: 'separation_of_duties: you recorded it; forbidden: not an administrator; or the module is not enabled', content: json(err) },
        '404': { description: 'no_such_payment', content: json(err) },
        '409': { description: 'payment_not_live: already void or returned; payment_refunded: refunds stand against it', content: json(err) },
      },
    },
  },
  [`${base}/payments/bounce`]: {
    post: {
      summary: 'Record a cheque returned unpaid by the bank',
      description:
        "The receipt stays on record marked returned unpaid; its journal entry is reversed on the bank's " +
        "date of return and the amount is owed again. The drawer's IFSC and account are required if the " +
        'receipt lacks them. An optional bounce charge is billed when the term is next issued.',
      tags: ['fees'],
      requestBody: { content: json(bouncePaymentSchema) },
      responses: {
        '200': { description: 'Marked returned unpaid' },
        '400': {
          description: 'not_a_cheque, drawer_required, bounce_before_receipt, future_bounce or bad_charge',
          content: json(err),
        },
        '403': { description: 'separation_of_duties: you recorded it; forbidden; or the module is not enabled', content: json(err) },
        '404': { description: 'no_such_payment', content: json(err) },
        '409': { description: 'payment_not_live: already void or returned; payment_refunded: refunds stand against it', content: json(err) },
      },
    },
  },

  [`${base}/invoices/void`]: {
    post: {
      summary: "Void a student's invoice for a term, issued in error",
      description:
        'For an invoice issued to a student who was not enrolled, for example. Nothing may be paid or ' +
        'credited against the term. One entry today takes the student back to owing nothing; issuing ' +
        'the term again bills them afresh if they are enrolled.',
      tags: ['fees'],
      requestBody: { content: json(voidInvoiceSchema) },
      responses: {
        '200': { description: 'Voided' },
        '400': { description: 'Invalid input', content: json(err) },
        '404': { description: 'no_such_invoice: no live invoice for that student and term', content: json(err) },
        '409': {
          description: 'invoice_has_payments: money is paid against the term; invoice_has_credits: scholarship awards or drop credits',
          content: json(err),
        },
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
      responses: {
        '200': { description: 'Granted' },
        '400': {
          description: "item_not_charged: the item is not of a programme the student is enrolled in for its term",
          content: json(err),
        },
        ...gated,
      },
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
      description:
        'A bank transfer or UPI reference is receipted once per institution, ignoring case and padding.',
      tags: ['fees'],
      ...idempotent('payment'),
      requestBody: { content: json(recordPaymentSchema) },
      responses: {
        '200': { description: 'Recorded, or replayed' },
        ...gated,
        ...keyRefusals,
        '409': {
          description:
            'duplicate_reference: that UTR or UPI reference is already receipted; ' +
            'idempotency_key_reused or idempotent_result_gone',
          content: json(err),
        },
      },
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
  [`${base}/reconciliation`]: {
    get: {
      summary: 'The student ledgers against the fees receivable account',
      tags: ['fees'],
      responses: {
        '200': { description: 'OK', content: json(receivableReportSchema) },
        ...gated,
      },
    },
  },
  [`${base}/dues`]: {
    get: {
      summary: 'Balances for a term from the books, worst first, a page at a time',
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
    [`${base}/bank-accounts/upi`]: post("Set or clear an account's UPI ID", setAccountUpiSchema, 'Payers see its QR; a merchant ID makes the QR carry the amount due.'),
    [`${base}/statement`]: get('Unmatched credits on the fees bank account, a page at a time', ['q?', 'sort?', 'dir?', 'n?', 'after?']),
    [`${base}/statement/match`]: post('Match the bank statement to reported payments and payment references', z.object({})),
    [`${base}/statement/receipt`]: post('Receipt a statement line', receiptLineSchema),
    [`${base}/bank-accounts/retire`]: post('Retire an account', retireBankAccountSchema, 'Claims already made into it stand.'),
    [`${base}/transfers`]: {
      ...get('Reported payments, pending first, a page at a time', ['status?', 'q?', 'n?', 'after?']),
      ...post('Report a payment by RTGS, NEFT, IMPS, UPI or a deposited cheque', claimTransferSchema, 'A UTR already claimed is refused.'),
    },
    [`${base}/transfers/mine`]: get("The signed-in student's reported transfers"),
    [`${base}/transfers/verify`]: post(
      'Verify a transfer against the bank statement',
      verifyClaimSchema,
      'Records the payment, receipted and reconciled, in the same act. A UTR already receipted is refused (409 duplicate_reference) and the claim stays pending.',
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
