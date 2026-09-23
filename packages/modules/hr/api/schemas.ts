import * as z from 'zod'
import { parseRupeesToPaise } from '@campusos/money'
import {
  componentKindEnum,
  employmentChangeEnum,
  employmentEnum,
  leaveStatusEnum,
  separationKindEnum,
} from '../schema'

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
    allowNegative: z.coerce.boolean().default(false),
    encashable: z.coerce.boolean().default(false),
    /** Pay component codes a day of this leave is worth, when paid out. */
    encashmentComponents: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
    maxCarryForward: z.coerce.number().int().min(0).max(365).default(0),
    compensatory: z.coerce.boolean().default(false),
    compOffValidityDays: z.coerce.number().int().min(1).max(365).nullish(),
  })
  .refine((d) => !d.encashable || d.encashmentComponents.length > 0, {
    message: 'an encashable leave type has to say which pay components a day is worth',
    path: ['encashmentComponents'],
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
    encashedDays: z.number().int(),
    /** Null when the type is unlimited but still recorded. */
    remainingDays: z.number().int().nullable(),
    /** True once allocations exist: the balance is theirs, not the type default. */
    managed: z.boolean(),
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

// --- the employment lifecycle ----------------------------------------------

const optionalRupees = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined || v === '') return null
    const paise = parseRupeesToPaise(v)
    if (paise === null) {
      ctx.addIssue({ code: 'custom', message: 'not a valid rupee amount' })
      return z.NEVER
    }
    return paise
  })

export const createGradeSchema = z
  .object({
    code: z.string().trim().min(1).max(30),
    name: z.string().trim().min(1).max(120),
    /** Lower is junior. What makes "is this a promotion" answerable. */
    rank: z.coerce.number().int().min(0).max(999).default(0),
    minPaise: optionalRupees,
    maxPaise: optionalRupees,
  })
  .meta({ id: 'HrGradeCreate' })

export const createOnboardingTemplateSchema = z
  .object({
    code: z.string().trim().min(1).max(30),
    name: z.string().trim().min(1).max(120),
    note: z.string().trim().max(500).nullish(),
    activities: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(200),
          /** The desk that owns the step: "IT", "Accounts", "Head of department". */
          owner: z.string().trim().min(1).max(120),
          /** Days from the joining date. Negative is ordinary. */
          dueDayOffset: z.coerce.number().int().min(-365).max(365).default(0),
        }),
      )
      .min(1)
      .max(200),
  })
  .meta({ id: 'HrOnboardingTemplateCreate' })

export const startOnboardingSchema = z
  .object({
    staffId: uuid,
    templateId: uuid,
    startedOn: day.nullish(),
  })
  .meta({ id: 'HrOnboardingStart' })

export const completeActivitySchema = z
  .object({
    activityId: uuid,
    note: z.string().trim().max(500).nullish(),
  })
  .meta({ id: 'HrOnboardingActivityComplete' })

/**
 * A transfer, a promotion, a confirmation off probation, a change of grade.
 *
 * Every field but the reason is optional, and what is omitted does not move: a
 * transfer between departments leaves the designation exactly where it was.
 */
export const recordChangeSchema = z
  .object({
    staffId: uuid,
    kind: z.enum(['transfer', 'promotion', 'confirmation', 'grade_change']),
    effectiveOn: day,
    toDesignation: z.string().trim().min(1).max(120).nullish(),
    toDepartment: z.string().trim().min(1).max(120).nullish(),
    toGradeId: uuid.nullish(),
    toEmployment: z.enum(employmentEnum.enumValues).nullish(),
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'HrEmploymentChange' })

export const separateSchema = z
  .object({
    staffId: uuid,
    kind: z.enum(separationKindEnum.enumValues),
    lastDayOn: day,
    noticeGivenOn: day.nullish(),
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'HrSeparate' })

export const recordExitInterviewSchema = z
  .object({
    staffId: uuid,
    on: day,
    notes: z.string().trim().min(5).max(4000),
    /** Null is a real answer: asked, and not decided. */
    rehireEligible: z.coerce.boolean().nullish().default(null),
  })
  .meta({ id: 'HrExitInterview' })

// --- reads -----------------------------------------------------------------

export const gradeRowSchema = z
  .object({
    id: uuid,
    code: z.string(),
    name: z.string(),
    rank: z.number().int(),
    minPaise: z.number().int().nullable(),
    maxPaise: z.number().int().nullable(),
    people: z.number().int(),
  })
  .meta({ id: 'HrGrade' })

export const onboardingActivityRowSchema = z
  .object({
    id: uuid,
    seq: z.number().int(),
    title: z.string(),
    owner: z.string(),
    dueOn: z.string(),
    doneAt: z.string().nullable(),
    note: z.string().nullable(),
    overdue: z.boolean(),
  })
  .meta({ id: 'HrOnboardingActivity' })

export const onboardingViewSchema = z
  .object({
    id: uuid,
    staffId: uuid,
    templateCode: z.string(),
    templateName: z.string(),
    startedOn: z.string(),
    completedAt: z.string().nullable(),
    outstanding: z.number().int(),
    activities: z.array(onboardingActivityRowSchema),
  })
  .meta({ id: 'HrOnboarding' })

