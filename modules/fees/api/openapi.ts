import * as z from 'zod'
import { manifest } from '../manifest'
import {
  createFeeItemSchema,
  duesReportSchema,
  grantWaiverSchema,
  recordPaymentSchema,
  reconcilePaymentSchema,
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
