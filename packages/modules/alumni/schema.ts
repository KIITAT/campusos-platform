import { sql } from 'drizzle-orm'
import { boolean, check, date, foreignKey, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'

const tenantId = () => uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' })
export const profiles = pgTable('alumni_profiles', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), userId: text('user_id').notNull().references(() => users.id), graduationYear: integer('graduation_year').notNull(), qualification: text().notNull(), employer: text(), contactEmail: text('contact_email'), publishProfile: boolean('publish_profile').notNull().default(false), publishContact: boolean('publish_contact').notNull().default(false),
}, table => [uniqueIndex('alumni_profile_user').on(table.institutionId, table.userId), uniqueIndex('alumni_profiles_tenant_id').on(table.institutionId, table.id), check('alumni_profile_consent', sql`not publish_contact or publish_profile`), tenantPolicy('alumni_profiles')])
export const events = pgTable('alumni_events', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), title: text().notNull(), startsOn: date('starts_on').notNull(), registrationDeadline: date('registration_deadline').notNull(), capacity: integer().notNull(), venue: text().notNull(), status: text().notNull().default('draft'),
}, table => [uniqueIndex('alumni_events_tenant_id').on(table.institutionId, table.id), check('alumni_event_capacity', sql`capacity between 1 and 100000`), check('alumni_event_dates', sql`registration_deadline <= starts_on`), check('alumni_event_state', sql`status in ('draft','open','closed','cancelled')`), tenantPolicy('alumni_events')])
export const registrations = pgTable('alumni_registrations', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), eventId: uuid('event_id').notNull(), profileId: uuid('profile_id').notNull(), status: text().notNull().default('active'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('alumni_registration_identity').on(table.eventId, table.profileId), foreignKey({ columns: [table.institutionId, table.eventId], foreignColumns: [events.institutionId, events.id] }), foreignKey({ columns: [table.institutionId, table.profileId], foreignColumns: [profiles.institutionId, profiles.id] }), check('alumni_registration_state', sql`status in ('active','cancelled')`), tenantPolicy('alumni_registrations')])
