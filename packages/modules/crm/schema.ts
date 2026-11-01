import { sql } from 'drizzle-orm'
import { bigint, check, date, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'
import { orders, parties } from '@campusos/module-finance/schema'

const tenantId = () => uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const stages = pgTable('crm_stages', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), name: text().notNull(), seq: integer().notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }), createdAt: createdAt(),
}, table => [
  uniqueIndex('crm_stages_name').on(table.institutionId, table.name), uniqueIndex('crm_stages_tenant_id').on(table.institutionId, table.id),
  check('crm_stage_name_text', sql`length(trim(name)) between 1 and 60`), check('crm_stage_seq', sql`seq between 1 and 999`), tenantPolicy('crm_stages'),
])
export const lostReasons = pgTable('crm_lost_reasons', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), name: text().notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }), createdAt: createdAt(),
}, table => [
  uniqueIndex('crm_lost_reasons_name').on(table.institutionId, table.name), uniqueIndex('crm_lost_reasons_tenant_id').on(table.institutionId, table.id),
  check('crm_lost_reason_name_text', sql`length(trim(name)) between 2 and 120`), tenantPolicy('crm_lost_reasons'),
])
export const teams = pgTable('crm_teams', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), name: text().notNull(), managerId: text('manager_id').notNull().references(() => users.id), createdAt: createdAt(),
}, table => [
  uniqueIndex('crm_teams_name').on(table.institutionId, table.name), uniqueIndex('crm_teams_tenant_id').on(table.institutionId, table.id),
  index('crm_teams_manager').on(table.institutionId, table.managerId), check('crm_team_name_text', sql`length(trim(name)) between 2 and 80`), tenantPolicy('crm_teams'),
])
export const teamMembers = pgTable('crm_team_members', {
  institutionId: tenantId(), teamId: uuid('team_id').notNull(), userId: text('user_id').notNull().references(() => users.id), createdAt: createdAt(),
}, table => [
  primaryKey({ columns: [table.teamId, table.userId] }),
  foreignKey({ columns: [table.institutionId, table.teamId], foreignColumns: [teams.institutionId, teams.id] }).onDelete('cascade'),
  uniqueIndex('crm_team_members_user').on(table.institutionId, table.userId), tenantPolicy('crm_team_members'),
])
export const leads = pgTable('crm_leads', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), kind: text().notNull().default('lead'), status: text().notNull().default('open'),
  title: text().notNull(), company: text(), contactName: text('contact_name'), email: text(), phone: text(), gstin: text(), source: text().notNull(), notes: text(),
  ownerId: text('owner_id').notNull().references(() => users.id), stageId: uuid('stage_id'), itemId: uuid('item_id'),
  expectedValuePaise: bigint('expected_value_paise', { mode: 'number' }), expectedClose: date('expected_close'),
  lostReasonId: uuid('lost_reason_id'), lostNote: text('lost_note'),
  wonAt: timestamp('won_at', { withTimezone: true }), closedAt: timestamp('closed_at', { withTimezone: true }),
  partyId: uuid('party_id').references(() => parties.id), quotationId: uuid('quotation_id').references(() => orders.id, { onDelete: 'set null' }),
  convertedAt: timestamp('converted_at', { withTimezone: true }), erasedAt: timestamp('erased_at', { withTimezone: true }),
  createdBy: text('created_by').notNull().references(() => users.id), createdAt: createdAt(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  foreignKey({ columns: [table.institutionId, table.stageId], foreignColumns: [stages.institutionId, stages.id] }),
  foreignKey({ columns: [table.institutionId, table.lostReasonId], foreignColumns: [lostReasons.institutionId, lostReasons.id] }),
  uniqueIndex('crm_leads_tenant_id').on(table.institutionId, table.id), index('crm_leads_owner').on(table.institutionId, table.ownerId, table.status), index('crm_leads_updated').on(table.institutionId, table.updatedAt),
  check('crm_lead_kind', sql`kind in ('lead','opportunity')`), check('crm_lead_status', sql`status in ('open','won','lost')`),
  check('crm_lead_source', sql`source in ('website','referral','event','cold_call','existing_customer','other')`),
  check('crm_lead_stage', sql`(kind = 'lead') = (stage_id is null)`), check('crm_lead_won', sql`status <> 'won' or (kind = 'opportunity' and won_at is not null)`),
  check('crm_lead_lost', sql`(status = 'lost') = (lost_reason_id is not null)`), check('crm_lead_converted', sql`party_id is null or (status = 'won' and converted_at is not null)`),
  check('crm_lead_value', sql`expected_value_paise is null or expected_value_paise >= 0`),
  check('crm_lead_gstin', sql`gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$'`), tenantPolicy('crm_leads'),
])
export const activities = pgTable('crm_activities', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), leadId: uuid('lead_id').notNull(), kind: text().notNull(), summary: text().notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(), remindAt: timestamp('remind_at', { withTimezone: true }), assigneeId: text('assignee_id').notNull().references(() => users.id),
  doneAt: timestamp('done_at', { withTimezone: true }), remindedAt: timestamp('reminded_at', { withTimezone: true }), createdBy: text('created_by').notNull().references(() => users.id), createdAt: createdAt(),
}, table => [
  foreignKey({ columns: [table.institutionId, table.leadId], foreignColumns: [leads.institutionId, leads.id] }).onDelete('cascade'),
  index('crm_activities_lead').on(table.institutionId, table.leadId),
  index('crm_activities_due_reminders').on(table.remindAt).where(sql`reminded_at IS NULL AND done_at IS NULL AND remind_at IS NOT NULL`),
  check('crm_activity_kind', sql`kind in ('call','meeting','task')`), check('crm_activity_summary', sql`length(summary) between 1 and 500`),
  check('crm_activity_remind', sql`remind_at is null or remind_at <= due_at`), tenantPolicy('crm_activities'),
])
