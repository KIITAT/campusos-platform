import * as z from 'zod'

const blank = (value: unknown) => (value === '' || value === null ? undefined : value)
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional())
const yes = (value: unknown) => value === true || value === 'true' || value === 'on' || value === '1'
// A date or ISO timestamp that Postgres will also accept: Date.parse alone passes '1' and rolls '2026-02-30' over.
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) && !Number.isNaN(Date.parse(value))
  && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().startsWith(value.slice(0, 10))
const KINDS = ['record', 'offer', 'contract', 'agreement'] as const
const SCOPES = ['office', 'student_academic', 'signer'] as const

export const uploadSchema = z.strictObject({
  title: z.string().trim().min(1).max(140),
  kind: z.enum(KINDS),
  scope: z.enum(SCOPES),
  subjectUserId: z.string().min(1).max(200),
  retainUntil: optional(z.string().trim().refine(validDate, 'Enter a valid retention end date.')),
  retentionBasis: optional(z.enum(['specified_purpose', 'legal_obligation'])),
  authorityRef: optional(z.string().trim().min(5).max(240)),
  file: z.unknown(),
}).refine(data => (data.kind === 'record') === (data.scope !== 'signer'), 'Offers, contracts and agreements are signable documents; other records are not.')

const id = z.uuid()
export const requestSchema = z.strictObject({ documentId: id, reason: z.string().trim().min(10).max(500), approvedInternalUse: z.preprocess(yes, z.literal(true, 'Confirm the document is approved for internal electronic assent.')) })
export const assentSchema = z.strictObject({ requestId: id, code: z.string().trim().min(1).max(64), consent: z.preprocess(yes, z.literal(true, 'Tick the box to record your assent.')) })
export const closeSchema = z.strictObject({ requestId: id, decision: z.enum(['decline', 'cancel']), reason: z.string().trim().min(10).max(500) })
export const challengeSchema = z.strictObject({ requestId: id })
export const verifySchema = z.strictObject({ documentId: id, sha256: optional(z.string().regex(/^[0-9a-f]{64}$/, 'A SHA-256 digest is 64 lowercase hex characters.')) })
