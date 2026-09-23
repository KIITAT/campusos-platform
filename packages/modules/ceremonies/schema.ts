import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { docStatusColumns, institutions, tenantPolicy, users } from '@campusos/db'

/**
 * Ceremonies: who may graduate, who is coming, and the certificates.
 *
 * The module decides nothing about a degree. Eligibility is the academic
 * module's degree audit, run by this module and kept as a snapshot on the
 * candidate so the office can see why somebody is or is not on the list; a
 * certificate carries the audit taken at the moment it was issued, and the
 * database refuses one whose audit did not clear.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

/** Forward only: planning, then open for replies, then held, then closed. */
export const ceremonyStatusEnum = pgEnum('ceremony_status', ['planning', 'open', 'held', 'closed'])

export const ceremonies = pgTable(
  'ceremony_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    name: text().notNull(),
    heldOn: date('held_on').notNull(),
    venue: text(),
    /** Replies close at the end of this day. Absent means until the ceremony. */
    rsvpClosesOn: date('rsvp_closes_on'),
    /** The programmes graduating at this ceremony. Empty means every programme. */
    programIds: uuid('program_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** How many guests each graduand may bring. */
    guestLimit: integer('guest_limit').notNull().default(2),
    status: ceremonyStatusEnum().notNull().default('planning'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  () => [
    check('ceremony_events_name', sql`length(trim(name)) > 0`),
    check('ceremony_events_rsvp', sql`rsvp_closes_on is null or rsvp_closes_on <= held_on`),
    check('ceremony_events_guests', sql`guest_limit between 0 and 10`),
    tenantPolicy('ceremony_events'),
  ],
)

export const attendanceEnum = pgEnum('ceremony_attendance', ['in_person', 'in_absentia'])

/**
 * One student at one ceremony, as the degree audit last found them. The audit
 * figures are a snapshot, not the record: the record is the academic module's,
 * and running eligibility again refreshes them.
 */
export const candidates = pgTable(
  'ceremony_candidates',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    ceremonyId: uuid('ceremony_id')
      .notNull()
      .references(() => ceremonies.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The declaration audited. Academic's; kept as an id, with the names beside it. */
    studentProgramId: uuid('student_program_id').notNull(),
    programCode: text('program_code').notNull(),
    programName: text('program_name').notNull(),
    creditsEarned: integer('credits_earned').notNull(),
    creditsRequired: integer('credits_required'),
    cgpa: numeric({ precision: 4, scale: 2 }),
    eligible: boolean().notNull(),
    /** Why not, in the audit's words, when not. */
    shortOf: text('short_of'),
    auditedAt: timestamp('audited_at', { withTimezone: true }).notNull(),
    attendance: attendanceEnum(),
    guests: integer().notNull().default(0),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    checkedInBy: text('checked_in_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ceremony_candidates_one').on(t.ceremonyId, t.studentId),
    index('ceremony_candidates_student').on(t.studentId),
    check('ceremony_candidates_guests', sql`guests between 0 and 10`),
    check('ceremony_candidates_short', sql`eligible or short_of is not null`),
    check(
      'ceremony_candidates_reply',
      sql`(attendance is null) = (responded_at is null)`,
    ),
    tenantPolicy('ceremony_candidates'),
  ],
)

/**
 * The office holding somebody back -- unreturned books, a disciplinary matter,
 * a document not yet seen. Always with a reason; cleared, never deleted.
 */
export const holds = pgTable(
  'ceremony_holds',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidates.id, { onDelete: 'cascade' }),
    reason: text().notNull(),
    placedBy: text('placed_by').references(() => users.id, { onDelete: 'set null' }),
    placedAt: createdAt(),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    clearedBy: text('cleared_by').references(() => users.id, { onDelete: 'set null' }),
    clearReason: text('clear_reason'),
  },
  (t) => [
    index('ceremony_holds_open').on(t.candidateId, t.clearedAt),
    check('ceremony_holds_reason', sql`length(trim(reason)) >= 5`),
    check(
      'ceremony_holds_cleared',
      sql`(cleared_at is null) = (clear_reason is null)`,
    ),
    tenantPolicy('ceremony_holds'),
  ],
)

/**
 * A certificate is an act, not a row to edit: submitted when issued, cancelled
 * with a reason to revoke it, and corrected by amending -- a new certificate
 * with a new serial naming the one it replaces.
 */
export const certificates = pgTable(
  'ceremony_certificates',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidates.id, { onDelete: 'restrict' }),
    ceremonyId: uuid('ceremony_id')
      .notNull()
      .references(() => ceremonies.id, { onDelete: 'restrict' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    serial: text().notNull(),
    /** Printed on the certificate, for checking it later. Unguessable. */
    verificationCode: text('verification_code').notNull(),
    studentName: text('student_name').notNull(),
    programCode: text('program_code').notNull(),
    programName: text('program_name').notNull(),
    cgpa: numeric({ precision: 4, scale: 2 }),
    creditsEarned: integer('credits_earned').notNull(),
    conferredOn: date('conferred_on').notNull(),
    /** The degree audit taken as this certificate was issued. */
    audit: jsonb().$type<Record<string, unknown>>().notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('ceremony_certificates_serial').on(t.institutionId, t.serial),
    uniqueIndex('ceremony_certificates_code').on(t.verificationCode),
    // One certificate standing per candidate; a revoked one does not count.
    uniqueIndex('ceremony_certificates_live')
      .on(t.candidateId)
      .where(sql`docstatus <> 'cancelled'`),
    index('ceremony_certificates_student').on(t.studentId),
    tenantPolicy('ceremony_certificates'),
  ],
)

export type Ceremony = typeof ceremonies.$inferSelect
export type Candidate = typeof candidates.$inferSelect
export type Certificate = typeof certificates.$inferSelect
