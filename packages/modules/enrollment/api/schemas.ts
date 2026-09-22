import * as z from 'zod'

/**
 * The module owns its own contract; api-contracts imports these to build the
 * single OpenAPI document.
 */

const uuid = z.uuid()
const studentId = z.string().min(1)

export const setOfferingLimitSchema = z
  .object({
    offeringId: uuid,
    capacity: z.coerce.number().int().min(0).max(2000),
    /** Zero means there is no queue: when it is full, it is full. */
    waitlistCapacity: z.coerce.number().int().min(0).max(2000).default(0),
  })
  .meta({ id: 'EnrollmentSetOfferingLimit' })

export const registerSchema = z
  .object({
    /** Omitted means the caller; only staff may name somebody else. */
    studentId: studentId.optional(),
    offeringId: uuid,
    /**
     * The day it counts from. Staff only, and for one reason: a registrar
     * entering last Friday's paper slip enters last Friday.
     */
    effectiveOn: z.iso.date().optional(),
    reason: z.string().max(500).trim().optional(),
  })
  .meta({ id: 'EnrollmentRegister' })

export const dropSchema = z
  .object({
    studentId: studentId.optional(),
    offeringId: uuid,
    effectiveOn: z.iso.date().optional(),
    reason: z.string().max(500).trim().optional(),
  })
  .meta({ id: 'EnrollmentDrop' })

export const rosterQuerySchema = z
  .object({ offeringId: uuid })
  .meta({ id: 'EnrollmentRosterQuery' })

export const registrationsQuerySchema = z
  .object({
    studentId: studentId.optional(),
    termId: uuid.optional(),
  })
  .meta({ id: 'EnrollmentRegistrationsQuery' })

export const creditLoadQuerySchema = z
  .object({ studentId: studentId.optional(), termId: uuid })
  .meta({ id: 'EnrollmentCreditLoadQuery' })

/**
 * What Student Financials reads. Deliberately by term rather than by student:
 * proration runs over a term's drops, and a per-student call would be a query
 * per student on the day the refunds are worked out.
 */
export const eventsQuerySchema = z
  .object({
    termId: uuid,
    studentId: studentId.optional(),
  })
  .meta({ id: 'EnrollmentEventsQuery' })

export const registrationSchema = z
  .object({
    id: uuid,
    studentId,
    offeringId: uuid,
    termId: uuid,
    status: z.enum(['registered', 'waitlisted', 'dropped', 'withdrawn']),
    credits: z.number().int(),
    courseCode: z.string(),
    courseTitle: z.string(),
    registeredAt: z.iso.datetime(),
    endedOn: z.string().nullable(),
  })
  .meta({ id: 'EnrollmentRegistration' })

export const creditLoadSchema = z
  .object({
    studentId,
    termId: uuid,
    /** Registered only. A waitlisted course is not a credit anyone is carrying. */
    credits: z.number().int(),
    courses: z.number().int(),
  })
  .meta({ id: 'EnrollmentCreditLoad' })

export type CreditLoad = z.infer<typeof creditLoadSchema>
