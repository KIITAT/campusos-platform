import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { db } from './client'
import { institutions, users } from './schema'

/**
 * API credentials for the mobile client.
 *
 * The web app authenticates with an Auth.js database session in a cookie. A
 * Flutter app cannot hold one: the OAuth redirect lands in the system browser,
 * and the cookie it sets belongs there rather than to the app. So the phone
 * gets its own credential.
 *
 * Two objects, deliberately:
 *
 *  - a *pairing code*, short and short-lived, produced by an already
 *    signed-in web session and typed into the phone once;
 *  - a *device token*, long and long-lived, which the phone then holds.
 *
 * The pairing code exists so the long-lived credential never travels through a
 * QR photo, a screenshot or a chat message. It is six characters because it is
 * typed by a person, and it expires in ten minutes because that is how long it
 * takes to walk to a phone.
 *
 * Only hashes are stored. A stolen database backup yields no usable token, and
 * the hash is plain SHA-256 rather than a password KDF on purpose: these are
 * 256 bits of machine-generated randomness, not a passphrase, so there is
 * nothing to slow an attacker down about.
 */

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the token, hex. The token itself is shown once and never kept. */
    tokenHash: text('token_hash').notNull().unique(),
    /** sha256 of the pairing code, until it is redeemed. */
    pairingHash: text('pairing_hash').unique(),
    pairingExpiresAt: timestamp('pairing_expires_at', { withTimezone: true }),
    deviceName: text('device_name'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Deliberately not RLS-scoped, for the same reason as the Auth.js session
  // tables: a bearer token has to be resolved to a user *before* there is any
  // tenant context to scope by. Chicken and egg, and the rows hold only hashes
  // -- reading every one of them tells an attacker nothing they can present.
  (t) => [index('device_tokens_user').on(t.userId, t.revokedAt)],
)

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Unambiguous under a bad phone camera and a worse handwriting: no 0/O, 1/I. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const pairingCode = () => {
  const bytes = randomBytes(6)
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')
}

export const PAIRING_TTL_MS = 10 * 60 * 1000

export interface Pairing {
  /** Shown once, on the screen the person is already looking at. */
  code: string
  expiresAt: Date
}

/**
 * Begin pairing. Returns the code to read off the screen; the row holds only
 * its hash, so a database read cannot pair a phone.
 */
export async function startPairing(
  institutionId: string,
  userId: string,
  deviceName?: string | null,
): Promise<Pairing> {
  const code = pairingCode()
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS)

  // A pending pairing is replaced rather than accumulated: somebody who asks
  // twice because the first code scrolled away should not leave a live one.
  await db
    .delete(deviceTokens)
    .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.lastUsedAt), sql`${deviceTokens.pairingHash} is not null`))

  await db.insert(deviceTokens).values({
    institutionId,
    userId,
    tokenHash: `unclaimed:${sha256(code)}`,
    pairingHash: sha256(code),
    pairingExpiresAt: expiresAt,
    deviceName: deviceName ?? null,
  })

  return { code, expiresAt }
}

export interface ClaimedToken {
  token: string
  userId: string
  institutionId: string
}

/**
 * Redeem a pairing code for a device token.
 *
 * Unauthenticated by necessity -- the phone has no credential yet -- so it is
 * the one endpoint in the product where an attacker can guess. Six characters
 * from a 32-symbol alphabet is 2^30, single-use, ten minutes; the rate limit is
 * that a redeemed or expired code is gone.
 */
export async function claimPairing(
  code: string,
  deviceName?: string | null,
): Promise<ClaimedToken | null> {
  const hash = sha256(code.trim().toUpperCase())

  const [row] = await db
    .select()
    .from(deviceTokens)
    .where(eq(deviceTokens.pairingHash, hash))
  if (!row) return null

  if (!row.pairingExpiresAt || row.pairingExpiresAt.getTime() < Date.now()) {
    await db.delete(deviceTokens).where(eq(deviceTokens.id, row.id))
    return null
  }

  const token = randomBytes(32).toString('base64url')
  await db
    .update(deviceTokens)
    .set({
      tokenHash: sha256(token),
      // Single use: the code is consumed by redeeming it.
      pairingHash: null,
      pairingExpiresAt: null,
      deviceName: deviceName ?? row.deviceName,
      lastUsedAt: new Date(),
    })
    .where(eq(deviceTokens.id, row.id))

  return { token, userId: row.userId, institutionId: row.institutionId }
}

/**
 * Resolve a bearer token to a user id, or null.
 *
 * Looks up by hash rather than scanning, so this is an index hit regardless of
 * how many devices exist. The constant-time compare afterwards is belt and
 * braces: the lookup already leaked nothing, because the hash is what was
 * indexed.
 */
export async function userForToken(token: string): Promise<string | null> {
  if (!token || token.length < 20) return null
  const hash = sha256(token)

  const [row] = await db
    .select({
      id: deviceTokens.id,
      userId: deviceTokens.userId,
      tokenHash: deviceTokens.tokenHash,
      revokedAt: deviceTokens.revokedAt,
    })
    .from(deviceTokens)
    .where(eq(deviceTokens.tokenHash, hash))
  if (!row || row.revokedAt) return null

  const a = Buffer.from(row.tokenHash)
  const b = Buffer.from(hash)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  // Best-effort: a failed touch must not fail the request it is describing.
  void db
    .update(deviceTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(deviceTokens.id, row.id))
    .catch(() => {})

  return row.userId
}

export async function listDevices(userId: string) {
  return db
    .select({
      id: deviceTokens.id,
      deviceName: deviceTokens.deviceName,
      lastUsedAt: deviceTokens.lastUsedAt,
      revokedAt: deviceTokens.revokedAt,
      createdAt: deviceTokens.createdAt,
      pending: sql<boolean>`${deviceTokens.pairingHash} is not null`,
    })
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, userId))
    .orderBy(deviceTokens.createdAt)
}

/** Revoking is immediate and keeps the row, so "which phone was it" survives. */
export async function revokeDevice(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(deviceTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(deviceTokens.id, id), eq(deviceTokens.userId, userId)))
    .returning({ id: deviceTokens.id })
  return rows.length > 0
}
