import { sql } from 'drizzle-orm'
import { authDb } from './client'

/**
 * Abuse limits (SEC-02, SEC-04, decisions 197 and 198): how many attempts one
 * subject -- an address, an account, an operator -- may make per window.
 * The counters live in Postgres, so every web process shares them.
 */
export const RATE_LIMITS = {
  'signin.ip': { limit: 120, windowSeconds: 600 },
  'magiclink.ip': { limit: 20, windowSeconds: 3600 },
  'magiclink.email': { limit: 5, windowSeconds: 3600 },
  'pairing.ip': { limit: 10, windowSeconds: 900 },
  'export.account': { limit: 5, windowSeconds: 3600 },
  'console.signin.ip': { limit: 10, windowSeconds: 900 },
  'console.signin.user': { limit: 5, windowSeconds: 900 },
  'console.totp': { limit: 1, windowSeconds: 90 },
} as const

export type RateBucket = keyof typeof RATE_LIMITS

/**
 * Count one attempt. Returns 0 when it is allowed, or the seconds until the
 * subject may try again. Through the auth handle: the application role, which
 * plugins run as, may not call the counter (decision 197).
 */
export async function rateLimit(bucket: RateBucket, subject: string): Promise<number> {
  const { limit, windowSeconds } = RATE_LIMITS[bucket]
  const { rows } = await authDb.execute<{ wait: number }>(
    sql`select public.campusos_rate_limit(${bucket}, ${subject}, ${limit}, ${windowSeconds}) as wait`,
  )
  return Number(rows[0]!.wait)
}
