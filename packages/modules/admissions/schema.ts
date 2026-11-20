import { sql } from 'drizzle-orm'
import { check, date, foreignKey, integer, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
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
  // The applicant's own details, when the enquirer is someone else (P1-12a, D6). Null means the enquiry's.
  applicantName: text('applicant_name'), applicantEmail: text('applicant_email'),
  dateOfBirth: date('date_of_birth', { mode: 'string' }), category: text(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('admissions_application_identity').on(table.enquiryId, table.programId, table.termId),
  foreignKey({ columns: [table.institutionId, table.enquiryId], foreignColumns: [enquiries.institutionId, enquiries.id] }),
  check('admissions_application_state', sql`status in ('submitted','offered','accepted','rejected','withdrawn')`),
  check('admissions_application_accepted_link', sql`(status = 'accepted') = (student_id is not null and student_program_id is not null)`),
  check('admissions_application_category', sql`category is null or category in ('general','ews','obc','sc','st')`),
  check('admissions_application_dob', sql`date_of_birth is null or date_of_birth >= date '1900-01-01'`),
  tenantPolicy('admissions_applications'),
])

/** The last roll number sequence issued per programme and intake year (P1-12a, D9, D21). Its row lock serialises acceptances. */
export const rollCounters = pgTable('admissions_roll_counters', {
  institutionId: tenantId(),
  programId: uuid('program_id').notNull().references(() => programs.id),
  intakeYear: smallint('intake_year').notNull(),
  lastValue: integer('last_value').notNull().default(0),
}, table => [
  primaryKey({ name: 'admissions_roll_counters_pk', columns: [table.institutionId, table.programId, table.intakeYear] }),
  check('admissions_roll_counters_value', sql`last_value between 0 and 9999`),
  check('admissions_roll_counters_year', sql`intake_year between 1900 and 2200`),
  tenantPolicy('admissions_roll_counters'),
])
