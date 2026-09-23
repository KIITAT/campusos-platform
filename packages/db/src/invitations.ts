import { createHash, randomBytes } from 'node:crypto'
import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { authDb, withTenant } from './client'
import { tenantPolicy } from './rls'
import { institutions, roleEnum, sessions, users } from './schema'

/**
 * Invitations: the one way into an institution that is not its email domain.
 *
 * The domain gate admits anybody whose Google address ends in a domain the
 * institution claims, which is right for staff and students and useless for a
 * guardian, whose address is their own. Widening the gate to "any address"
 * would let the whole of gmail.com in. So the institution names the address,
 * and only that address, and only once somebody holding the link has accepted
 * it.
 *
 * The link is not the credential. Signing in still proves control of the
 * address -- Google asserts a verified email, or an emailed sign-in link does
 * -- so a link forwarded to the wrong person gets them nothing: it lets the
 * named address in, and they do not hold it. What the link adds is the
 * institution's say-so, an expiry, and a moment where the guardian agrees.
 *
 * Only a hash of the token is kept, like device tokens and for the same
 * reason. It is 256 bits of randomness, so plain SHA-256 is enough.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: roleEnum().notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    /** The account it became, once that account exists. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    index('invitations_email').on(t.email),
    // One open invitation per address per institution. Issuing another
    // supersedes the first rather than leaving two live links about.
    uniqueIndex('invitations_one_open')
      .on(t.institutionId, t.email)
      .where(sql`accepted_at is null and revoked_at is null`),
    check('invitations_email_lower', sql`email = lower(email) and position('@' in email) > 1`),
    // An invitation can never mint an administrator, or an account with no
    // role. Whatever a future screen offers, the table refuses.
    check(
      'invitations_role',
      sql`role not in ('super_admin', 'institution_admin', 'pending')`,
    ),
    check('invitations_expiry', sql`expires_at > created_at`),
    check('invitations_revoke_reason', sql`revoked_at is null or length(trim(revoke_reason)) > 0`),
    tenantPolicy('invitations'),
  ],
)

export type Invitation = typeof invitations.$inferSelect
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export const normaliseEmail = (email: string) => email.trim().toLowerCase()

export const INVITATION_MAX_DAYS = 30

export interface Issued {
  invitation: Invitation
  /** Shown once, to whoever issued it. Never stored. */
  token: string
  /** Open invitations to the same address this one replaced. */
  superseded: string[]
}

/**
 * Issue an invitation inside the caller's transaction, so whatever the caller
 * attaches to it (a guardian's child, say) commits or fails with it.
 */
export async function issueInvitation(
  tx: Tx,
  input: {
    institutionId: string
    email: string
    role: Invitation['role']
    createdBy: string
    days?: number
  },
): Promise<Issued> {
  const email = normaliseEmail(input.email)
  const days = Math.min(Math.max(Math.trunc(input.days ?? 7), 1), INVITATION_MAX_DAYS)
  const token = randomBytes(32).toString('base64url')

  const old = await tx
    .update(invitations)
    .set({ revokedAt: new Date(), revokedBy: input.createdBy, revokeReason: 'superseded' })
    .where(
      and(
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .returning({ id: invitations.id })

  const [invitation] = await tx
    .insert(invitations)
    .values({
      institutionId: input.institutionId,
      email,
      role: input.role,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + days * 86_400_000),
      createdBy: input.createdBy,
    })
    .returning()

  return { invitation: invitation!, token, superseded: old.map((o) => o.id) }
}

export type InvitationState = 'open' | 'accepted' | 'expired' | 'revoked'

export const stateOf = (i: Pick<Invitation, 'acceptedAt' | 'revokedAt' | 'expiresAt'>, now = new Date()): InvitationState =>
  i.revokedAt ? 'revoked' : i.acceptedAt ? 'accepted' : i.expiresAt <= now ? 'expired' : 'open'

/** What a link points at, for the page that shows it. Nothing is changed. */
export async function peekInvitation(institutionId: string, token: string) {
  return withTenant(institutionId, async (tx) => {
    const [row] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, sha256(token)))
    return row ? { invitation: row, state: stateOf(row) } : null
  })
}

export class InvitationError extends Error {
  constructor(
    readonly code: 'no_such_invitation' | 'expired' | 'revoked',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Accept. Idempotent once accepted -- a guardian who clicks the link twice has
 * not done anything wrong -- and the expiry applies to accepting, not to using
 * the access afterwards.
 */
export async function acceptInvitation(institutionId: string, token: string): Promise<Invitation> {
  return withTenant(institutionId, async (tx) => {
    const [row] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, sha256(token)))
      .for('update')
    if (!row) throw new InvitationError('no_such_invitation', 'That invitation link is not valid.')
    const state = stateOf(row)
    if (state === 'revoked') {
      throw new InvitationError('revoked', 'That invitation was withdrawn. Ask the office for a new one.')
    }
    if (state === 'accepted') return row
    if (state === 'expired') {
      throw new InvitationError('expired', 'That invitation has expired. Ask the office for a new one.')
    }
    const [done] = await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(invitations.id, row.id))
      .returning()
    return done!
  })
}

