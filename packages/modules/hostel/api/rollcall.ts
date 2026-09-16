import { createHmac } from 'node:crypto'
import { currentQr, decodeQr, encodeQr, verifyToken } from '@campusos/module-attendance/api'

/**
 * Roll-call tokens, borrowed wholesale from Attendance.
 *
 * This is the whole of the soft dependency in code: the rotating-token
 * primitive is pure -- an HMAC over a session id and a clock window, with
 * nothing stored -- so a hostel block's nightly roll call can use it without
 * touching an attendance session, an offering or a timetable slot.
 *
 * What is *not* borrowed is the entitlement. If an institution has Hostel but
 * not Attendance, none of this runs and the warden takes a manual register; see
 * `rollCallMode` in the operations.
 */

/**
 * The secret behind a night's tokens, derived rather than stored.
 *
 * Attendance keeps a random secret on each session row; a hostel roll call has
 * no session row to hang one on, and inventing a table for a value that can be
 * derived is a table to migrate, back up and leak. One HMAC of AUTH_SECRET per
 * institution gives the same unguessability with nothing at rest.
 */
export function rollCallSecret(institutionId: string): string {
  const base = process.env.AUTH_SECRET
  if (!base) throw new Error('AUTH_SECRET is required to derive roll-call tokens')
  return createHmac('sha256', base).update(`hostel:${institutionId}`).digest('base64url')
}

/** A roll call's "session" is one block on one night. */
export const rollCallKey = (blockId: string, night: string) => `${blockId}:${night}`

/** Longer than a classroom's seven seconds: a queue at a hostel gate is slower. */
export const ROLL_CALL_WINDOW_SECONDS = 20

export const rollCallQr = (secret: string, blockId: string, night: string) =>
  currentQr(secret, rollCallKey(blockId, night), ROLL_CALL_WINDOW_SECONDS)

export { decodeQr, encodeQr, verifyToken }

export type RollCallMode = 'scan' | 'manual'
