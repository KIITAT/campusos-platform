import * as z from 'zod'
import { parseRupeesToPaise } from '@campusos/money'
import { componentKindEnum, employmentEnum, leaveStatusEnum } from '../schema'

const uuid = z.uuid()
const day = z.iso.date()

const rupees = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const paise = parseRupeesToPaise(v)
  if (paise === null) {
    ctx.addIssue({ code: 'custom', message: 'not a valid rupee amount' })
    return z.NEVER
  }
  return paise
})

/** A month, as its first day. The unit is a month; the storage is a date. */
const period = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, 'expected YYYY-MM')
  .transform((s) => `${s.slice(0, 7)}-01`)

export const createStaffSchema = z
  .object({
    employeeCode: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(160),
    designation: z.string().trim().min(1).max(120),
    department: z.string().trim().max(120).nullish(),
    employment: z.enum(employmentEnum.enumValues).default('permanent'),
    joinedOn: day,
    email: z.email().nullish(),
    phone: z.string().trim().max(20).nullish(),
    userId: z.string().min(1).nullish(),
  })
  .meta({ id: 'HrStaffCreate' })

export const endEmploymentSchema = z
  .object({
    staffId: uuid,
    leftOn: day,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'HrStaffEnd' })

export const createLeaveTypeSchema = z
  .object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(120),
    annualDays: z.coerce.number().int().min(0).max(365).default(0),
    paid: z.coerce.boolean().default(true),
  })
  .meta({ id: 'HrLeaveTypeCreate' })

export const requestLeaveSchema = z
  .object({
    staffId: uuid,
    leaveTypeId: uuid,
    fromOn: day,
    toOn: day,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'HrLeaveRequest' })

export const decideLeaveSchema = z
  .object({
    requestId: uuid,
    approve: z.coerce.boolean(),
    note: z.string().trim().max(500).nullish(),
  })
  .meta({ id: 'HrLeaveDecide' })

export const cancelLeaveSchema = z
  .object({
    requestId: uuid,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'HrLeaveCancel' })

export const setComponentSchema = z
  .object({
    staffId: uuid,
    code: z.string().trim().min(1).max(30),
    label: z.string().trim().min(1).max(120),
    kind: z.enum(componentKindEnum.enumValues),
    amount: rupees,
    effectiveFrom: day,
  })
  .meta({ id: 'HrPayComponentSet' })

export const generatePayrollSchema = z
  .object({
    period,
    /** Limit to one person; otherwise everybody employed that month. */
    staffId: uuid.nullish(),
  })
  .meta({ id: 'HrPayrollGenerate' })

/**
 * Paying a month's salaries. The amount is not an input: it is the sum of the
 * payslips already generated, so a typo cannot leave the liability half
 * discharged and the books carrying the difference for ever.
 */
export const paySalariesSchema = z
  .object({
    period,
    paidOn: day,
    /** Which asset it leaves from. Only the two the chart has accounts for. */
    paidFrom: z.enum(['bank', 'cash']).default('bank'),
    reference: z.string().trim().max(120).nullish(),
  })
  .meta({ id: 'HrSalariesPay' })

// --- reads -----------------------------------------------------------------

export const staffRowSchema = z
  .object({
    id: uuid,
    employeeCode: z.string(),
    name: z.string(),
    designation: z.string(),
    department: z.string().nullable(),
    employment: z.enum(employmentEnum.enumValues),
    joinedOn: z.string(),
    leftOn: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    monthlyGrossPaise: z.number().int(),
  })
  .meta({ id: 'HrStaff' })

export const leaveRowSchema = z
  .object({
    id: uuid,
    staffId: uuid,
    staffName: z.string(),
    typeCode: z.string(),
    typeName: z.string(),
    paid: z.boolean(),
    fromOn: z.string(),
    toOn: z.string(),
    days: z.number().int(),
    reason: z.string(),
    status: z.enum(leaveStatusEnum.enumValues),
    decisionNote: z.string().nullable(),
  })
  .meta({ id: 'HrLeaveRow' })

export const leaveBalanceSchema = z
  .object({
    typeCode: z.string(),
    typeName: z.string(),
    annualDays: z.number().int(),
    takenDays: z.number().int(),
    /** Null when the type is unlimited but still recorded. */
    remainingDays: z.number().int().nullable(),
  })
  .meta({ id: 'HrLeaveBalance' })

export const payslipLineSchema = z
  .object({
    code: z.string(),
    label: z.string(),
    kind: z.enum(componentKindEnum.enumValues),
    amountPaise: z.number().int(),
    appliedPaise: z.number().int(),
  })
  .meta({ id: 'HrPayslipLine' })

export const payslipRowSchema = z
  .object({
    id: uuid,
    staffId: uuid,
    staffName: z.string(),
    employeeCode: z.string(),
    designation: z.string(),
    period: z.string(),
    grossPaise: z.number().int(),
    deductionsPaise: z.number().int(),
    netPaise: z.number().int(),
    unpaidLeaveDays: z.number().int(),
    lossOfPayPaise: z.number().int(),
    lines: z.array(payslipLineSchema),
    generatedAt: z.string(),
  })
  .meta({ id: 'HrPayslip' })

export const payrollRunSchema = z
  .object({
    period: z.string(),
    generated: z.number().int(),
    skipped: z.number().int(),
    totalNetPaise: z.number().int(),
    payslips: z.array(payslipRowSchema),
  })
  .meta({ id: 'HrPayrollRun' })

export const myEmploymentSchema = z
  .object({
    onRecord: z.boolean(),
    staff: staffRowSchema.nullable(),
    balances: z.array(leaveBalanceSchema),
    leave: z.array(leaveRowSchema),
    payslips: z.array(payslipRowSchema),
  })
  .meta({ id: 'HrMyEmployment' })

export type StaffRow = z.infer<typeof staffRowSchema>
export type LeaveRow = z.infer<typeof leaveRowSchema>
export type LeaveBalance = z.infer<typeof leaveBalanceSchema>
export type PayslipRow = z.infer<typeof payslipRowSchema>
export type PayrollRun = z.infer<typeof payrollRunSchema>
export type MyEmployment = z.infer<typeof myEmploymentSchema>
