import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  acceptInvitation,
  auditLog,
  authDb,
  bindInvitedUser,
  institutionModules,
  institutions,
  invitations,
  invitedAccess,
  sessions,
  users,
  withTenant,
} from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { myAttendance } from '@campusos/module-attendance/api'
import { transcript } from '@campusos/module-examinations/api'
import { studentLedger } from '@campusos/module-fees/api'
import { myHostel } from '@campusos/module-hostel/api'
import { borrowerStatus } from '@campusos/module-library/api'
import { matchRoute } from '@campusos/module-framework'
import {
  ParentError,
  childOverview,
  childrenOf,
  inviteGuardian,
  listGuardianInvites,
  myChildren,
  withdrawGuardian,
  type Actor,
} from './api'
import { routes } from './routes'
import { guardianInvites, links } from './schema'

/**
 * Phase G: a guardian arrives by invitation, not by domain, and sees exactly
 * the children the office named -- whatever ids they try.
 */

const SLUG = 'guardian-test'
const OTHER = 'guardian-other'
let inst = ''
let other = ''
const ids = { adm: '', otherAdm: '', s1: '', s2: '', s3: '', staff: '' }
let termId = ''

const admin = (): Actor => ({ id: ids.adm, email: 'adm@guardian-college.test', role: 'institution_admin', institutionId: inst })
const guardianActor = (id: string): Actor => ({ id, email: null, role: 'parent', institutionId: inst })
const code = (e: unknown) => (e as ParentError).code

/** What the host does at sign-in: a new account row, then bind it by invitation. */
async function signUp(email: string) {
  const [u] = await authDb.insert(users).values({ email, name: email.split('@')[0] }).returning({ id: users.id })
  assert.equal(await bindInvitedUser(u!.id, email), true, `${email} should be admitted`)
  return u!.id
}

/** The guardian opens the link: the token is the tail of what the office was given. */
const accept = (link: string | null, institutionId = inst) =>
  acceptInvitation(institutionId, link!.replace('/invite/', ''))

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Guardian College', allowedEmailDomains: ['guardian-college.test'] },
      { slug: OTHER, name: 'Elsewhere College', allowedEmailDomains: ['elsewhere.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@guardian-college.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'adm@elsewhere.test', institutionId: other, role: 'institution_admin', name: 'Other Adm' },
      { email: 's1@guardian-college.test', institutionId: inst, role: 'student', name: 'Asha' },
      { email: 's2@guardian-college.test', institutionId: inst, role: 'student', name: 'Bilal' },
      { email: 's3@elsewhere.test', institutionId: other, role: 'student', name: 'Chen' },
      { email: 'teacher@guardian-college.test', institutionId: inst, role: 'faculty', name: 'Teacher' },
    ])
    .returning({ id: users.id })
  ;[ids.adm, ids.otherAdm, ids.s1, ids.s2, ids.s3, ids.staff] = people.map((p) => p.id) as [string, string, string, string, string, string]

  termId = (await academic.createTerm(admin(), { code: 'g1', name: 'Sem 1', startsOn: '2026-07-01', endsOn: '2026-11-30' })).id
  await academic.setCurrentTerm(admin(), { termId })
})

beforeEach(async () => {
  for (const t of [inst, other]) {
    await withTenant(t, async (tx) => {
      await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
      await tx.delete(links)
      await tx.delete(guardianInvites)
      await tx.delete(auditLog)
    })
  }
  await authDb.delete(invitations).where(inArray(invitations.institutionId, [inst, other]))
  await authDb.delete(users).where(sql`${users.email} like '%@family.test'`)
  await authDb.delete(institutionModules).where(eq(institutionModules.institutionId, inst))
})

after(async () => {
  await authDb.delete(users).where(sql`${users.email} like '%@family.test'`)
  await authDb.delete(institutions).where(inArray(institutions.slug, [SLUG, OTHER]))
})