export const changeRowSchema = z
  .object({
    id: uuid,
    staffId: uuid,
    staffName: z.string(),
    employeeCode: z.string(),
    kind: z.enum(employmentChangeEnum.enumValues),
    effectiveOn: z.string(),
    fromDesignation: z.string().nullable(),
    toDesignation: z.string().nullable(),
    fromDepartment: z.string().nullable(),
    toDepartment: z.string().nullable(),
    fromGrade: z.string().nullable(),
    toGrade: z.string().nullable(),
    fromEmployment: z.enum(employmentEnum.enumValues).nullable(),
    toEmployment: z.enum(employmentEnum.enumValues).nullable(),
    reason: z.string(),
  })
  .meta({ id: 'HrEmploymentChangeRow' })

export const separationRowSchema = z
  .object({
    id: uuid,
    staffId: uuid,
    staffName: z.string(),
    employeeCode: z.string(),
    kind: z.enum(separationKindEnum.enumValues),
    noticeGivenOn: z.string().nullable(),
    lastDayOn: z.string(),
    reason: z.string(),
    exitInterviewOn: z.string().nullable(),
    exitInterviewNotes: z.string().nullable(),
    rehireEligible: z.boolean().nullable(),
    interviewPending: z.boolean(),
  })
  .meta({ id: 'HrSeparation' })

export type GradeRow = z.infer<typeof gradeRowSchema>
export type OnboardingActivityRow = z.infer<typeof onboardingActivityRowSchema>
export type OnboardingView = z.infer<typeof onboardingViewSchema>
export type ChangeRow = z.infer<typeof changeRowSchema>
export type SeparationRow = z.infer<typeof separationRowSchema>

// --- leave, as policy ------------------------------------------------------

const year = z.coerce.number().int().min(2000).max(2100)

export const createLeavePolicySchema = z
  .object({
    code: z.string().trim().min(1).max(30),
    name: z.string().trim().min(1).max(120),
    prorateJoiners: z.coerce.boolean().default(false),
    lines: z
      .array(
        z.object({
          leaveTypeId: uuid,
          annualDays: z.coerce.number().int().min(1).max(365),
        }),
      )
      .min(1)
      .max(50),
  })
  .meta({ id: 'HrLeavePolicyCreate' })

export const assignPolicySchema = z
  .object({
    staffId: uuid,
    policyId: uuid,
    effectiveFrom: day,
  })
  .meta({ id: 'HrLeavePolicyAssign' })

/** Materialise a year's allocations from the policies in force, idempotently. */
export const allocateYearSchema = z
  .object({ year, staffId: uuid.nullish() })
  .meta({ id: 'HrLeaveAllocateYear' })

export const manualAllocationSchema = z
  .object({
    staffId: uuid,
    leaveTypeId: uuid,
    year,
    days: z.coerce.number().int().min(1).max(365),
    expiresOn: day.nullish(),
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'HrLeaveAllocateManual' })

export const requestCompOffSchema = z
  .object({
    staffId: uuid,
    leaveTypeId: uuid,
    workedOn: day,
    days: z.coerce.number().int().min(1).max(2).default(1),
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'HrCompOffRequest' })

export const decideCompOffSchema = z
  .object({
    requestId: uuid,
    approve: z.coerce.boolean(),
    note: z.string().trim().max(500).nullish(),
  })
  .meta({ id: 'HrCompOffDecide' })

export const requestEncashmentSchema = z
  .object({
    staffId: uuid,
    leaveTypeId: uuid,
    year,
    days: z.coerce.number().int().min(1).max(365),
    /** The payroll month it should be paid in. */
    period,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'HrEncashmentRequest' })

export const decideEncashmentSchema = z
  .object({
    requestId: uuid,
    approve: z.coerce.boolean(),
  })
  .meta({ id: 'HrEncashmentDecide' })

// --- shifts ----------------------------------------------------------------

const clock = z
  .string()
  .trim()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'expected HH:MM, 24-hour')

export const createShiftTypeSchema = z
  .object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(120),
    startsAt: clock,
    endsAt: clock,
    breakMinutes: z.coerce.number().int().min(0).max(240).default(0),
    /** Rupees per day actually worked on this shift. */
    allowance: rupees.default(0),
  })
  .refine((d) => d.startsAt !== d.endsAt, {
    message: 'a shift has to last some time',
    path: ['endsAt'],
  })
  .meta({ id: 'HrShiftTypeCreate' })

export const assignShiftSchema = z
  .object({
    staffId: uuid,
    shiftTypeId: uuid,
    fromOn: day,
    /** Omitted: until further notice. */
    toOn: day.nullish(),
  })
  .meta({ id: 'HrShiftAssign' })

export const rotateShiftsSchema = z
  .object({
    staffIds: z.array(uuid).min(1).max(200),
    shiftTypeIds: z.array(uuid).min(2).max(10),
    fromOn: day,
    weeks: z.coerce.number().int().min(1).max(26),
  })
  .meta({ id: 'HrShiftRotate' })

export const requestShiftSchema = z
  .object({
    staffId: uuid,
    shiftTypeId: uuid,
    fromOn: day,
    toOn: day,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'HrShiftRequest' })

export const decideShiftSchema = z
  .object({
    requestId: uuid,
    approve: z.coerce.boolean(),
    note: z.string().trim().max(500).nullish(),
  })
  .meta({ id: 'HrShiftDecide' })
