import { z } from 'zod'

export const companySchema = z.object({ name: z.string().trim().min(1).max(200), website: z.url().refine((value) => new URL(value).protocol === 'https:', 'Use an HTTPS website').optional() })
export const driveSchema = z.object({
  companyId: z.uuid(), programId: z.uuid().optional(), title: z.string().trim().min(1).max(200),
  closesAt: z.iso.datetime({ offset: true }), minCgpa: z.coerce.number().min(0).max(10).default(0), maxBacklogs: z.coerce.number().int().min(0).max(100).default(0),
})
export const driveStateSchema = z.object({ driveId: z.uuid(), status: z.enum(['open', 'closed']) })
export const officerSchema = z.object({ userId: z.string().min(1), active: z.preprocess((value) => value === 'true' ? true : value === 'false' ? false : value, z.boolean()) })
export const applicationSchema = z.object({ driveId: z.uuid() })
export const applicationIdSchema = z.object({ applicationId: z.uuid() })
export const roundSchema = z.object({ driveId: z.uuid(), name: z.string().trim().min(1).max(120) })
export const resultSchema = z.object({ applicationId: z.uuid(), roundId: z.uuid(), outcome: z.enum(['passed', 'failed']), note: z.string().trim().min(3).max(2000) })
export const offerSchema = z.object({ applicationId: z.uuid(), annualPaise: z.coerce.number().int().positive().max(999999999999999) })
export const responseSchema = z.object({ offerId: z.uuid(), decision: z.enum(['accepted', 'declined']) })
