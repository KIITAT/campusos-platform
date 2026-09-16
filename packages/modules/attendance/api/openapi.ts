import * as z from 'zod'
import { manifest } from '../manifest'
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
        'Validated in order, rejecting on first failure: token, enrolment, location, device. ' +
        'A rejection is a 409 carrying a closed-set code. There is deliberately no retry ' +
        'queue: the short token window is the anti-proxy mechanism, and queueing a scan for ' +
        'later would undo it, so a failure is reported immediately and honestly.',
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
