import { shiftsPaths } from './openapi-shifts'
import { leavePaths } from './openapi-leave'
import { lifecyclePaths } from './openapi-lifecycle'
import * as z from 'zod'
import { manifest } from '../manifest'
import {
  cancelLeaveSchema,
  createLeaveTypeSchema,
  createStaffSchema,
  decideLeaveSchema,
  endEmploymentSchema,
  generatePayrollSchema,
  leaveBalanceSchema,
  leaveRowSchema,
  myEmploymentSchema,
  paySalariesSchema,
  payrollRunSchema,
  payslipRowSchema,
  requestLeaveSchema,
  setComponentSchema,
  staffRowSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const gated = {
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
}

const corePaths = {
  [`${base}/staff`]: {
    get: {
      summary: 'Staff on record, with their current monthly gross',
      tags: ['hr'],
      responses: {
        '200': { description: 'OK', content: json(z.array(staffRowSchema)) },
        ...gated,
      },
    },
    post: {
      summary: 'Add a staff record',
      description:
        'Independent of the academic roster and of `users`: a cook, a driver and a lab ' +
        'assistant are staff who never teach a section, and plenty never sign in.',
      tags: ['hr'],
      requestBody: { content: json(createStaffSchema) },
      responses: {
        '200': { description: 'Created' },
        ...gated,
        '409': { description: 'That employee code or login is taken', content: json(err) },
      },
    },
  },
  [`${base}/staff/end`]: {
    post: {
      summary: 'End employment. Reason mandatory and audited.',
      tags: ['hr'],
      requestBody: { content: json(endEmploymentSchema) },
      responses: { '200': { description: 'Ended' }, ...gated },
    },
  },

  [`${base}/leave/types`]: {
    get: {
      summary: 'Leave types and their annual entitlements',
      tags: ['hr'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Define a leave type',
      description:
        'An entitlement of zero means unlimited but still recorded -- unpaid leave still needs ' +
        'approval, it just stops the salary for those days.',
      tags: ['hr'],
      requestBody: { content: json(createLeaveTypeSchema) },
      responses: { '200': { description: 'Created' }, ...gated },
    },
  },
  [`${base}/leave`]: {
    get: {
      summary: 'Leave requests, newest first',
      tags: ['hr'],
      responses: {
        '200': { description: 'OK', content: json(z.array(leaveRowSchema)) },
        ...gated,
      },
    },
    post: {
      summary: 'File a leave request',
      description:
        'A request, not a grant. Overlapping *approved* leave is refused by an exclusion ' +
        'constraint; overlapping pending requests are ordinary and get rejected on their merits.',
      tags: ['hr'],
      requestBody: { content: json(requestLeaveSchema) },
      responses: {
        '200': { description: 'Filed' },
        ...gated,
        '409': { description: 'Overlaps approved leave', content: json(err) },
      },
    },
  },
  [`${base}/leave/decide`]: {
    post: {
      summary: 'Approve or reject a request',
      description: 'Nobody approves their own leave, whatever their role.',
      tags: ['hr'],
      requestBody: { content: json(decideLeaveSchema) },
      responses: {
        '200': { description: 'Decided' },
        ...gated,
        '409': { description: 'Already decided', content: json(err) },
      },
    },
  },
  [`${base}/leave/cancel`]: {
    post: {
      summary: 'Withdraw leave. Reason mandatory and audited.',
      tags: ['hr'],
      requestBody: { content: json(cancelLeaveSchema) },
      responses: { '200': { description: 'Cancelled' }, ...gated },
    },
  },
  [`${base}/leave/balances`]: {
    get: {
      summary: "One person's entitlement, taken and remaining for a year",
      tags: ['hr'],
      responses: {
        '200': { description: 'OK', content: json(z.array(leaveBalanceSchema)) },
        ...gated,
      },
    },
  },

  [`${base}/pay/components`]: {
    get: {
      summary: 'Pay lines for one person, current and historical',
      tags: ['hr'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Set a pay line from a date',
      description:
        'Supersedes rather than overwrites: the previous row is closed the day before, so last ' +
        "month's payslip still explains itself and a raise in August does not rewrite July.",
      tags: ['hr'],
      requestBody: { content: json(setComponentSchema) },
      responses: { '200': { description: 'Set' }, ...gated },
    },
  },

  [`${base}/payroll`]: {
    get: {
      summary: 'Payslips, optionally for one month',
      tags: ['hr'],
      responses: {
        '200': { description: 'OK', content: json(z.array(payslipRowSchema)) },
        ...gated,
      },
    },
    post: {
      summary: 'Generate payslips for a month',
      description:
        'Idempotent by omission, not by overwrite: anybody already paid for the period is ' +
        'skipped and counted. A payslip is a document of record, and a database trigger refuses ' +
        'to alter or delete one without an audited reason.',
      tags: ['hr'],
      requestBody: { content: json(generatePayrollSchema) },
      responses: {
        '200': { description: 'Generated', content: json(payrollRunSchema) },
        ...gated,
      },
    },
  },

  [`${base}/payroll/paid`]: {
    get: {
      summary: 'Which months have been paid, and when',
      tags: ['hr'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: "Pay a month's salaries and clear the liability",
      description:
        "The amount is the sum of that month's payslips, not an input: the " +
        'entry that clears salaries payable has to be the entry that created ' +
        'it. Once a month is paid, no further payslip can be generated for it.',
      tags: ['hr'],
      requestBody: { content: json(paySalariesSchema) },
      responses: {
        '200': { description: 'Paid' },
        '404': { description: 'No payroll generated for that month', content: json(err) },
        ...gated,
        '409': { description: 'That month is already paid', content: json(err) },
      },
    },
  },

  [`${base}/me`]: {
    get: {
      summary: 'A staff member’s own record, leave balances and payslips',
      tags: ['hr'],
      responses: {
        '200': { description: 'OK', content: json(myEmploymentSchema) },
        ...gated,
      },
    },
  },
}

export const paths = { ...corePaths, ...lifecyclePaths, ...leavePaths, ...shiftsPaths }
