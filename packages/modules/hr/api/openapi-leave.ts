import * as z from 'zod'
import { manifest } from '../manifest'
import {
  allocateYearSchema,
  assignPolicySchema,
  createLeavePolicySchema,
  decideCompOffSchema,
  decideEncashmentSchema,
  manualAllocationSchema,
  requestCompOffSchema,
  requestEncashmentSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const ok = {
  '200': { description: 'OK' },
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
}
const refused = (what: string) => ({ '409': { description: what, content: json(err) } })
const post = (summary: string, schema: z.ZodType, description?: string, extra = {}) => ({
  post: {
    summary,
    ...(description ? { description } : {}),
    tags: ['hr'],
    requestBody: { content: json(schema) },
    responses: { ...ok, ...extra },
  },
})
const get = (summary: string) => ({ get: { summary, tags: ['hr'], responses: ok } })

export const leavePaths = {
  [`${base}/leave/policies`]: {
    ...get('Leave policies, their lines, and how many people are on each'),
    ...post(
      'Define a leave policy',
      createLeavePolicySchema,
      'A named bundle of entitlements. Once allocated, it replaces the leave type default ' +
        'for the people on it rather than adding to it.',
    ),
  },
  [`${base}/leave/policies/assign`]: post(
    'Put somebody on a policy from a date',
    assignPolicySchema,
    'Supersedes the current assignment, closed the day before. Never two at once.',
  ),
  [`${base}/leave/allocations`]: {
    ...get("One person's allocations for a year (staffId, year)"),
    ...post('Allocate leave by hand, with a reason', manualAllocationSchema),
  },
  [`${base}/leave/allocations/year`]: post(
    "Write down a year's allocations from policy, and carry-forward",
    allocateYearSchema,
    'Idempotent: running it again allocates only what is missing.',
  ),
  [`${base}/leave/comp-off`]: {
    ...get('Compensatory-leave claims'),
    ...post('Claim a worked day off back as leave', requestCompOffSchema, undefined, refused('That day is already claimed')),
  },
  [`${base}/leave/comp-off/decide`]: post(
    'Approve or reject a claim',
    decideCompOffSchema,
    'Approval allocates the earned days, lapsing after the type validity.',
  ),
  [`${base}/leave/encashments`]: {
    ...get('Leave payouts'),
    ...post('Ask to sell unused leave back', requestEncashmentSchema, undefined, refused('More than the balance')),
  },
  [`${base}/leave/encashments/decide`]: post(
    'Approve or reject a payout',
    decideEncashmentSchema,
    "Approval fixes the amount: a day's worth of the components the type names, over the " +
      'days in the month. It is paid on that month\'s payslip, untouched by loss of pay.',
    refused('Payroll already ran for that month, or nothing to base it on'),
  ),
}
