import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, inArray, sql } from 'drizzle-orm'
import { authDb, db, withTenant } from './client'
import {
  InvitationError,
  acceptInvitation,
  addressStatus,
  bindInvitedUser,
  invitations,
  invitedAccess,
  issueInvitation,
  peekInvitation,
  withdrawInvitation,
} from './invitations'
import { institutions, sessions, users } from './schema'

const SLUGS = ['invite-test', 'invite-other']
let inst: string
let other: string
let admin: string
let otherAdmin: string

const issue = (institutionId: string, by: string, email: string, days?: number) =>
  withTenant(institutionId, (tx) =>
    issueInvitation(tx, { institutionId, email, role: 'parent', createdBy: by, days }),
  )

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUGS[0]!, name: 'Invite College', allowedEmailDomains: ['invite.test'] },
      { slug: SLUGS[1]!, name: 'Other College', allowedEmailDomains: ['inviteother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@invite.test', institutionId: inst, role: 'institution_admin' },
      { email: 'adm@inviteother.test', institutionId: other, role: 'institution_admin' },
    ])
    .returning({ id: users.id })
  admin = people[0]!.id
  otherAdmin = people[1]!.id
})

beforeEach(async () => {
  await authDb.delete(invitations).where(inArray(invitations.institutionId, [inst, other]))
  await authDb.delete(users).where(sql`${users.email} like '%@guardian.test'`)
})

after(async () => {
  await authDb.delete(users).where(sql`${users.email} like '%@guardian.test'`)
  await authDb.delete(institutions).where(inArray(institutions.slug, SLUGS))
})

test('only the hash of the token is stored', async () => {
  const { token, invitation } = await issue(inst, admin, 'Mum@Guardian.test')
  assert.equal(invitation.email, 'mum@guardian.test', 'addresses are kept lower-case')
  const [row] = await authDb.select().from(invitations).where(eq(invitations.id, invitation.id))
  assert.ok(!JSON.stringify(row).includes(token))
  assert.ok(token.length >= 43, '256 bits, base64url')
})

test('an unaccepted invitation lets nobody in; accepting it lets exactly that address in', async () => {
  const { token } = await issue(inst, admin, 'mum@guardian.test')
  assert.deepEqual(await invitedAccess('mum@guardian.test'), { ok: false, reason: 'not_invited' })

  const peek = await peekInvitation(inst, token)
  assert.equal(peek?.state, 'open')
  await acceptInvitation(inst, token)
  await acceptInvitation(inst, token) // twice is fine

  const access = await invitedAccess('MUM@guardian.test')
  assert.ok(access.ok)
  assert.equal(access.institutionId, inst)
  assert.equal(access.role, 'parent')
  assert.deepEqual(await invitedAccess('dad@guardian.test'), { ok: false, reason: 'not_invited' })
})

test('a token is only good at the institution that issued it', async () => {
  const { token } = await issue(inst, admin, 'mum@guardian.test')
  assert.equal(await peekInvitation(other, token), null)
  await assert.rejects(acceptInvitation(other, token), (e) => (e as InvitationError).code === 'no_such_invitation')
})

test('reissuing supersedes the open invitation, and the old link stops working', async () => {
  const first = await issue(inst, admin, 'mum@guardian.test')
  const second = await issue(inst, admin, 'mum@guardian.test')
  assert.deepEqual(second.superseded, [first.invitation.id])
  await assert.rejects(acceptInvitation(inst, first.token), (e) => (e as InvitationError).code === 'revoked')
  await acceptInvitation(inst, second.token)
})

test('an expired invitation cannot be accepted', async () => {
  const { token, invitation } = await issue(inst, admin, 'mum@guardian.test', 1)
  await authDb
    .update(invitations)
    .set({ createdAt: new Date(Date.now() - 3 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000) })
    .where(eq(invitations.id, invitation.id))
  assert.equal((await peekInvitation(inst, token))?.state, 'expired')
  await assert.rejects(acceptInvitation(inst, token), (e) => (e as InvitationError).code === 'expired')
})

test('two institutions inviting one address is refused, not guessed between', async () => {
  const a = await issue(inst, admin, 'mum@guardian.test')
  const b = await issue(other, otherAdmin, 'mum@guardian.test')
  await acceptInvitation(inst, a.token)
  await acceptInvitation(other, b.token)
  assert.deepEqual(await invitedAccess('mum@guardian.test'), { ok: false, reason: 'ambiguous' })
})

test('the table refuses an invitation that would mint an administrator', async () => {
  await assert.rejects(
    withTenant(inst, (tx) =>
      issueInvitation(tx, { institutionId: inst, email: 'x@guardian.test', role: 'institution_admin', createdBy: admin }),
    ),
    (e) => /invitations_role/.test(String((e as { cause?: unknown }).cause)),
  )
})

