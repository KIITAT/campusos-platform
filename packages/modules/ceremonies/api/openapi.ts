import * as z from 'zod'
import { manifest } from '../manifest'
import {
  ceremonyRefSchema,
  ceremonyStatusSchema,
  checkInSchema,
  clearHoldSchema,
  createCeremonySchema,
  issueSchema,
  placeHoldSchema,
  reissueSchema,
  respondSchema,
  revokeSchema,
} from './schemas'
import { transferIssueSchema, transferReissueSchema, transferRevokeSchema } from './transfer-input'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const ok = {
  '200': { description: 'OK' },
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
  '409': { description: 'Refused', content: json(err) },
}
const unavailable = { ...ok, '503': { description: 'Certificate clearance is unavailable (certificate_clearance_unavailable)', content: json(err) } }
const post = (summary: string, schema: z.ZodType, description?: string, responses: typeof ok = ok) => ({
  post: {
    summary,
    ...(description ? { description } : {}),
    tags: ['ceremonies'],
    requestBody: { content: json(schema) },
    responses,
  },
})
const get = (summary: string, query: string[] = [], description?: string) => ({
  get: {
    summary,
    ...(description ? { description } : {}),
    tags: ['ceremonies'],
    parameters: query.map((name) => ({ name, in: 'query', required: true, schema: { type: 'string' } })),
    responses: ok,
  },
})

export const paths = {
  [`${base}/ceremonies`]: {
    ...get('Ceremonies, with how many are on each list, cleared and issued'),
    ...post('Plan a ceremony', createCeremonySchema, 'For some programmes, or every programme when none are named.'),
  },
  [`${base}/ceremonies/status`]: post('Move a ceremony forward', ceremonyStatusSchema, 'Planning, open, held, closed; never back.'),
  [`${base}/ceremonies/eligibility`]: post(
    'Audit everybody graduating at a ceremony',
    ceremonyRefSchema,
    "Queues a job that runs the academic module's degree audit for every live or completed declaration in the ceremony's programmes and records what it found. Eligible means the audit says complete; nobody is added or cleared by hand.",
  ),
  [`${base}/candidates`]: get('The list: each student, what the audit found, holds, reply, check-in, certificate', ['ceremonyId']),
  [`${base}/holds`]: {
    ...get('Holds placed at a ceremony, open and cleared', ['ceremonyId']),
    ...post('Hold a candidate back, with a reason', placeHoldSchema, 'Audited. A certificate is refused while a hold is open.'),
  },
  [`${base}/holds/clear`]: post('Clear a hold, with a reason', clearHoldSchema),
  [`${base}/respond`]: post('Reply: attending, or conferred in absentia, and guests', respondSchema, 'The graduand only, while replies are open, and only once the audit has cleared them.'),
  [`${base}/checkin`]: post('Check a graduand in on the day', checkInSchema),
  [`${base}/me`]: get("A student's ceremonies and certificates"),
  [`${base}/certificates`]: get('Certificates, optionally for one ceremony'),
  [`${base}/certificates/issue`]: post(
    'Issue certificates to cleared candidates',
    issueSchema,
    'Each candidate is audited again at the moment of issue and the certificate carries that audit. Anybody it does not clear, or who has a hold open, is skipped and named. The database refuses a certificate whose audit is not complete. Candidates with outstanding dues are skipped. A configured clearance provider that is unavailable returns 503 (certificate_clearance_unavailable).',
    unavailable,
  ),
  [`${base}/certificates/revoke`]: post('Revoke a certificate, with a reason', revokeSchema, 'Cancels it. The serial stays on record as revoked; it is never printed again.'),
  [`${base}/certificates/reissue`]: post(
    'Reissue a revoked certificate under a new serial',
    reissueSchema,
    'The new certificate names the one it replaces, and the audit is taken again: a reissue is not a way round a student who no longer clears. Outstanding dues return 409 (certificate_dues_outstanding). A configured clearance provider that is unavailable returns 503 (certificate_clearance_unavailable).',
    unavailable,
  ),
  [`${base}/certificate`]: get('One certificate; a student sees only their own', ['certificateId']),
  [`${base}/certificate.pdf`]: {
    get: {
      summary: 'The certificate to print',
      tags: ['ceremonies'],
      parameters: [{ name: 'certificateId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
        '409': { description: 'Revoked certificates are not printed', content: json(err) },
      },
    },
  },
  [`${base}/transfer-certificates`]: {
    get: {
      summary: 'The confidential register of school transfer certificates: one pupil or one serial, newest 50',
      tags: ['ceremonies'],
      parameters: ['studentId', 'serial'].map((name) => ({ name, in: 'query', required: false, schema: { type: 'string' } })),
      responses: ok,
    },
  },
  [`${base}/transfer-certificates/issue`]: post(
    'Issue a numbered school transfer certificate (CBSE Annexure I)',
    transferIssueSchema,
    'Office only. For a school declaration already ended as transferred out. The serial TC-YYYY-NNNNNN is taken only after every field is valid and the dues are clear: outstanding dues return 409 (certificate_dues_outstanding), an unavailable clearance provider 503 (certificate_clearance_unavailable).',
    unavailable,
  ),
  [`${base}/transfer-certificates/revoke`]: post('Revoke a transfer certificate, with a reason (no personal details)', transferRevokeSchema, 'The serial stays on record as revoked and is never printed again.'),
  [`${base}/transfer-certificates/reissue`]: post(
    'Replace a revoked transfer certificate under a new serial',
    transferReissueSchema,
    'The fields are confirmed again and the dues are checked again: outstanding dues return 409 (certificate_dues_outstanding).',
    unavailable,
  ),
  [`${base}/transfer-certificate.pdf`]: {
    get: {
      summary: 'The school transfer certificate to print, from the saved snapshot',
      tags: ['ceremonies'],
      parameters: [{ name: 'certificateId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'PDF, private and not cached', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
        '409': { description: 'Revoked or erased certificates are not printed (transfer_pdf_unavailable)', content: json(err) },
      },
    },
  },
  [`${base}/verify`]: get('Check a certificate by the code printed on it', ['code']),
}