export type InvitedAccess =
  | { ok: true; institutionId: string; role: Invitation['role']; invitationIds: string[] }
  | { ok: false; reason: 'not_invited' | 'ambiguous' }

/**
 * Whether an address may sign in on the strength of an invitation.
 *
 * Runs before any tenant is known -- sign-in happens on the root domain -- so
 * it reads through the owner connection, exactly as the domain lookup does.
 * Accepted and not withdrawn is the whole test. Two institutions having
 * invited one address is refused rather than guessed between: an account
 * belongs to one institution, and picking one would be a coin toss over whose
 * data somebody sees.
 */
export async function invitedAccess(email: string): Promise<InvitedAccess> {
  const rows = await authDb
    .select({
      id: invitations.id,
      institutionId: invitations.institutionId,
      role: invitations.role,
      suspendedAt: institutions.suspendedAt,
    })
    .from(invitations)
    .innerJoin(institutions, eq(institutions.id, invitations.institutionId))
    .where(
      and(
        eq(invitations.email, normaliseEmail(email)),
        isNotNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
  const live = rows.filter((r) => !r.suspendedAt)
  if (live.length === 0) return { ok: false, reason: 'not_invited' }
  const places = new Set(live.map((r) => `${r.institutionId}:${r.role}`))
  if (places.size > 1) return { ok: false, reason: 'ambiguous' }
  return {
    ok: true,
    institutionId: live[0]!.institutionId,
    role: live[0]!.role,
    invitationIds: live.map((r) => r.id),
  }
}

/**
 * Bind a brand-new account to the institution that invited its address, with
 * the invited role, and record which account each invitation became. The
 * counterpart of binding by domain; called once, straight after the row
 * appears.
 */
export async function bindInvitedUser(userId: string, email: string): Promise<boolean> {
  const access = await invitedAccess(email)
  if (!access.ok) return false
  await authDb
    .update(users)
    .set({ institutionId: access.institutionId, role: access.role })
    .where(and(eq(users.id, userId), isNull(users.institutionId)))
  await authDb
    .update(invitations)
    .set({ userId })
    .where(and(inArray(invitations.id, access.invitationIds), isNull(invitations.userId)))
  return true
}

/**
 * Withdraw an invitation, before or after it was accepted.
 *
 * After is the case that matters: a guardian losing access is usually a
 * custody or safeguarding decision, and it has to take effect now, not when a
 * session cookie happens to expire. So the account it became is set back to
 * pending -- the session callback reads the role on every request -- and its
 * sessions are ended. Inside the caller's transaction, beside the audit row.
 */
export async function withdrawInvitation(
  tx: Tx,
  input: { invitationId: string; by: string; reason: string },
): Promise<Invitation | null> {
  const [row] = await tx
    .update(invitations)
    .set({ revokedAt: new Date(), revokedBy: input.by, revokeReason: input.reason })
    .where(and(eq(invitations.id, input.invitationId), isNull(invitations.revokedAt)))
    .returning()
  if (!row) return null
  if (row.userId) {
    await tx.update(users).set({ role: 'pending' }).where(eq(users.id, row.userId))
    await tx.delete(sessions).where(eq(sessions.userId, row.userId))
  }
  return row
}

export type AddressStatus =
  | { kind: 'free' }
  | { kind: 'member'; userId: string; role: Invitation['role'] }
  | { kind: 'taken' }

/**
 * What an address already is, from where an institution stands.
 *
 * An account belongs to one institution, and an address to one account, so an
 * address that is somebody's elsewhere cannot be invited here: it would sign
 * in to the account it already has, or -- if two institutions had both invited
 * it -- to neither.
 *
 * Runs in the caller's tenant transaction, as the application role: a module
 * cannot open the owner connection, and should not. The member check is an
 * ordinary query the users policy already scopes to this institution; the
 * question about everybody else is asked of campusos_address_taken_elsewhere
 * (core migration 0003), which answers yes or no and nothing more.
 */
export async function addressStatus(tx: Tx, email: string): Promise<AddressStatus> {
  const address = normaliseEmail(email)
  const [user] = await tx
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(sql`lower(${users.email}) = ${address}`)
  if (user) return { kind: 'member', userId: user.id, role: user.role }
  const res = await tx.execute(sql`select campusos_address_taken_elsewhere(${address}) as taken`)
  const taken = (res.rows[0] as { taken: boolean | null } | undefined)?.taken
  if (taken === null || taken === undefined) {
    throw new Error('addressStatus needs a tenant transaction')
  }
  return taken ? { kind: 'taken' } : { kind: 'free' }
}