test('binding a new account gives it the invited institution and role, and records it', async () => {
  const { token, invitation } = await issue(inst, admin, 'mum@guardian.test')
  const [u] = await authDb.insert(users).values({ email: 'mum@guardian.test' }).returning({ id: users.id })
  assert.equal(await bindInvitedUser(u!.id, 'mum@guardian.test'), false, 'not before acceptance')

  await acceptInvitation(inst, token)
  assert.equal(await bindInvitedUser(u!.id, 'mum@guardian.test'), true)
  const [bound] = await authDb.select().from(users).where(eq(users.id, u!.id))
  assert.equal(bound!.institutionId, inst)
  assert.equal(bound!.role, 'parent')
  const [inv] = await authDb.select().from(invitations).where(eq(invitations.id, invitation.id))
  assert.equal(inv!.userId, u!.id)
})

test('a withdrawn invitation stops letting the address in', async () => {
  const { token, invitation } = await issue(inst, admin, 'mum@guardian.test')
  await acceptInvitation(inst, token)
  await authDb
    .update(invitations)
    .set({ revokedAt: new Date(), revokedBy: admin, revokeReason: 'custody order' })
    .where(eq(invitations.id, invitation.id))
  assert.deepEqual(await invitedAccess('mum@guardian.test'), { ok: false, reason: 'not_invited' })
})

test('another institution cannot see the invitations', async () => {
  await issue(inst, admin, 'mum@guardian.test')
  const seen = await withTenant(other, (tx) => tx.select().from(invitations))
  assert.equal(seen.length, 0)
})

test('withdrawing an accepted invitation takes the account back to pending and ends its sessions', async () => {
  const { token, invitation } = await issue(inst, admin, 'mum@guardian.test')
  await acceptInvitation(inst, token)
  const [u] = await authDb.insert(users).values({ email: 'mum@guardian.test' }).returning({ id: users.id })
  await bindInvitedUser(u!.id, 'mum@guardian.test')
  await authDb.insert(sessions).values({ sessionToken: `t-${u!.id}`, userId: u!.id, expires: new Date(Date.now() + 86_400_000) })

  const done = await withTenant(inst, (tx) =>
    withdrawInvitation(tx, { invitationId: invitation.id, by: admin, reason: 'court order' }),
  )
  assert.equal(done?.revokeReason, 'court order')
  const [after] = await authDb.select().from(users).where(eq(users.id, u!.id))
  assert.equal(after!.role, 'pending')
  assert.equal((await authDb.select().from(sessions).where(eq(sessions.userId, u!.id))).length, 0)
  assert.deepEqual(await invitedAccess('mum@guardian.test'), { ok: false, reason: 'not_invited' })
  assert.equal(
    await withTenant(inst, (tx) => withdrawInvitation(tx, { invitationId: invitation.id, by: admin, reason: 'again' })),
    null,
    'once',
  )
})

test('an address is free, a member here, or taken -- and taken says nothing more', async () => {
  const status = (institutionId: string, email: string) =>
    withTenant(institutionId, (tx) => addressStatus(tx, email))
  assert.deepEqual(await status(inst, 'nobody@guardian.test'), { kind: 'free' })
  const here = await status(inst, 'ADM@invite.test')
  assert.equal(here.kind, 'member')
  assert.deepEqual(await status(inst, 'adm@inviteother.test'), { kind: 'taken' })

  const b = await issue(other, otherAdmin, 'mum@guardian.test')
  assert.deepEqual(await status(inst, 'mum@guardian.test'), { kind: 'free' }, 'an open invitation elsewhere is not yet anything')
  await acceptInvitation(other, b.token)
  assert.deepEqual(await status(inst, 'mum@guardian.test'), { kind: 'taken' })
})

test('the application role can ask whether an address is taken, and only from inside a tenant', async () => {
  // As a module would: the app role, under row level security, which hides
  // the other institution's user entirely.
  const hidden = await withTenant(inst, (tx) =>
    tx.select().from(users).where(eq(users.email, 'adm@inviteother.test')),
  )
  assert.equal(hidden.length, 0, 'the other institution is invisible to the app role')
  assert.deepEqual(await withTenant(inst, (tx) => addressStatus(tx, 'adm@inviteother.test')), { kind: 'taken' })

  const res = await db.execute(sql`select campusos_address_taken_elsewhere('adm@inviteother.test') as taken`)
  assert.equal((res.rows[0] as { taken: unknown }).taken, null, 'no tenant, no answer')
})
