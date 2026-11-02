import { bigint, boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { idempotencyKeysTable, institutions, tenantPolicy, users } from '@campusos/db'

// The checks, composite foreign keys and triggers live in migrations/0000_projects.sql, which is the source of truth.

const tenantId = () => uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' })
const at = (name: string) => timestamp(name, { withTimezone: true })
const userId = (name: string) => text(name).references(() => users.id)

export const projects = pgTable('projects_projects', {
  id: uuid().primaryKey().defaultRandom(),
  institutionId: tenantId(),
  code: text().notNull(),
  name: text().notNull(),
  description: text(),
  managerId: userId('manager_id').notNull(),
  costCenter: text('cost_center').notNull(),
  partyId: uuid('party_id'),
  billable: boolean().notNull().default(false),
  billingRatePaise: bigint('billing_rate_paise', { mode: 'number' }),
  taxTemplateId: uuid('tax_template_id'),
  fundId: uuid('fund_id'),
  startsOn: date('starts_on', { mode: 'string' }).notNull(),
  endsOn: date('ends_on', { mode: 'string' }),
  status: text().notNull().default('active'),
  createdBy: userId('created_by').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('projects_projects_tenant_id').on(t.institutionId, t.id),
  uniqueIndex('projects_projects_code').on(t.institutionId, t.code),
  uniqueIndex('projects_projects_cost_center').on(t.institutionId, t.costCenter),
  tenantPolicy('projects_projects'),
])

export const members = pgTable('projects_members', {
  id: uuid().primaryKey().defaultRandom(),
  institutionId: tenantId(),
  projectId: uuid('project_id').notNull(),
  userId: userId('user_id').notNull(),
  addedBy: userId('added_by').notNull(),
  addedAt: at('added_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('projects_members_person').on(t.institutionId, t.projectId, t.userId),
  tenantPolicy('projects_members'),
])

export const stages = pgTable('projects_stages', {
  id: uuid().primaryKey().defaultRandom(),
  institutionId: tenantId(),
  projectId: uuid('project_id').notNull(),
  name: text().notNull(),
  seq: integer().notNull(),
  closes: boolean().notNull().default(false),
}, (t) => [
  uniqueIndex('projects_stages_tenant_id').on(t.institutionId, t.projectId, t.id),
  uniqueIndex('projects_stages_name').on(t.institutionId, t.projectId, t.name),
  tenantPolicy('projects_stages'),
])

export const milestones = pgTable('projects_milestones', {
  id: uuid().primaryKey().defaultRandom(),
  institutionId: tenantId(),
  projectId: uuid('project_id').notNull(),
  name: text().notNull(),
  dueOn: date('due_on', { mode: 'string' }),
  reachedOn: date('reached_on', { mode: 'string' }),
  reachedBy: userId('reached_by'),
}, (t) => [
  uniqueIndex('projects_milestones_tenant_id').on(t.institutionId, t.projectId, t.id),
  uniqueIndex('projects_milestones_name').on(t.institutionId, t.projectId, t.name),
  tenantPolicy('projects_milestones'),
])

export const tasks = pgTable('projects_tasks', {
  id: uuid().primaryKey().defaultRandom(),
  institutionId: tenantId(),
  projectId: uuid('project_id').notNull(),
  stageId: uuid('stage_id').notNull(),
  milestoneId: uuid('milestone_id'),
  title: text().notNull(),
  description: text(),
  assigneeId: userId('assignee_id'),
  deadline: date({ mode: 'string' }),
  createdBy: userId('created_by').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('projects_tasks_tenant_id').on(t.institutionId, t.projectId, t.id),
  index('projects_tasks_list').on(t.institutionId, t.projectId, t.createdAt, t.id),
  tenantPolicy('projects_tasks'),
])

export const costRates = pgTable('projects_cost_rates', {
  id: uuid().primaryKey().defaultRandom(),
  institutionId: tenantId(),
  userId: userId('user_id').notNull(),
  effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
  hourlyCostPaise: bigint('hourly_cost_paise', { mode: 'number' }).notNull(),
  homeCostCenter: text('home_cost_center'),
  createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('projects_cost_rates_day').on(t.institutionId, t.userId, t.effectiveFrom),
  tenantPolicy('projects_cost_rates'),
])

export const billings = pgTable('projects_billings', {
  id: uuid().primaryKey(),
  institutionId: tenantId(),
  projectId: uuid('project_id').notNull(),
  through: date({ mode: 'string' }).notNull(),
  billedOn: date('billed_on', { mode: 'string' }).notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  minutes: integer().notNull(),
  billedBy: userId('billed_by').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('projects_billings_tenant_id').on(t.institutionId, t.projectId, t.id),
  uniqueIndex('projects_billings_invoice').on(t.invoiceId),
  tenantPolicy('projects_billings'),
])

export const costings = pgTable('projects_costings', {
  id: uuid().primaryKey(),
  institutionId: tenantId(),
  projectId: uuid('project_id').notNull(),
  period: text().notNull(),
  postedOn: date('posted_on', { mode: 'string' }).notNull(),
  entryId: uuid('entry_id').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  minutes: integer().notNull(),
  costedBy: userId('costed_by').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  reversedAt: at('reversed_at'),
  reversedBy: userId('reversed_by'),
  reversalEntryId: uuid('reversal_entry_id'),
  reverseReason: text('reverse_reason'),
}, (t) => [
  uniqueIndex('projects_costings_tenant_id').on(t.institutionId, t.projectId, t.id),
  uniqueIndex('projects_costings_entry').on(t.entryId),
  tenantPolicy('projects_costings'),
])

export const timesheets = pgTable('projects_timesheets', {
  id: uuid().primaryKey().defaultRandom(),
  institutionId: tenantId(),
  projectId: uuid('project_id').notNull(),
  taskId: uuid('task_id').notNull(),
  userId: userId('user_id').notNull(),
  workDate: date('work_date', { mode: 'string' }).notNull(),
  minutes: integer().notNull(),
  description: text().notNull(),
  status: text().notNull().default('submitted'),
  enteredBy: userId('entered_by').notNull(),
  decidedBy: userId('decided_by'),
  decidedAt: at('decided_at'),
  decisionNote: text('decision_note'),
  billingId: uuid('billing_id'),
  costingId: uuid('costing_id'),
  costPaise: bigint('cost_paise', { mode: 'number' }),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
}, (t) => [
  index('projects_timesheets_project').on(t.institutionId, t.projectId, t.status),
  index('projects_timesheets_person').on(t.institutionId, t.userId, t.workDate),
  index('projects_timesheets_list').on(t.institutionId, t.workDate, t.createdAt, t.id),
  tenantPolicy('projects_timesheets'),
])

export const projectIdempotencyKeys = idempotencyKeysTable('projects_idempotency_keys')