test('invite, accept, sign in: the guardian sees the child the office named, already verified', async () => {
  const out = await inviteGuardian(admin(), { email: 'Mum@Family.test', studentId: ids.s1, relation: 'mother' })
  assert.equal(out.email, 'mum@family.test')
  assert.match(out.link!, /^\/invite\/[A-Za-z0-9_-]{43}$/)
  assert.match(out.notice, /shown only now/)

  // Before accepting, the address is nobody.
  assert.deepEqual(await invitedAccess('mum@family.test'), { ok: false, reason: 'not_invited' })

  await accept(out.link)
  const mum = await signUp('mum@family.test')

  assert.deepEqual(await childrenOf(guardianActor(mum)), [ids.s1])
  const [link] = await myChildren(guardianActor(mum))
  assert.equal(link!.relation, 'mother')
  assert.ok(link!.verifiedAt, 'verified by the invitation, not a second decision')
  const [row] = await withTenant(inst, (tx) => tx.select().from(links).where(eq(links.parentId, mum)))
  assert.equal(row!.verifiedBy, ids.adm, 'vouched for by whoever issued it')

  const view = await childOverview(guardianActor(mum), ids.s1)
  assert.equal(view.studentName, 'Asha')
})

test('a second child for the same address is one link, and the first child carries over', async () => {
  const first = await inviteGuardian(admin(), { email: 'dad@family.test', studentId: ids.s1, relation: 'father' })
  const second = await inviteGuardian(admin(), { email: 'dad@family.test', studentId: ids.s2, relation: 'father' })

  await assert.rejects(accept(first.link), /withdrawn/, 'the first link was replaced')
  await accept(second.link)
  const dad = await signUp('dad@family.test')
  assert.deepEqual((await childrenOf(guardianActor(dad))).sort(), [ids.s1, ids.s2].sort())

  const listed = await listGuardianInvites(admin())
  const live = listed.find((i) => i.id === second.invitationId)!
  assert.equal(live.state, 'accepted')
  assert.match(live.children, /Asha \(father\)/)
  assert.match(live.children, /Bilal \(father\)/)
  assert.equal(listed.find((i) => i.id === first.invitationId)!.state, 'revoked')
})

test('the guardian cannot reach another student by guessing ids -- through the portal or around it', async () => {
  for (const m of ['attendance', 'examinations', 'fees', 'library', 'hostel']) {
    await authDb.insert(institutionModules).values({ institutionId: inst, moduleId: m, enabled: true })
  }
  const out = await inviteGuardian(admin(), { email: 'mum@family.test', studentId: ids.s1, relation: 'mother' })
  await accept(out.link)
  const mum = guardianActor(await signUp('mum@family.test'))

  // Through the portal, with the ids of a classmate and of a student at another college.
  for (const guess of [ids.s2, ids.s3, ids.staff, 'not-an-id']) {
    await assert.rejects(childOverview(mum, guess), (e) => code(e) === 'not_your_child', guess)
  }

  // Through the portal's own route, as the dispatcher would call it.
  const child = matchRoute(routes, 'GET', '/child')!
  await assert.rejects(
    child.handler(mum, new Request(`http://x/child?studentId=${ids.s2}`)),
    (e) => code(e) === 'not_your_child',
  )

  // Around the portal: every module's per-student read, called with the
  // guardian as they are -- a parent, with no viewer scope, because only the
  // portal ever hands one down and only for a verified child.
  const direct: [string, () => Promise<unknown>][] = [
    ['attendance', () => myAttendance(mum, ids.s2)],
    ['examinations', () => transcript(mum, ids.s2)],
    ['fees', () => studentLedger(mum, ids.s2, termId)],
    ['library', () => borrowerStatus(mum, ids.s2)],
    ['hostel', () => myHostel(mum, ids.s2)],
    // Their own child directly is refused too: the scope is per request.
    ['fees, own child without the portal', () => studentLedger(mum, ids.s1, termId)],
  ]
  for (const [name, call] of direct) {
    await assert.rejects(call, (e) => (e as { status?: number }).status === 403, name)
  }

  // And the one they may see still works through the portal, with every section.
  const view = await childOverview(mum, ids.s1)
  assert.deepEqual(view.sections.sort(), ['attendance', 'examinations', 'fees', 'hostel', 'library'])
})

test('an address the institution s own domain admits cannot be invited as a guardian', async () => {
  await assert.rejects(
    inviteGuardian(admin(), { email: 'newperson@guardian-college.test', studentId: ids.s1, relation: 'mother' }),
    (e) => code(e) === 'member_address',
  )
  await assert.rejects(
    inviteGuardian(admin(), { email: 'teacher@guardian-college.test', studentId: ids.s1, relation: 'father' }),
    (e) => code(e) === 'member_address',
  )
})

