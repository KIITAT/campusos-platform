import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
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
  childConsents,
  childOverview,
  childrenOf,
  claimLink,
  confirmAsAdult,
  inviteGuardian,
  listGuardianInvites,
  myChildren,
  myGuardians,
  recordChildConsent,
  withdrawGuardian,
  type Actor,
} from './api'
import { pages } from './pages'
import { routes } from './routes'
import { guardianInvites, links } from './schema'

// The audit trail is append-only (AUD-01): a reset cannot empty it, so each
// test reads only the rows written since its own reset.
let since = new Date(0)

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
const status = (e: unknown) => (e as ParentError).status

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
      since = new Date(Math.floor(Number((await tx.execute<{ ms: string }>(sql`select extract(epoch from clock_timestamp()) * 1000 as ms`)).rows[0]!.ms)))
    })
  }
  await authDb.delete(invitations).where(inArray(invitations.institutionId, [inst, other]))
  await retireGuardians()
  await authDb.delete(institutionModules).where(eq(institutionModules.institutionId, inst))
})

/**
 * Frees the test addresses. A guardian bound by invitation has an audit row
 * since P0-02 (NEW-10), which keeps their user row (DATA-09), so they are
 * renamed rather than deleted; deleting the institution takes them at the end.
 */
async function retireGuardians() {
  await authDb.delete(users).where(sql`${users.email} like '%@family.test' and ${users.institutionId} is null`)
  await authDb.update(users).set({ email: sql`${users.id} || '@retired.invalid'` }).where(sql`${users.email} like '%@family.test'`)
}

after(async () => {
  await retireGuardians()
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
    tx.select().from(auditLog).where(and(gte(auditLog.at, since), and(eq(auditLog.action, 'parents.guardian_withdrawn'), eq(auditLog.entityId, out.invitationId!)))),
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

// --- a guardian's access at 18 (AUD-04) ------------------------------------

const studentActor = (id: string): Actor => ({ id, email: null, role: 'student', institutionId: inst })

/** The student's age in whole years, in India; null clears the date. */
const setAge = (id: string, years: number | null) =>
  withTenant(inst, (tx) =>
    tx.execute(
      years === null
        ? sql`update users set date_of_birth = null where id = ${id}`
        : sql`update users set date_of_birth = ((now() at time zone 'Asia/Kolkata')::date - make_interval(years => ${years}))::date where id = ${id}`,
    ),
  )

/** A parent the office has verified for s1. */
async function verifiedParent(): Promise<{ parent: Actor; linkId: string }> {
  const [p] = await authDb
    .insert(users)
    .values({ email: `p-${crypto.randomUUID()}@family.test`, institutionId: inst, role: 'parent', name: 'Parent' })
    .returning({ id: users.id })
  const link = await claimLink(admin(), { studentId: ids.s1, parentId: p!.id, relation: 'mother' })
  return { parent: guardianActor(p!.id), linkId: link.id }
}

test('a guardian link lapses at 18 unless the student keeps it', async () => {
  const { parent, linkId } = await verifiedParent()
  for (const years of [null, 17]) {
    await setAge(ids.s1, years)
    assert.deepEqual(await childrenOf(parent), [ids.s1], `age ${years} keeps access`)
  }

  await setAge(ids.s1, 18)
  assert.deepEqual(await childrenOf(parent), [])
  await assert.rejects(childOverview(parent, ids.s1), (e) => code(e) === 'not_your_child')
  assert.equal((await myChildren(parent))[0]!.lapsed, true)

  await confirmAsAdult(studentActor(ids.s1), { linkId, keep: true })
  assert.deepEqual(await childrenOf(parent), [ids.s1])
  assert.equal((await myChildren(parent))[0]!.lapsed, false)

  await confirmAsAdult(studentActor(ids.s1), { linkId, keep: false })
  assert.deepEqual(await childrenOf(parent), [])
  await setAge(ids.s1, null)
})

test('only an adult student renews, and only their own links', async () => {
  const { linkId } = await verifiedParent()
  await setAge(ids.s1, 16)
  await assert.rejects(confirmAsAdult(studentActor(ids.s1), { linkId, keep: true }), (e) => code(e) === 'not_adult')
  await setAge(ids.s2, 19)
  await assert.rejects(confirmAsAdult(studentActor(ids.s2), { linkId, keep: true }), (e) => code(e) === 'no_such_link')
  await setAge(ids.s1, null)
  await setAge(ids.s2, null)
})

test('a renewal is audited', async () => {
  const { linkId } = await verifiedParent()
  await setAge(ids.s1, 19)
  await confirmAsAdult(studentActor(ids.s1), { linkId, keep: true })
  const rows = await withTenant(inst, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.action, 'parents.link_adult_kept'), eq(auditLog.entityId, linkId), gte(auditLog.at, since))),
  )
  assert.equal(rows.length, 1)
  await setAge(ids.s1, null)
})

test('a guardian gives and refuses consent for their child, through the route a parent can call', async () => {
  const { parent } = await verifiedParent()
  await setAge(ids.s1, 15)
  // The dispatcher gives a parent no viewerOf: the route must work without it.
  const route = routes.find((r) => r.method === 'POST' && r.path === '/consents')!
  const post = (decision: string) =>
    route.handler(parent, new Request('http://x/consents', { method: 'POST', body: JSON.stringify({ studentId: ids.s1, purpose: 'apaar', decision }) }))
  await post('given')
  const read = async () => (await childConsents(parent, ids.s1)).find((c) => c.purpose === 'apaar')!
  assert.equal((await read()).decision, 'given')
  assert.equal((await read()).basis, 'guardian')
  await post('refused')
  assert.equal((await read()).decision, 'refused')
  await setAge(ids.s1, null)
})

test('a guardian cannot record for a child that is not theirs, or whose access lapsed', async () => {
  const { parent } = await verifiedParent()
  const input = { studentId: ids.s2, purpose: 'apaar', decision: 'given' }
  await assert.rejects(recordChildConsent(parent, input), (e) => code(e) === 'not_your_child')
  await assert.rejects(childConsents(parent, ids.s2), (e) => code(e) === 'not_your_child')
  await setAge(ids.s1, 19)
  await assert.rejects(recordChildConsent(parent, { ...input, studentId: ids.s1 }), (e) => code(e) === 'not_your_child')
  await setAge(ids.s1, null)
  await assert.rejects(recordChildConsent(studentActor(ids.s1), { ...input, studentId: ids.s1 }), (e) => status(e) === 403)
})

test('a student sees who has access and keeps or ends it from a page', async () => {
  const { linkId } = await verifiedParent()
  await setAge(ids.s1, 19)
  const mine = await myGuardians(studentActor(ids.s1))
  const row = mine.find((m) => m.linkId === linkId)!
  assert.equal(row.lapsed, true)
  const page = pages.find((p) => p.roles?.includes('student'))!
  const data = (await page.load!(studentActor(ids.s1), new Request('http://x/'))) as Record<string, unknown>
  assert.ok(JSON.stringify(data).includes(linkId))
  await confirmAsAdult(studentActor(ids.s1), { linkId, keep: true })
  assert.equal((await myGuardians(studentActor(ids.s1))).find((m) => m.linkId === linkId)!.lapsed, false)
  await setAge(ids.s1, null)
})
