import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'

/**
 * HR and payroll.
 *
 * `dependsOn: []` on purpose, and it shows in the schema: nothing here
 * references a department, a programme or an offering. A staff member can exist
 * without ever teaching a section -- a cook, a driver, a lab assistant -- and
 * an institution that has bought nothing else should still be able to run its
 * payroll.
 *
 * The link to `users` is therefore optional. Plenty of staff never sign in.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

const pk = () => uuid().primaryKey().defaultRandom()
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

const paise = (name: string) => bigint(name, { mode: 'number' })

export const employmentEnum = pgEnum('hr_employment', [
  'permanent',
  'contract',
  'visiting',
  'probation',
])

export const leaveStatusEnum = pgEnum('hr_leave_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
])

/** An earning adds to gross; a deduction subtracts from it. Nothing else. */
export const componentKindEnum = pgEnum('hr_component_kind', ['earning', 'deduction'])

// --- people ----------------------------------------------------------------

export const staff = pgTable(
  'hr_staff',
  {
    id: pk(),
    institutionId: tenantId(),
    /** Optional: a cook needs a payslip, not a login. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    employeeCode: text('employee_code').notNull(),
    name: text().notNull(),
    designation: text().notNull(),
    /** Free text, not a foreign key: HR depends on no other module. */
    department: text(),
    /** Optional: plenty of colleges run one flat scale and never name a grade. */
    gradeId: uuid('grade_id').references(() => employeeGrades.id, { onDelete: 'set null' }),
    employment: employmentEnum().notNull().default('permanent'),
    joinedOn: date('joined_on').notNull(),
    leftOn: date('left_on'),
    email: text(),
    phone: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hr_staff_code').on(t.institutionId, t.employeeCode),
    // One staff record per login, when there is a login at all.
    uniqueIndex('hr_staff_user')
      .on(t.institutionId, t.userId)
      .where(sql`user_id is not null`),
    index('hr_staff_active').on(t.institutionId, t.leftOn),
    check('hr_staff_code_shape', sql`length(trim(employee_code)) > 0`),
    check('hr_staff_dates', sql`left_on is null or left_on >= joined_on`),
    tenantPolicy('hr_staff'),
  ],
)

// --- leave -----------------------------------------------------------------

export const leaveTypes = pgTable(
  'hr_leave_types',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    /** Entitlement per calendar year. Zero means unlimited but still recorded. */
    annualDays: smallint('annual_days').notNull().default(0),
    /** Unpaid leave still needs approval; it just stops the salary. */
    paid: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hr_leave_types_code').on(t.institutionId, t.code),
    check('hr_leave_types_days', sql`annual_days between 0 and 365`),
    tenantPolicy('hr_leave_types'),
  ],
)

/**
 * A request, then an approval. The workflow is the point: the spec asks for
 * leave management *with* an approval step, and an auto-approved request is a
 * calendar entry, not a workflow.
 *
 * Overlapping approved leave for one person is refused by an exclusion
 * constraint in the migration -- two approvals cannot disagree about a day.
 */
export const leaveRequests = pgTable(
  'hr_leave_requests',
  {
    id: pk(),
    institutionId: tenantId(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id, { onDelete: 'restrict' }),
    fromOn: date('from_on').notNull(),
    toOn: date('to_on').notNull(),
    reason: text().notNull(),
    status: leaveStatusEnum().notNull().default('pending'),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('hr_leave_requests_staff').on(t.staffId, t.status),
    index('hr_leave_requests_pending').on(t.institutionId, t.status),
    check('hr_leave_requests_dates', sql`to_on >= from_on`),
    check('hr_leave_requests_reason', sql`length(trim(reason)) >= 5`),
    check(
      'hr_leave_requests_decided',
      sql`(status = 'pending' and decided_at is null)
          or (status <> 'pending' and decided_at is not null)`,
    ),
    tenantPolicy('hr_leave_requests'),
  ],
)

// --- pay -------------------------------------------------------------------

/**
 * One line of somebody's pay, valid over a period. Modelled as dated rows
 * rather than a single "current salary" column so a raise in August does not
 * silently rewrite July's payslip, and so the history answers "what were they
 * on last year" without an audit log.
 *
 * Overlapping periods for the same component on the same person are refused by
 * an exclusion constraint.
 */
