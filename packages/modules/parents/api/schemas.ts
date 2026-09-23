import * as z from 'zod'

const uuid = z.uuid()

export const claimLinkSchema = z
  .object({
    studentId: z.string().min(1),
    relation: z.string().trim().min(2).max(40),
    /** Only an administrator may name somebody else as the parent. */
    parentId: z.string().min(1).nullish(),
  })
  .meta({ id: 'ParentLinkClaim' })

export const decideLinkSchema = z
  .object({
    linkId: uuid,
    approve: z.coerce.boolean(),
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'ParentLinkDecide' })

// --- reads -----------------------------------------------------------------

export const linkRowSchema = z
  .object({
    id: uuid,
    parentId: z.string(),
    parentName: z.string().nullable(),
    parentEmail: z.string().nullable(),
    studentId: z.string(),
    studentName: z.string().nullable(),
    studentEmail: z.string().nullable(),
    relation: z.string(),
    verifiedAt: z.string().nullable(),
    refusedReason: z.string().nullable(),
  })
  .meta({ id: 'ParentLink' })

export const childOverviewSchema = z
  .object({
    studentId: z.string(),
    studentName: z.string().nullable(),
    studentEmail: z.string().nullable(),
    /** Which modules contributed. A section absent means that module is off. */
    sections: z.array(z.string()),
    attendance: z
      .object({
        marked: z.number().int(),
        recent: z.array(
          z.object({
            courseCode: z.string(),
            markedAt: z.string(),
            method: z.string(),
          }),
        ),
      })
      .nullable(),
    results: z
      .object({
        provisional: z.boolean(),
        gpa: z.number().nullable(),
        grades: z.array(
          z.object({
            courseCode: z.string(),
            courseTitle: z.string(),
            percent: z.number(),
            label: z.string().nullable(),
            passed: z.boolean(),
          }),
        ),
      })
      .nullable(),
    fees: z
      .object({
        termCode: z.string(),
        payablePaise: z.number().int(),
        paidPaise: z.number().int(),
        outstandingPaise: z.number().int(),
        unreconciledPaise: z.number().int(),
      })
      .nullable(),
    library: z
      .object({
        openCount: z.number().int(),
        outstandingFinePaise: z.number().int(),
        overdue: z.number().int(),
      })
      .nullable(),
    hostel: z
      .object({
        allocated: z.boolean(),
        blockCode: z.string().nullable(),
        roomNumber: z.string().nullable(),
        recentNights: z.array(
          z.object({
            onNight: z.string(),
            status: z.string(),
            method: z.string(),
          }),
        ),
      })
      .nullable(),
  })
  .meta({ id: 'ParentChildOverview' })

export type LinkRow = z.infer<typeof linkRowSchema>
export type ChildOverview = z.infer<typeof childOverviewSchema>

// --- guardians by invitation ------------------------------------------------

export const inviteGuardianSchema = z
  .object({
    email: z.email().trim().toLowerCase(),
    studentId: z.string().min(1),
    relation: z.string().trim().min(2).max(40),
    /** How long the link may be accepted for. The access it grants does not expire. */
    days: z.coerce.number().int().min(1).max(30).default(7),
  })
  .meta({ id: 'ParentGuardianInvite' })

export const withdrawGuardianSchema = z
  .object({
    invitationId: uuid,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'ParentGuardianWithdraw' })
