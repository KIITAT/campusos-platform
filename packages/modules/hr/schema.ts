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

export type Staff = typeof staff.$inferSelect
export type LeaveType = typeof leaveTypes.$inferSelect
export type LeaveRequest = typeof leaveRequests.$inferSelect
export type PayComponent = typeof payComponents.$inferSelect
export type Payslip = typeof payslips.$inferSelect
