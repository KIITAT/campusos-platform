import { sql } from 'drizzle-orm'
import { tenantPolicy } from './rls'
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

export const roleEnum = pgEnum('role', [
  'super_admin',
  'institution_admin',
  'hod',
  'faculty',
  'accounts_staff',
  'library_staff',
  'hostel_staff',
  'student',
  'parent',
  'pending',
])

// ---------------------------------------------------------------------------
// Control plane. No RLS: these are read to *establish* tenant context, so they
// cannot themselves depend on it.
// ---------------------------------------------------------------------------

export const institutions = pgTable('institutions', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  customDomain: text('custom_domain').unique(),
  allowedEmailDomains: text('allowed_email_domains')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Entitlements. Deliberately not RLS-scoped (spec 3.4): requireModule() has to
 * read this before a tenant transaction exists. Holds booleans and module ids
 * only -- never put tenant data here.
 */
export const institutionModules = pgTable(
  'institution_modules',
  {
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    enabled: boolean().notNull().default(false),
    enabledAt: timestamp('enabled_at', { withTimezone: true }),
    planTier: text('plan_tier'),
  },
  (t) => [primaryKey({ columns: [t.institutionId, t.moduleId] })],
)

// ---------------------------------------------------------------------------
// Tenant-scoped
// ---------------------------------------------------------------------------

/**
 * Shape of id/name/email/emailVerified/image is fixed by @auth/drizzle-adapter
 * -- including the camelCase `emailVerified` column name and `text` (not uuid)
 * id. institutionId is nullable because the adapter's createUser() runs before
 * we know the tenant; the signIn callback fills it from the subdomain.
 */
export const users = pgTable(
  'users',
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text(),
    email: text().unique(),
    emailVerified: timestamp('emailVerified', { mode: 'date' }),
    image: text(),
    institutionId: uuid('institution_id').references(() => institutions.id, {
      onDelete: 'cascade',
    }),
    role: roleEnum().notNull().default('pending'),
    /**
     * DPDP consent. Recorded with the version of the notice that was shown, so
     * "what did they agree to" has an answer after the notice is rewritten --
     * which it will be, and re-consenting everybody is the whole cost of not
     * having stored this.
     */
    consentedAt: timestamp('consented_at', { withTimezone: true }),
    consentVersion: text('consent_version'),
    /**
     * Erasure is anonymisation, not deletion. A payment, a mark and an
     * attendance record are the institution's own records with their own
     * retention obligations; removing the person leaves those intact and
     * unattributable. The row survives so the foreign keys do.
     */
    erasedAt: timestamp('erased_at', { withTimezone: true }),
    /**
     * Age decides who may consent (DPDP Act s.9) and who may see the record.
     * The range is a trigger, not a CHECK: current_date is not immutable.
     * Read it through `ageStatus`; nothing else computes an age.
     */
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [tenantPolicy('users')],
)

/**
 * A guardian's, an adult student's or the office's recorded choice, one row per
 * decision. Append-only: the current decision is the latest row for the
 * student and purpose, and the history is the evidence (DPDP Act s.6(10)).
 */
export const guardianConsents = pgTable(
  'guardian_consents',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text().notNull(),
    decision: text().notNull(),
    basis: text().notNull(),
    guardianId: text('guardian_id').references(() => users.id, { onDelete: 'set null' }),
    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    note: text(),
    noticeVersion: text('notice_version').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    tenantPolicy('guardian_consents'),
    index('guardian_consents_latest').on(t.institutionId, t.studentId, t.purpose, t.recordedAt.desc()),
    check('guardian_consents_purpose', sql`purpose in ('privacy_notice', 'care_self_checks', 'apaar')`),
    check('guardian_consents_decision', sql`decision in ('given', 'refused', 'withdrawn')`),
    check('guardian_consents_basis', sql`basis in ('guardian', 'office_record', 'student')`),
    check('guardian_consents_basis_guardian', sql`(basis = 'guardian') = (guardian_id is not null)`),
    check('guardian_consents_office_note', sql`basis <> 'office_record' or note is not null`),
    check('guardian_consents_note', sql`note is null or length(note) between 1 and 300`),
  ],
).enableRLS()

// ---------------------------------------------------------------------------
// Auth.js tables. Column names and types are dictated by the adapter; do not
// rename them. No RLS -- sign-in happens before tenant context exists, so
// authDb (owner role) owns this path. See client.ts.
// ---------------------------------------------------------------------------

export const accounts = pgTable(
  'accounts',
  {
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    provider: text().notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text(),
    access_token: text(),
    expires_at: integer(),
    token_type: text(),
    scope: text(),
    id_token: text(),
    session_state: text(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
)

export const sessions = pgTable('sessions', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp({ mode: 'date' }).notNull(),
})

export const verificationTokens = pgTable(
  'verificationToken',
  {
    identifier: text().notNull(),
    token: text().notNull(),
    expires: timestamp({ mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
)
