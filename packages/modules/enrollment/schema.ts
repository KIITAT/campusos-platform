import {
  date,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'
import { offerings, terms } from '@campusos/module-academic/schema'

/**
 * Registration, as a record of events rather than as a flag.
 *
 * The tempting shape is a boolean on a join table: the student is in the class
 * or is not. It does not survive the first bursar's question. A course dropped
 * in week one and a course dropped in week nine are different amounts of money
 * and different marks on a transcript, and "is not in the class" cannot tell
 * them apart. So a registration carries a status, and every change to it
 * carries a date -- that date is what fee proration reads.
 *
 * Table names are namespaced `enrollment_*`, and every table carries
 * institution_id and the shared tenant policy.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

const pk = () => uuid().primaryKey().defaultRandom()
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

// --- seats -----------------------------------------------------------------

/**
 * How many may sit in an offering, and how many may queue for it. Kept here
 * rather than as a column on the academic offering: a room's capacity is a
 * property of the building, and the number of seats a registrar releases for a
 * class is a decision, often a smaller one, and sometimes revised mid-window.
 *
 * An offering with no row here has no limit. That is deliberate -- a seminar
 * nobody capped should not refuse its eleventh student because a default of ten
 * was invented somewhere.
 */
export const offeringLimits = pgTable(
  'enrollment_offering_limits',
  {
    id: pk(),
    institutionId: tenantId(),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'cascade' }),
    capacity: smallint().notNull(),
    /** Zero means there is no queue: when it is full, it is full. */
    waitlistCapacity: smallint('waitlist_capacity').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('enrollment_offering_limits_once').on(t.offeringId),
    tenantPolicy('enrollment_offering_limits'),
  ],
)

// --- registrations ---------------------------------------------------------

export const registrationStatusEnum = pgEnum('enrollment_status', [
  'registered',
  'waitlisted',
  /** Dropped inside the add/drop window: it leaves no mark. */
  'dropped',
  /** Dropped after it: the transcript says so. */
  'withdrawn',
])

/**
 * One row per student per offering, whatever happens to it. A student who
 * drops and registers again in the same window is the same registration
 * changing status, with both moves in the event log -- two rows would make
 * "how many are in this class" a question about which row is newest.
 *
 * `termId` is copied from the offering rather than joined for: every question
 * downstream is per term -- credit load, fee proration, a transcript -- and
 * copying it here keeps the hot path one table.
 *
 * `credits` is frozen at registration for the same reason the academic core
 * freezes it on a completion: re-pricing a course must not silently change a
 * past term's load, which is what financial aid eligibility is computed from.
 */
export const registrations = pgTable(
  'enrollment_registrations',
  {
    id: pk(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'restrict' }),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'restrict' }),
    status: registrationStatusEnum().notNull().default('registered'),
    credits: smallint().notNull(),
    /** When this registration last became live; the waitlist queues on it. */
    registeredAt: timestamp('registered_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** The day it stopped counting. Null while it still does. */
    endedOn: date('ended_on'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('enrollment_registrations_once').on(t.studentId, t.offeringId),
    index('enrollment_registrations_offering').on(t.offeringId, t.status),
    index('enrollment_registrations_term').on(t.termId, t.studentId),
    tenantPolicy('enrollment_registrations'),
  ],
)

export const registrationEventEnum = pgEnum('enrollment_event_kind', [
  'registered',
  'waitlisted',
  /** A seat came free and the queue moved. */
  'promoted',
  'dropped',
  'withdrawn',
])

/**
 * What happened, and on what day it counts from.
 *
 * Append-only, enforced by a trigger. Student Financials prorates a refund
 * against `effectiveOn`, so a row that could be edited afterwards would make
 * every refund a matter of opinion. A correction is a new event, not a revised
 * one.
 */
export const registrationEvents = pgTable(
  'enrollment_registration_events',
  {
    id: pk(),
    institutionId: tenantId(),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'cascade' }),
    kind: registrationEventEnum().notNull(),
    /**
     * The date the change counts from, which is not always today: a registrar
     * entering last Friday's drop slip enters last Friday.
     */
    effectiveOn: date('effective_on').notNull(),
    reason: text(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('enrollment_events_registration').on(t.registrationId, t.createdAt),
    tenantPolicy('enrollment_registration_events'),
  ],
)
