import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, roleEnum, tenantPolicy, users } from '@campusos/db'
import { departments } from '@campusos/module-academic/schema'

/**
 * Notices and the in-app notification centre.
 *
 * `alwaysEnabled`, because an institution with no way to tell its students
 * anything is not a working install. Richer delivery channels -- SMS, WhatsApp
 * -- are a separately priced module later, not a feature of this one.
 *
 * Two tables, deliberately. A notice is the thing that was written; a
 * notification is one person's copy of it. Fanning out at publish time costs
 * rows and buys read state, an inbox other modules can write into, and a
 * per-person query that needs no audience logic at read time.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

const pk = () => uuid().primaryKey().defaultRandom()

export const noticeKindEnum = pgEnum('notice_kind', [
  'circular',
  'announcement',
  'urgent',
  'event',
])

export const notices = pgTable(
  'notices',
  {
    id: pk(),
    institutionId: tenantId(),
    title: text().notNull(),
    body: text().notNull(),
    kind: noticeKindEnum().notNull().default('announcement'),
    /** Empty means everybody. Otherwise only these roles see it. */
    audienceRoles: roleEnum('audience_roles')
      .array()
      .notNull()
      .default(sql`'{}'::role[]`),
    /** Null means the whole institution rather than one department. */
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'cascade',
    }),
    pinned: timestamp('pinned_at', { withTimezone: true }),
    /** Null until it is published. A draft notifies nobody. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notices_published').on(t.institutionId, t.publishedAt),
    index('notices_department').on(t.departmentId),
    check('notices_title', sql`length(trim(title)) > 0`),
    check('notices_body', sql`length(trim(body)) > 0`),
    check('notices_expiry', sql`expires_at is null or published_at is null or expires_at > published_at`),
    tenantPolicy('notices'),
  ],
)

/**
 * One person's copy. Written by the notice fan-out and by any module that needs
 * to tell somebody something -- a fee due, a book overdue, a leave decision --
 * which is why `module_id` and `link` are here and the body is plain text.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    institutionId: tenantId(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The module that raised it, so a disabled module's noise can be filtered. */
    moduleId: text('module_id').notNull(),
    title: text().notNull(),
    body: text().notNull(),
    /** Where clicking it should go. Relative, always. */
    link: text(),
    noticeId: uuid('notice_id').references(() => notices.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** When an email copy went out, if a channel was configured at all. */
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_inbox').on(t.userId, t.readAt, t.createdAt),
    index('notifications_notice').on(t.noticeId),
    check('notifications_title', sql`length(trim(title)) > 0`),
    check('notifications_link', sql`link is null or link like '/%'`),
    tenantPolicy('notifications'),
  ],
)

export type Notice = typeof notices.$inferSelect
export type Notification = typeof notifications.$inferSelect