test('an address that is somebody s account elsewhere is refused, and says nothing more', async () => {
  await assert.rejects(
    inviteGuardian(admin(), { email: 'adm@elsewhere.test', studentId: ids.s1, relation: 'aunt' }),
    (e) => code(e) === 'address_in_use' && !/Elsewhere College/.test((e as Error).message),
  )
})

test('an existing guardian here is linked on the spot, no invitation needed', async () => {
  const out = await inviteGuardian(admin(), { email: 'mum@family.test', studentId: ids.s1, relation: 'mother' })
  await accept(out.link)
  const mum = await signUp('mum@family.test')
  await childrenOf(guardianActor(mum))

  const again = await inviteGuardian(admin(), { email: 'mum@family.test', studentId: ids.s2, relation: 'mother' })
  assert.equal(again.link, null)
  assert.equal(again.invitationId, null)
  assert.deepEqual((await childrenOf(guardianActor(mum))).sort(), [ids.s1, ids.s2].sort())
})

test('only the office invites, and only a student can be the child', async () => {
  const teacher: Actor = { id: ids.staff, email: null, role: 'faculty', institutionId: inst }
  await assert.rejects(
    inviteGuardian(teacher, { email: 'x@family.test', studentId: ids.s1, relation: 'mother' }),
    (e) => code(e) === 'forbidden',
  )
  await assert.rejects(
    inviteGuardian(admin(), { email: 'x@family.test', studentId: ids.staff, relation: 'mother' }),
    (e) => code(e) === 'not_a_student',
  )
  await assert.rejects(
    inviteGuardian(admin(), { email: 'x@family.test', studentId: ids.s3, relation: 'mother' }),
    (e) => code(e) === 'no_such_student',
    'a student at another institution is not a student here',
  )
})

test('withdrawing after acceptance ends access now: links gone, account pending, sessions ended', async () => {
  const out = await inviteGuardian(admin(), { email: 'mum@family.test', studentId: ids.s1, relation: 'mother' })
  await accept(out.link)
  const mum = await signUp('mum@family.test')
  await childrenOf(guardianActor(mum))
  await authDb.insert(sessions).values({ sessionToken: `g-${mum}`, userId: mum, expires: new Date(Date.now() + 86_400_000) })

  await withdrawGuardian(admin(), { invitationId: out.invitationId, reason: 'court order received' })

  const [u] = await authDb.select().from(users).where(eq(users.id, mum))
  assert.equal(u!.role, 'pending')
  assert.equal((await authDb.select().from(sessions).where(eq(sessions.userId, mum))).length, 0)
  assert.equal((await withTenant(inst, (tx) => tx.select().from(links).where(eq(links.parentId, mum)))).length, 0)
  assert.deepEqual(await invitedAccess('mum@family.test'), { ok: false, reason: 'not_invited' })

  const [row] = await withTenant(inst, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.action, 'parents.guardian_withdrawn'), eq(auditLog.entityId, out.invitationId!))),
  )
  assert.equal(row!.reason, 'court order received')

  await assert.rejects(
    withdrawGuardian(admin(), { invitationId: out.invitationId, reason: 'again, twice' }),
    (e) => code(e) === 'already_withdrawn',
  )
})

test('a guardian of one institution is not a guardian of another', async () => {
  const out = await inviteGuardian(admin(), { email: 'mum@family.test', studentId: ids.s1, relation: 'mother' })
  // The other college's token check: this link means nothing there.
  await assert.rejects(accept(out.link, other), /not valid/)
  await accept(out.link)
  const mum = await signUp('mum@family.test')
  const elsewhere: Actor = { id: mum, email: null, role: 'parent', institutionId: other }
  assert.deepEqual(await childrenOf(elsewhere), [])
  await assert.rejects(childOverview(elsewhere, ids.s3), (e) => code(e) === 'not_your_child')
  const seen = await withTenant(other, (tx) => tx.select().from(invitations))
  assert.equal(seen.length, 0, 'invitations are tenant-scoped')
})
