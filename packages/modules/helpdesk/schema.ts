import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'

const tenantId = () => uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' })
export const cases = pgTable('helpdesk_cases', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), reporterId: text('reporter_id').notNull().references(() => users.id), assigneeId: text('assignee_id').references(() => users.id),
  subject: text().notNull(), description: text().notNull(), kind: text().notNull(), confidential: boolean().notNull().default(false), status: text().notNull().default('open'), resolution: text(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('helpdesk_cases_tenant_id').on(table.institutionId, table.id), check('helpdesk_case_state', sql`status in ('open','assigned','resolved')`), check('helpdesk_case_kind', sql`kind in ('helpdesk','grievance') and (kind <> 'grievance' or confidential)`), tenantPolicy('helpdesk_cases')])
export const messages = pgTable('helpdesk_messages', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), caseId: uuid('case_id').notNull(), authorId: text('author_id').notNull().references(() => users.id), body: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [foreignKey({ columns: [table.institutionId, table.caseId], foreignColumns: [cases.institutionId, cases.id] }), tenantPolicy('helpdesk_messages')])