export const payComponents = pgTable(
  'hr_pay_components',
  {
    id: pk(),
    institutionId: tenantId(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    code: text().notNull(),
    label: text().notNull(),
    kind: componentKindEnum().notNull(),
    amountPaise: paise('amount_paise').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    createdAt: createdAt(),
  },
  (t) => [
    index('hr_pay_components_staff').on(t.staffId, t.effectiveFrom),
    check('hr_pay_components_amount', sql`amount_paise > 0`),
    check(
      'hr_pay_components_dates',
      sql`effective_to is null or effective_to >= effective_from`,
    ),
    check('hr_pay_components_code', sql`length(trim(code)) > 0`),
    tenantPolicy('hr_pay_components'),
  ],
)

/**
 * A generated payslip. `lines` is a snapshot, not a join: a payslip is a
 * document of record, and it must read the same next year when the component
 * rows behind it have been superseded, corrected or deleted.
 *
 * No statutory tax computation, per the spec -- the figures are generated and
 * the institution's accountant files on them.
 */
export const payslips = pgTable(
  'hr_payslips',
  {
    id: pk(),
    institutionId: tenantId(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    /** First day of the month it covers. A month is the unit; a date is storable. */
    period: date().notNull(),
    grossPaise: paise('gross_paise').notNull(),
    deductionsPaise: paise('deductions_paise').notNull(),
    netPaise: paise('net_paise').notNull(),
    /** Days of unpaid leave that reduced this payslip, and by how much. */
    unpaidLeaveDays: smallint('unpaid_leave_days').notNull().default(0),
    lossOfPayPaise: paise('loss_of_pay_paise').notNull().default(0),
    lines: jsonb().notNull(),
    generatedBy: text('generated_by').references(() => users.id, { onDelete: 'set null' }),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hr_payslips_once').on(t.staffId, t.period),
    index('hr_payslips_period').on(t.institutionId, t.period),
    check('hr_payslips_amounts', sql`gross_paise >= 0 and deductions_paise >= 0`),
    check('hr_payslips_net', sql`net_paise = gross_paise - deductions_paise`),
    check('hr_payslips_period_start', sql`extract(day from period) = 1`),
    tenantPolicy('hr_payslips'),
  ],
)

// --- paying ----------------------------------------------------------------

/**
 * The month's salaries actually leaving the bank.
 *
 * Separate from the payslips on purpose, and it is the whole reason the books
 * carry a salaries-payable account: March's payroll is a cost of March however
 * late in April it is paid, and an institution reading its March expenses
 * should see it there rather than wherever the transfer happened to clear.
 *
 * One payment per period. A month paid in two instalments is a real thing and
 * not one this handles; the module refuses the second rather than half-recording
 * it.
 */
export const salaryPayments = pgTable(
  'hr_salary_payments',
  {
    id: pk(),
    institutionId: tenantId(),
    /** The month being paid for, not the month it was paid in. */
    period: date().notNull(),
    paidOn: date('paid_on').notNull(),
    amountPaise: paise('amount_paise').notNull(),
    /** Which asset it left from. Only the two the chart has accounts for. */
    paidFrom: text('paid_from').notNull().default('bank'),
    reference: text(),
    paidBy: text('paid_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hr_salary_payments_once').on(t.institutionId, t.period),
    check('hr_salary_payments_amount', sql`amount_paise > 0`),
    check('hr_salary_payments_route', sql`paid_from in ('bank', 'cash')`),
    check('hr_salary_payments_period', sql`extract(day from period) = 1`),
    tenantPolicy('hr_salary_payments'),
  ],
)

export type Staff = typeof staff.$inferSelect
export type LeaveType = typeof leaveTypes.$inferSelect
export type LeaveRequest = typeof leaveRequests.$inferSelect
export type PayComponent = typeof payComponents.$inferSelect
export type Payslip = typeof payslips.$inferSelect
export type SalaryPayment = typeof salaryPayments.$inferSelect

// --- employment lifecycle --------------------------------------------------

/**
 * How an employment ended.
 *
 * An enum rather than free text, because the answer drives real questions
 * later -- who may be rehired, what notice was owed, which separations an
 * audit wants to see -- and a column holding "resgined", "Resignation" and
 * "left" answers none of them.
 */
export const separationKindEnum = pgEnum('hr_separation_kind', [
  'resignation',
  'retirement',
  'termination',
  'end_of_contract',
  'death',
  'other',
])

/** What changed about somebody's employment, on the day it changed. */
export const employmentChangeEnum = pgEnum('hr_employment_change', [
  'transfer',
  'promotion',
  'confirmation',
  'grade_change',
  'separation',
])

/**
 * A pay grade.
 *
 * Its band is advisory, not enforced: a college that hires one person outside
 * its own scale has made a decision, and a database that refuses to record what
 * it did only means the real figure lives in a spreadsheet instead. The screen
 * says the band was exceeded; the row stands.
 */
export const employeeGrades = pgTable(
  'hr_employee_grades',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    /** Lower is junior. What makes "is this a promotion" answerable. */
    rank: smallint().notNull().default(0),
    minPaise: paise('min_paise'),
    maxPaise: paise('max_paise'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hr_employee_grades_code').on(t.institutionId, t.code),
    index('hr_employee_grades_rank').on(t.institutionId, t.rank),
    check('hr_employee_grades_code_shape', sql`length(trim(code)) > 0`),
    check('hr_employee_grades_rank', sql`rank between 0 and 999`),
    check(
      'hr_employee_grades_band',
      sql`min_paise is null or max_paise is null or max_paise >= min_paise`,
    ),
    tenantPolicy('hr_employee_grades'),
  ],
)

/**
 * The checklist a new joiner is put through, as a reusable template.
 *
 * The template and the activities it produces are separate tables on purpose:
 * editing the template must not rewrite what somebody who joined in March was
 * actually asked to do.
 */
export const onboardingTemplates = pgTable(
  'hr_onboarding_templates',
  {
    id: pk(),
    institutionId: tenantId(),
    code: text().notNull(),
    name: text().notNull(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hr_onboarding_templates_code').on(t.institutionId, t.code),
    check('hr_onboarding_templates_code_shape', sql`length(trim(code)) > 0`),
    tenantPolicy('hr_onboarding_templates'),
  ],
)

export const onboardingTemplateActivities = pgTable(
  'hr_onboarding_template_activities',
  {
    id: pk(),
    institutionId: tenantId(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => onboardingTemplates.id, { onDelete: 'cascade' }),
    seq: smallint().notNull(),
    title: text().notNull(),
    /** The desk that owns the step: "IT", "Accounts", "Head of department". */
    owner: text().notNull(),
    /** Days from the joining date. Negative is ordinary: a laptop is ordered first. */
    dueDayOffset: smallint('due_day_offset').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hr_onboarding_template_activities_seq').on(t.templateId, t.seq),
    check('hr_onboarding_template_activities_range', sql`seq between 1 and 200`),
    check('hr_onboarding_template_activities_offset', sql`due_day_offset between -365 and 365`),
    check('hr_onboarding_template_activities_title', sql`length(trim(title)) > 0`),
    tenantPolicy('hr_onboarding_template_activities'),
  ],
)

/**
 * One person's run through a checklist.
 *
 * The template's code and name are copied rather than joined, so a template
 * renamed or deleted next year does not change what this says happened.
 */
export const onboardings = pgTable(
  'hr_onboardings',
  {
    id: pk(),
    institutionId: tenantId(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    templateCode: text('template_code').notNull(),
    templateName: text('template_name').notNull(),
    startedOn: date('started_on').notNull(),
    /** Set by a trigger when the last activity is done. Never written by hand. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hr_onboardings_once').on(t.staffId),
    index('hr_onboardings_open').on(t.institutionId, t.completedAt),
    tenantPolicy('hr_onboardings'),
  ],
)

export const onboardingActivities = pgTable(
  'hr_onboarding_activities',
  {
    id: pk(),
    institutionId: tenantId(),
    onboardingId: uuid('onboarding_id')
      .notNull()
      .references(() => onboardings.id, { onDelete: 'cascade' }),
    seq: smallint().notNull(),
    title: text().notNull(),
    owner: text().notNull(),
    dueOn: date('due_on').notNull(),
    doneAt: timestamp('done_at', { withTimezone: true }),
    doneBy: text('done_by').references(() => users.id, { onDelete: 'set null' }),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hr_onboarding_activities_seq').on(t.onboardingId, t.seq),
    index('hr_onboarding_activities_open').on(t.institutionId, t.doneAt),
    tenantPolicy('hr_onboarding_activities'),
  ],
)

/**
 * Everything that ever changed about somebody's post, as dated rows.
 *
 * `hr_staff` carries where they are now; this carries how they got there. A
 * promotion is not an UPDATE that loses the previous designation -- "what were
 * they when they signed that" is a question with legal weight, and answering it
 * out of an audit log is answering it from the wrong place.
 *
 * The from-columns are a snapshot taken at the moment of the change, so the
 * history still reads correctly after a grade is renamed or removed.
 */
export const employmentChanges = pgTable(
  'hr_employment_changes',
  {
    id: pk(),
    institutionId: tenantId(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    kind: employmentChangeEnum().notNull(),
    effectiveOn: date('effective_on').notNull(),
    fromDesignation: text('from_designation'),
    toDesignation: text('to_designation'),
    fromDepartment: text('from_department'),
    toDepartment: text('to_department'),
    fromGrade: text('from_grade'),
    toGradeId: uuid('to_grade_id').references(() => employeeGrades.id, {
      onDelete: 'set null',
    }),
    toGrade: text('to_grade'),
    fromEmployment: employmentEnum('from_employment'),
    toEmployment: employmentEnum('to_employment'),
    reason: text().notNull(),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('hr_employment_changes_staff').on(t.staffId, t.effectiveOn),
    index('hr_employment_changes_when').on(t.institutionId, t.effectiveOn),
    check('hr_employment_changes_reason', sql`length(trim(reason)) >= 5`),
    check(
      'hr_employment_changes_something',
      sql`kind = 'separation'
          or to_designation is not null
          or to_department is not null
          or to_grade_id is not null
          or to_employment is not null`,
    ),
    tenantPolicy('hr_employment_changes'),
  ],
)

/**
 * The end of an employment, and the conversation that follows it.
 *
 * One per staff record: somebody rehired is a new employment and a new record,
 * because their leave balance, their grade and their notice period all start
 * again.
 *
 * The exit interview is nullable because it happens after the decision and
 * sometimes never happens at all. The row it attaches to exists from the day
 * the separation is recorded, so an interview nobody held is visible rather
 * than absent.
 */
export const separations = pgTable(
  'hr_separations',
  {
    id: pk(),
    institutionId: tenantId(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    changeId: uuid('change_id').references(() => employmentChanges.id, {
      onDelete: 'set null',
    }),
    kind: separationKindEnum().notNull(),
    noticeGivenOn: date('notice_given_on'),
    lastDayOn: date('last_day_on').notNull(),
    reason: text().notNull(),
    exitInterviewOn: date('exit_interview_on'),
    exitInterviewBy: text('exit_interview_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    exitInterviewNotes: text('exit_interview_notes'),
    /** Unknown until somebody has actually asked. Null is a real answer here. */
    rehireEligible: boolean('rehire_eligible'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hr_separations_once').on(t.staffId),
    index('hr_separations_when').on(t.institutionId, t.lastDayOn),
    check('hr_separations_reason', sql`length(trim(reason)) >= 5`),
    check(
      'hr_separations_notice',
      sql`notice_given_on is null or notice_given_on <= last_day_on`,
    ),
    check(
      'hr_separations_interview',
      sql`(exit_interview_on is null) = (exit_interview_notes is null)`,
    ),
    tenantPolicy('hr_separations'),
  ],
)

export type EmployeeGrade = typeof employeeGrades.$inferSelect
export type OnboardingTemplate = typeof onboardingTemplates.$inferSelect
export type OnboardingTemplateActivity = typeof onboardingTemplateActivities.$inferSelect
export type Onboarding = typeof onboardings.$inferSelect
export type OnboardingActivity = typeof onboardingActivities.$inferSelect
export type EmploymentChange = typeof employmentChanges.$inferSelect
export type Separation = typeof separations.$inferSelect
