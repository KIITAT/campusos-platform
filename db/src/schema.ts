import { sql } from 'drizzle-orm'
import { tenantPolicy } from './rls'
import {
  boolean,
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [tenantPolicy('users')],
)

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
