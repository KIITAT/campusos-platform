import * as z from 'zod'
import { manifest } from '../manifest'
import { grantExcuseSchema, revokeExcuseSchema, rulesSchema } from './excuses'
import { heldSessionSchema, offlinePolicySchema, prepareSessionSchema, registerKeySchema, revokeCredentialSchema, revokeDeviceSchema, signedScanSchema } from './offline'
import {
  approveDeviceSchema,
  closeSessionSchema,
  openSessionSchema,
  overrideSchema,
  qrSchema,
  registerDeviceSchema,
  rosterSchema,
  scanRejectionSchema,
  scanResultSchema,
  scanSchema,
  setGeofenceSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })

const gated = {
  '403': {
    description: 'Forbidden, or the module is not enabled for this institution',
    content: json(err),
  },
}

export const paths = {
  ...excusesAndRules(),
  ...offlinePaths(),
  [`${base}/sessions`]: {
    get: {
      summary: 'Open sessions the caller may act on',
      tags: ['attendance'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Open an attendance session for a timetable slot',
      tags: ['attendance'],
      requestBody: { content: json(openSessionSchema) },
      responses: {
        '200': { description: 'Opened' },
        ...gated,
        '409': { description: 'A session is already open for this slot', content: json(err) },
      },
    },
  },

  [`${base}/sessions/close`]: {
    post: {
      summary: 'Close an attendance session',
      tags: ['attendance'],
      requestBody: { content: json(closeSessionSchema) },
      responses: { '204': { description: 'Closed' }, ...gated },
    },
  },

  [`${base}/sessions/qr`]: {
    get: {
      summary:
        'The QR payload current for this instant. Derived from the session secret and the clock, so poll it at roughly the rotation interval rather than caching it.',
      tags: ['attendance'],
      responses: {
        '200': { description: 'OK', content: json(qrSchema) },
        ...gated,
        '409': { description: 'Session is closed', content: json(err) },
      },
    },
  },

  [`${base}/sessions/roster`]: {
    get: {
      summary: 'The whole cohort for a session, marked and unmarked',
      tags: ['attendance'],
      responses: { '200': { description: 'OK', content: json(rosterSchema) }, ...gated },
    },
  },

  [`${base}/scan`]: {
    post: {
      summary: 'Mark the calling student present by scanning a rotating code',
      description:
        'Legacy online-only flow, disabled by default. Institutions may temporarily enable it for devices without signing keys. Once an account enrolls a key it cannot use this endpoint. Use /scan/signed for offline capture and idempotent sync.',
      tags: ['attendance'],
      requestBody: { content: json(scanSchema) },
      responses: {
        '200': { description: 'Marked present', content: json(scanResultSchema) },
        ...gated,
        '409': { description: 'Scan rejected', content: json(scanRejectionSchema) },
      },
    },
  },

  [`${base}/devices`]: {
    post: {
      summary: 'Register the calling student’s device; lands pending approval',
      tags: ['attendance'],
      requestBody: { content: json(registerDeviceSchema) },
      responses: { '200': { description: 'Registered' }, ...gated },
    },
    get: {
      summary: 'Devices awaiting approval (admin)',
      tags: ['attendance'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
  },

  [`${base}/devices/approve`]: {
    post: {
      summary: 'Approve a device, revoking whatever that student had active',
      tags: ['attendance'],
      requestBody: { content: json(approveDeviceSchema) },
      responses: { '204': { description: 'Approved' }, ...gated },
    },
  },

  [`${base}/override`]: {
    post: {
      summary: 'Mark a student present manually. The reason is mandatory.',
      tags: ['attendance'],
      requestBody: { content: json(overrideSchema) },
      responses: { '204': { description: 'Marked' }, ...gated },
    },
  },

  [`${base}/geofences`]: {
    post: {
      summary: 'Set a room’s geofence centre and radius',
      tags: ['attendance'],
      requestBody: { content: json(setGeofenceSchema) },
      responses: { '204': { description: 'Set' }, ...gated },
    },
  },

  [`${base}/me`]: {
    get: {
      summary: 'The calling student’s own attendance history',
      tags: ['attendance'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
  },
}

function offlinePaths() {
  const post = (summary: string, schema: z.ZodType) => ({ post: { summary, tags: ['attendance'], requestBody: { content: json(schema) }, responses: { '200': { description: 'OK' }, ...gated, '409': { description: 'Signature, device, replay, class window, or sync policy refused the request', content: json(err) } } } })
  const get = (summary: string) => ({ get: { summary, tags: ['attendance'], responses: { '200': { description: 'OK' }, ...gated } } })
  return {
    [`${base}/scan/signed`]: post('Verify a P-256 device signature over exact base64url JSON bytes; idempotently sync a captured scan', signedScanSchema),
    [`${base}/devices/key`]: post('Enroll a P-256 public key with proof of possession; administrator approval required', registerKeySchema),
    [`${base}/devices/mine`]: get('The caller’s device status and signing-key availability'),
    [`${base}/devices/revoke`]: post('Revoke the caller’s device, or any device as administrator', revokeDeviceSchema),
    [`${base}/offline/policy`]: { ...get('Signed attendance requirements, late-sync limit, and clock tolerance'), ...post('Set signed attendance and late-sync policy', offlinePolicySchema) },
    [`${base}/sessions/prepare`]: post('Prefetch a secret scoped to one timetable occurrence within seven days; opens no session', prepareSessionSchema),
    [`${base}/sessions/held`]: post('Idempotently confirm that a prepared class was started, including an all-absent class', heldSessionSchema),
    [`${base}/sessions/prepare/revoke`]: post('Revoke an offline occurrence credential', revokeCredentialSchema),
  }
}

/** Excused absence, the institution's rules, the summary and the absentees. */
function excusesAndRules() {
  const post = (summary: string, schema: z.ZodType, description?: string) => ({
    post: {
      summary,
      ...(description ? { description } : {}),
      tags: ['attendance'],
      requestBody: { content: json(schema) },
      responses: { '200': { description: 'OK' }, ...gated, '409': { description: 'Refused', content: json(err) } },
    },
  })
  const get = (summary: string, query: string[] = [], description?: string) => ({
    get: {
      summary,
      ...(description ? { description } : {}),
      tags: ['attendance'],
      parameters: query.map((name) => ({ name: name.replace('?', ''), in: 'query', required: !name.endsWith('?'), schema: { type: 'string' } })),
      responses: { '200': { description: 'OK' }, ...gated },
    },
  })
  return {
    [`${base}/rules`]: {
      ...get('The minimum attendance, whether excused absence counts, and the zone a class date is read in'),
      ...post('Set them', rulesSchema),
    },
    [`${base}/excuses`]: {
      ...get('Excused absences: a student’s own, a teacher’s classes’, or all for the office'),
      ...post('Excuse absence over days, for one class or all of a student’s classes', grantExcuseSchema),
    },
    [`${base}/excuses/revoke`]: post('Revoke an excuse, with a reason', revokeExcuseSchema),
    [`${base}/absentees`]: get(
      'Everybody in a class with their attendance, those short of the minimum first, and who missed the last session',
      ['offeringId'],
    ),
    [`${base}/summary`]: get(
      'A student’s attendance class by class: held, present, excused, absent, percentage, and classes needed to reach the minimum',
      ['studentId?', 'termId?'],
    ),
  }
}
