import { sql } from 'drizzle-orm'
import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'
import { programs } from '@campusos/module-academic/schema'

const id = () => uuid().primaryKey().defaultRandom()
const institutionId = () => uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const officers = pgTable('placement_officers', {
  id: id(), institutionId: institutionId(), userId: text('user_id').notNull().references(() => users.id), active: boolean().notNull().default(true),
}, (table) => [uniqueIndex('placement_officers_user').on(table.institutionId, table.userId), tenantPolicy('placement_officers')])

export const companies = pgTable('placement_companies', {
  id: id(), institutionId: institutionId(), name: text().notNull(), website: text(), createdAt: createdAt(),
}, (table) => [uniqueIndex('placement_companies_name').on(table.institutionId, table.name), tenantPolicy('placement_companies')])

export const drives = pgTable('placement_drives', {
  id: id(), institutionId: institutionId(), companyId: uuid('company_id').notNull().references(() => companies.id),
  programId: uuid('program_id').references(() => programs.id), title: text().notNull(),
  closesAt: timestamp('closes_at', { withTimezone: true }).notNull(), minCgpa: numeric('min_cgpa', { precision: 4, scale: 2 }).notNull().default('0'),
  maxBacklogs: integer('max_backlogs').notNull().default(0), status: text().notNull().default('draft'), createdAt: createdAt(),
}, () => [tenantPolicy('placement_drives')])

export const applications = pgTable('placement_applications', {
  id: id(), institutionId: institutionId(), driveId: uuid('drive_id').notNull().references(() => drives.id),
  studentId: text('student_id').notNull().references(() => users.id), status: text().notNull().default('applied'),
  eligibility: jsonb().$type<{ cgpa: number | null; backlogs: number; checkedAt: string }>().notNull(), createdAt: createdAt(),
}, (table) => [uniqueIndex('placement_applications_once').on(table.driveId, table.studentId), tenantPolicy('placement_applications')])

export const rounds = pgTable('placement_rounds', {
  id: id(), institutionId: institutionId(), driveId: uuid('drive_id').notNull().references(() => drives.id), name: text().notNull(), position: integer().notNull(),
}, (table) => [uniqueIndex('placement_rounds_order').on(table.driveId, table.position), tenantPolicy('placement_rounds')])

export const results = pgTable('placement_results', {
  id: id(), institutionId: institutionId(), applicationId: uuid('application_id').notNull().references(() => applications.id),
  roundId: uuid('round_id').notNull().references(() => rounds.id), outcome: text().notNull(), note: text().notNull(), createdAt: createdAt(),
}, (table) => [uniqueIndex('placement_results_once').on(table.applicationId, table.roundId), tenantPolicy('placement_results')])

export const offers = pgTable('placement_offers', {
  id: id(), institutionId: institutionId(), applicationId: uuid('application_id').notNull().references(() => applications.id),
  studentId: text('student_id').notNull().references(() => users.id), annualPaise: numeric('annual_paise', { precision: 15, scale: 0 }).notNull(),
  status: text().notNull().default('pending'), createdAt: createdAt(),
}, (table) => [
  uniqueIndex('placement_offers_application').on(table.applicationId),
  uniqueIndex('placement_offers_one_accepted').on(table.institutionId, table.studentId).where(sql`status = 'accepted'`),
  tenantPolicy('placement_offers'),
])
