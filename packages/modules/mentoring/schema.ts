import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'

/**
 * Mentoring: every student has a mentor (and may have a co-mentor) among the
 * teachers, who sees the whole of them -- record, attendance, results, fees,
 * where they live -- keeps notes, talks with them, and decides their leave.
 *
 * Depends on no other module's tables. What it shows of attendance, results,
 * fees and housing it asks those modules for, when they are on; an approved
 * leave is handed to the hostel, when that is on, so the roll call expects the
 * empty bed.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

/**
 * Who mentors a student, from when. Changing a mentor ends the current row and
 * starts another, so who was responsible for a student on a given day stays
 * answerable.
 */
export const assignments = pgTable(
  'mentor_assignments',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mentorId: text('mentor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    coMentorId: text('co_mentor_id').references(() => users.id, { onDelete: 'restrict' }),
    fromOn: date('from_on').notNull().defaultNow(),
    toOn: date('to_on'),
    reason: text(),
    assignedBy: text('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mentor_assignments_current').on(t.studentId).where(sql`to_on is null`),
    index('mentor_assignments_mentor').on(t.mentorId).where(sql`to_on is null`),
    index('mentor_assignments_co').on(t.coMentorId).where(sql`to_on is null`),
    check('mentor_assignments_two', sql`co_mentor_id is null or co_mentor_id <> mentor_id`),
    check('mentor_assignments_span', sql`to_on is null or to_on >= from_on`),
    tenantPolicy('mentor_assignments'),
  ],
)

export const noteKindEnum = pgEnum('mentor_note_kind', ['meeting', 'call', 'progress', 'concern'])

/**
 * What a mentor wrote down: a meeting, a call, how the student is doing, a
 * worry. Private to the mentors and the office unless shared with the student.
 * Never edited: a correction is another note.
 */
export const notes = pgTable(
  'mentor_notes',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    metOn: date('met_on').notNull(),
    kind: noteKindEnum().notNull(),
    body: text().notNull(),
    shared: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('mentor_notes_student').on(t.studentId, t.metOn),
    check('mentor_notes_body', sql`length(trim(body)) between 3 and 4000`),
    tenantPolicy('mentor_notes'),
  ],
)

/** The conversation between a student and their mentors: one thread per student. */
export const messages = pgTable(
  'mentor_messages',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    senderId: text('sender_id').references(() => users.id, { onDelete: 'set null' }),
    body: text().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the other side first read it. */
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    index('mentor_messages_thread').on(t.studentId, t.sentAt),
    check('mentor_messages_body', sql`length(trim(body)) between 1 and 4000`),
    tenantPolicy('mentor_messages'),
  ],
)

/** The kinds of leave a student may ask for, as the institution names them. */
export const leaveTypes = pgTable(
  'mentor_leave_types',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    name: text().notNull(),
    /** A medical leave wants a certificate; a home visit does not. */
    needsDocument: boolean('needs_document').notNull().default(false),
    maxDays: smallint('max_days'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mentor_leave_types_name').on(t.institutionId, t.name),
    check('mentor_leave_types_days', sql`max_days is null or max_days between 1 and 365`),
    tenantPolicy('mentor_leave_types'),
  ],
)

export const leaveStatusEnum = pgEnum('mentor_leave_status', ['pending', 'approved', 'rejected', 'cancelled'])

/**
 * A student's application for leave, as KIIT's form asks it: the kind, the
 * days, why and where, when they leave and come back, a number to reach them
 * on, and a supporting PDF where the kind needs one. Decided once by their
 * mentor (or the office), and cancelled by the student if plans change.
 */
export const leaveApplications = pgTable(
  'mentor_leave_applications',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id, { onDelete: 'restrict' }),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    purpose: text().notNull(),
    placeOfVisit: text('place_of_visit').notNull(),
    leavingAt: timestamp('leaving_at', { withTimezone: true }).notNull(),
    arrivingAt: timestamp('arriving_at', { withTimezone: true }).notNull(),
    contactPhone: text('contact_phone').notNull(),
    documentName: text('document_name'),
    documentSha256: text('document_sha256'),
    documentSize: integer('document_size'),
    document: bytea(),
    status: leaveStatusEnum().notNull().default('pending'),
    /** The mentor when it was asked for: who it waits on. */
    mentorId: text('mentor_id').references(() => users.id, { onDelete: 'set null' }),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    /** The hostel's own leave row, when the hostel was told. */
    hostelLeaveId: uuid('hostel_leave_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('mentor_leave_applications_student').on(t.studentId, t.startsOn),
    index('mentor_leave_applications_waiting').on(t.mentorId).where(sql`status = 'pending'`),
    check('mentor_leave_applications_days', sql`ends_on >= starts_on`),
    check('mentor_leave_applications_times', sql`arriving_at > leaving_at`),
    check('mentor_leave_applications_purpose', sql`length(trim(purpose)) >= 5`),
    check('mentor_leave_applications_phone', sql`contact_phone ~ '^[0-9+() -]{7,20}$'`),
    check(
      'mentor_leave_applications_document',
      sql`(document is null) = (document_sha256 is null) and (document is null or octet_length(document) = document_size)`,
    ),
    tenantPolicy('mentor_leave_applications'),
  ],
)

export type Assignment = typeof assignments.$inferSelect
export type LeaveApplication = typeof leaveApplications.$inferSelect
