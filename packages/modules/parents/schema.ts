import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, invitations, tenantPolicy, users } from '@campusos/db'

/**
 * The parent portal owns exactly one thing: who is allowed to look at whom.
 *
 * Everything else it shows is read through the other modules' own operations,
 * so a figure a parent sees is the same figure the office sees, computed by the
 * same code. A second implementation of "what is outstanding" that disagreed
 * with the finance desk by a rupee would be the worst possible bug here.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

/**
 * A link is claimed and then verified, never self-service.
 *
 * Anybody can assert they are somebody's father. The institution decides, and
 * until it has, the link exists but shows nothing -- which is why `verified_at`
 * is nullable rather than the row being absent.
 */
export const links = pgTable(
  'parent_links',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    parentId: text('parent_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    relation: text().notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: text('verified_by').references(() => users.id, { onDelete: 'set null' }),
    /** Why it was refused, when it was. Kept so the parent can be told. */
    refusedReason: text('refused_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('parent_links_pair').on(t.parentId, t.studentId),
    index('parent_links_student').on(t.studentId),
    index('parent_links_pending').on(t.institutionId, t.verifiedAt),
    check('parent_links_relation', sql`length(trim(relation)) > 0`),
    check('parent_links_distinct', sql`parent_id <> student_id`),
    check(
      'parent_links_decided',
      sql`verified_at is null or refused_reason is null`,
    ),
    tenantPolicy('parent_links'),
  ],
)

export type ParentLink = typeof links.$inferSelect

/**
 * Which child an invitation is for.
 *
 * The invitation itself is the host's -- it decides who may sign in at all,
 * which is not a module's business -- and this is the half the portal owns:
 * that once the invited guardian has an account, they are the verified parent
 * of this student. The link is made the first time the guardian arrives, by
 * whoever the office already vouched for; nobody verifies it twice.
 */
export const guardianInvites = pgTable(
  'parent_guardian_invites',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    invitationId: uuid('invitation_id')
      .notNull()
      .references(() => invitations.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    relation: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the link was made from it. */
    linkedAt: timestamp('linked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('parent_guardian_invites_pair').on(t.invitationId, t.studentId),
    index('parent_guardian_invites_student').on(t.studentId),
    check('parent_guardian_invites_relation', sql`length(trim(relation)) > 0`),
    tenantPolicy('parent_guardian_invites'),
  ],
)
