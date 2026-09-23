import * as z from 'zod'

const uuid = z.uuid()
const day = z.iso.date()
const reason = z.string().trim().min(5).max(500)

/** A form posts one programme at a time, or a comma list; the API takes an array. */
const idList = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : v,
  z.array(uuid),
)

export const createCeremonySchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    heldOn: day,
    venue: z.string().trim().max(200).optional(),
    rsvpClosesOn: day.optional(),
    programIds: idList.default([]),
    guestLimit: z.coerce.number().int().min(0).max(10).default(2),
  })
  .meta({ id: 'CeremonyCreate' })

export const ceremonyStatusSchema = z
  .object({
    ceremonyId: uuid,
    status: z.enum(['open', 'held', 'closed']),
  })
  .meta({ id: 'CeremonyStatus' })

export const ceremonyRefSchema = z.object({ ceremonyId: uuid }).meta({ id: 'CeremonyRef' })

export const placeHoldSchema = z
  .object({ candidateId: uuid, reason })
  .meta({ id: 'CeremonyHoldPlace' })

export const clearHoldSchema = z
  .object({ holdId: uuid, reason })
  .meta({ id: 'CeremonyHoldClear' })

export const respondSchema = z
  .object({
    ceremonyId: uuid,
    attendance: z.enum(['in_person', 'in_absentia']),
    guests: z.coerce.number().int().min(0).max(10).default(0),
  })
  .meta({ id: 'CeremonyRespond' })

export const checkInSchema = z.object({ candidateId: uuid }).meta({ id: 'CeremonyCheckIn' })

export const issueSchema = z
  .object({
    ceremonyId: uuid,
    /** Absent means every eligible candidate without a certificate. */
    candidateIds: z.array(uuid).optional(),
  })
  .meta({ id: 'CeremonyIssue' })

export const revokeSchema = z
  .object({ certificateId: uuid, reason })
  .meta({ id: 'CeremonyCertificateRevoke' })

export const reissueSchema = z
  .object({ certificateId: uuid })
  .meta({ id: 'CeremonyCertificateReissue' })

export const verifySchema = z.object({ code: z.string().trim().min(6).max(64) })
