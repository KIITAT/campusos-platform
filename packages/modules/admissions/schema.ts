import { sql } from 'drizzle-orm'
import { check, foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'
import { programs, studentPrograms, terms } from '@campusos/module-academic/schema'

const tenantId = () => uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' })
export const enquiries = pgTable('admissions_enquiries', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), name: text().notNull(), email: text().notNull(), phone: text(), note: text(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('admissions_enquiries_tenant_id').on(table.institutionId, table.id), tenantPolicy('admissions_enquiries')])
export const applications = pgTable('admissions_applications', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), enquiryId: uuid('enquiry_id').notNull(),
  programId: uuid('program_id').notNull().references(() => programs.id), termId: uuid('term_id').notNull().references(() => terms.id),
  status: text().notNull().default('submitted'), reason: text(), studentId: text('student_id').references(() => users.id),
  studentProgramId: uuid('student_program_id').references(() => studentPrograms.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('admissions_application_identity').on(table.enquiryId, table.programId, table.termId),
  foreignKey({ columns: [table.institutionId, table.enquiryId], foreignColumns: [enquiries.institutionId, enquiries.id] }),
  check('admissions_application_state', sql`status in ('submitted','offered','accepted','rejected','withdrawn')`),
  check('admissions_application_accepted_link', sql`(status = 'accepted') = (student_id is not null and student_program_id is not null)`),
  tenantPolicy('admissions_applications'),
])
