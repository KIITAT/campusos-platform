import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The rotating token.
 *
 * Derived, not stored. The token for a session is an HMAC over the session's
 * secret and the current time window, so:
 *
 *   - nothing is written per rotation, which is why this module needs no
 *     key-value store at all (see api/README of decisions)
 *   - there is no TTL race between writing a token and a student posting it
 *   - a token cannot be forged without the session secret, which never leaves
 *     the server
 *
 * The security property the spec wants -- a screenshot of the QR is useless
 * within seconds -- comes from the window, not from single-use. Fifty students
 * legitimately share the token that is current while they scan; what stops one
 * student marking twice is the unique index on (session_id, student_id).
 */

/** Server clock only. A student's device clock is never consulted. */
export const windowFor = (windowSeconds: number, atMs = Date.now()) =>
  Math.floor(atMs / 1000 / windowSeconds)

export const newSessionSecret = () => randomBytes(32).toString('base64url')

/** 12 base64url chars is 72 bits: not guessable, and still a small QR. */
export function tokenFor(secret: string, sessionId: string, window: number): string {
  return createHmac('sha256', secret)
    .update(`${sessionId}:${window}`)
    .digest('base64url')
    .slice(0, 12)
}

export interface QrPayload {
  sessionId: string
  window: number
  token: string
  /** Milliseconds until this token stops being the current one. */
  expiresInMs: number
}

export function currentQr(
  secret: string,
  sessionId: string,
  windowSeconds: number,
  atMs = Date.now(),
): QrPayload {
  const window = windowFor(windowSeconds, atMs)
  const windowMs = windowSeconds * 1000
  return {
    sessionId,
    window,
    token: tokenFor(secret, sessionId, window),
    expiresInMs: (window + 1) * windowMs - atMs,
  }
}

/** What the QR image encodes. Compact, because QR density costs scan time. */
export const encodeQr = (p: QrPayload) => `${p.sessionId}.${p.window}.${p.token}`

export function decodeQr(raw: unknown): Omit<QrPayload, 'expiresInMs'> | null {
  if (typeof raw !== 'string') return null
  const parts = raw.split('.')
  if (parts.length !== 3) return null
  const [sessionId, windowRaw, token] = parts as [string, string, string]
  const window = Number(windowRaw)
  if (!Number.isSafeInteger(window) || window < 0) return null
  if (!sessionId || !token) return null
  return { sessionId, window, token }
}

const constantTimeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  return x.length === y.length && timingSafeEqual(x, y)
}

export type TokenVerdict = 'ok' | 'stale' | 'invalid'

/**
 * Accepts the current window and the one immediately before it.
 *
 * The grace window is not laxness: a student can scan at 6.99s into a window
 * and have the request land after it rolled over. One window of slack keeps
 * the effective lifetime under fifteen seconds while removing a whole class of
 * spurious failures at the boundary.
 */
export function verifyToken(
  secret: string,
  sessionId: string,
  windowSeconds: number,
  presented: { window: number; token: string },
  atMs = Date.now(),
): TokenVerdict {
  const now = windowFor(windowSeconds, atMs)
  if (presented.window !== now && presented.window !== now - 1) return 'stale'
  const expected = tokenFor(secret, sessionId, presented.window)
  return constantTimeEqual(expected, presented.token) ? 'ok' : 'invalid'
}

/** Metres between two coordinates. Haversine on a spherical earth. */
export function distanceM(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLng = toRad(b.longitude - a.longitude)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
