import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import {
  auditLog,
  authDb,
  db,
  institutionModules,
  institutions,
  users,
  withTenant,
} from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import * as fees from '@campusos/module-fees/api'
import { transcript } from '@campusos/module-examinations/api'
import {
  ParentError,
  childOverview,
  childrenOf,
  claimLink,
  decideLink,
  listLinks,
  myChildren,
  revokeLink,
  type Actor,
} from './api'
import { links } from './schema'

const SLUG = 'parent-test'
const OTHER = 'parent-other'
let inst: string
let other: string
const ids = { adm: '', p1: '', p2: '', s1: '', s2: '' }
let termId = ''

const A = (over: Partial<Actor>): Actor => ({
  id: ids.adm,
  email: 'adm@parent.test',
  role: 'institution_admin',
  institutionId: inst,
  ...over,
})
const admin = () => A({})
const parent = (id: string) => A({ id, role: 'parent' })
const student = (id: string) => A({ id, role: 'student' })
const code = (e: unknown) => (e as ParentError).code
const status = (e: unknown) => (e as ParentError).status

async function setModule(id: string, on: boolean) {
  await db
    .insert(institutionModules)
    .values({ institutionId: inst, moduleId: id, enabled: on })
    .onConflictDoUpdate({
      target: [institutionModules.institutionId, institutionModules.moduleId],
      set: { enabled: on },
    })
}

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Parent College', allowedEmailDomains: ['parent.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['parentother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@parent.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'p1@parent.test', institutionId: inst, role: 'parent', name: 'One Parent' },
      { email: 'p2@parent.test', institutionId: inst, role: 'parent', name: 'Two Parent' },
      { email: 's1@parent.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@parent.test', institutionId: inst, role: 'student', name: 'Two Student' },
    ])
    .returning({ id: users.id })
  ids.adm = people[0]!.id
  ids.p1 = people[1]!.id
  ids.p2 = people[2]!.id
  ids.s1 = people[3]!.id
  ids.s2 = people[4]!.id

  const st = admin()
  const dept = await academic.createDepartment(st, { code: 'cse', name: 'CSE' })
  const prog = await academic.createProgram(st, {
    departmentId: dept.id, code: 'btech', name: 'BTech',
    level: 'undergraduate', durationTerms: 8,
  })
  termId = (
    await academic.createTerm(st, {
      code: 't1', name: 'Sem 1', startsOn: '2026-01-05', endsOn: '2026-05-30',
    })
  ).id
  const section = await academic.createSection(st, {
    programId: prog.id, label: 'a', admissionYear: 2026,
  })
  await academic.addSectionMember(st, { sectionId: section.id, userId: ids.s1 })
  await academic.addSectionMember(st, { sectionId: section.id, userId: ids.s2 })
  await academic.setCurrentTerm(st, { termId })
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(links)
    await tx.delete(auditLog)
  })
  for (const m of ['attendance', 'examinations', 'fees', 'library', 'hostel']) {
    await setModule(m, false)
  }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

// --- linking ---------------------------------------------------------------

test('a claimed link shows nothing until the institution verifies it', async () => {
  const link = await claimLink(parent(ids.p1), { studentId: ids.s1, relation: 'father' })
  assert.equal(link.verifiedAt, null)
  assert.deepEqual(await childrenOf(parent(ids.p1)), [])

  await assert.rejects(
    () => childOverview(parent(ids.p1), ids.s1),
    (e: unknown) => code(e) === 'not_your_child',
  )

  await decideLink(admin(), { linkId: link.id, approve: true, reason: 'identity checked at the office' })
  assert.deepEqual(await childrenOf(parent(ids.p1)), [ids.s1])
  assert.equal((await childOverview(parent(ids.p1), ids.s1)).studentId, ids.s1)
})

test('a link an administrator registers is verified by that act', async () => {
  const link = await claimLink(admin(), {
    parentId: ids.p1,
    studentId: ids.s1,
    relation: 'mother',
  })
  assert.ok(link.verifiedAt)
  assert.deepEqual(await childrenOf(parent(ids.p1)), [ids.s1])
})

test('a parent cannot claim on somebody else s behalf', async () => {
  const link = await claimLink(parent(ids.p1), {
    parentId: ids.p2,
    studentId: ids.s1,
    relation: 'father',
  })
  assert.equal(link.parentId, ids.p1, 'the parentId field is ignored for a parent')
})

test('a student cannot claim a link at all', async () => {
  await assert.rejects(
    () => claimLink(student(ids.s1), { studentId: ids.s2, relation: 'sibling' }),
    (e: unknown) => status(e) === 403,
  )
})

test('a link can only point at a student', async () => {
  await assert.rejects(
    () => claimLink(parent(ids.p1), { studentId: ids.adm, relation: 'father' }),
    (e: unknown) => code(e) === 'not_a_student',
  )
})

test('the same pair cannot be linked twice', async () => {
  await claimLink(parent(ids.p1), { studentId: ids.s1, relation: 'father' })
  await assert.rejects(
    () => claimLink(parent(ids.p1), { studentId: ids.s1, relation: 'father' }),
    (e: unknown) => code(e) === 'exists',
  )
})

test('refusing a link records why, and it stays refused', async () => {
  const link = await claimLink(parent(ids.p1), { studentId: ids.s1, relation: 'uncle' })
  const refused = await decideLink(admin(), {
    linkId: link.id,
    approve: false,
    reason: 'no documentation produced',
  })
  assert.equal(refused.verifiedAt, null)
  assert.match(refused.refusedReason!, /no documentation/)
  assert.deepEqual(await childrenOf(parent(ids.p1)), [])
})

test('deciding twice on a verified link is refused', async () => {
  const link = await claimLink(admin(), {
    parentId: ids.p1, studentId: ids.s1, relation: 'father',
  })
  await assert.rejects(
    () => decideLink(admin(), { linkId: link.id, approve: true, reason: 'again for no reason' }),
    (e: unknown) => code(e) === 'already_verified',
  )
})

test('verifying and revoking are both audited', async () => {
  const link = await claimLink(parent(ids.p1), { studentId: ids.s1, relation: 'father' })
  await decideLink(admin(), { linkId: link.id, approve: true, reason: 'identity checked at the office' })
  await revokeLink(admin(), { linkId: link.id, reason: 'court order restricting contact' })

  const trail = await withTenant(inst, (tx) =>
    tx.select({ action: auditLog.action, reason: auditLog.reason }).from(auditLog),
  )
  assert.deepEqual(
    trail.map((t) => t.action),
    ['parents.link_verified', 'parents.link_revoked'],
  )
  assert.deepEqual(await childrenOf(parent(ids.p1)), [], 'sight is withdrawn immediately')
})

test('only an administrator decides or revokes', async () => {
  const link = await claimLink(parent(ids.p1), { studentId: ids.s1, relation: 'father' })
  await assert.rejects(
    () => decideLink(parent(ids.p1), { linkId: link.id, approve: true, reason: 'approving myself' }),
    (e: unknown) => status(e) === 403,
  )
  await assert.rejects(
    () => revokeLink(parent(ids.p1), { linkId: link.id, reason: 'removing my own record' }),
    (e: unknown) => status(e) === 403,
  )
})

test('the office sees pending claims and who they are for', async () => {
  await claimLink(parent(ids.p1), { studentId: ids.s1, relation: 'father' })
  const pending = await listLinks(admin(), true)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.studentName, 'One Student')
  assert.equal(pending[0]!.parentName, 'One Parent')
})

test('a parent sees their own claims, verified or not', async () => {
  await claimLink(parent(ids.p1), { studentId: ids.s1, relation: 'father' })
  const mine = await myChildren(parent(ids.p1))
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.verifiedAt, null)
  assert.equal((await myChildren(parent(ids.p2))).length, 0)
})

// --- the lens --------------------------------------------------------------

test('a parent cannot see a child who is not theirs', async () => {
  await claimLink(admin(), { parentId: ids.p1, studentId: ids.s1, relation: 'father' })
  await assert.rejects(
    () => childOverview(parent(ids.p1), ids.s2),
    (e: unknown) => code(e) === 'not_your_child',
  )
})

test('with no modules enabled the portal shows the child and nothing else', async () => {
  await claimLink(admin(), { parentId: ids.p1, studentId: ids.s1, relation: 'father' })
  const view = await childOverview(parent(ids.p1), ids.s1)

  assert.equal(view.studentName, 'One Student')
  assert.deepEqual(view.sections, [])
  assert.equal(view.fees, null, 'absent, not zero')
  assert.equal(view.results, null)
  assert.equal(view.attendance, null)
  assert.equal(view.library, null)
  assert.equal(view.hostel, null)
})

test('enabling a module makes its section appear, and only that one', async () => {
  await claimLink(admin(), { parentId: ids.p1, studentId: ids.s1, relation: 'father' })
  await setModule('fees', true)

  await fees.createFeeItem(admin(), {
    programId: (await academic.listStructure(admin())).programs[0]!.id,
    termId,
    label: 'Tuition',
    amount: '45000',
  })

  const view = await childOverview(parent(ids.p1), ids.s1)
  assert.deepEqual(view.sections, ['fees'])
  assert.equal(view.fees!.payablePaise, 4_500_000)
  assert.equal(view.fees!.outstandingPaise, 4_500_000)
  assert.equal(view.results, null, 'examinations is still off')
})

test('the figures a parent sees are the ones the office computes', async () => {
  await claimLink(admin(), { parentId: ids.p1, studentId: ids.s1, relation: 'father' })
  await setModule('fees', true)
  const programId = (await academic.listStructure(admin())).programs[0]!.id
  await fees.createFeeItem(admin(), { programId, termId, label: 'Hostel', amount: '25000' })

  const view = await childOverview(parent(ids.p1), ids.s1)
  const office = await fees.studentLedger(admin(), ids.s1, termId)
  assert.equal(view.fees!.outstandingPaise, office.outstandingPaise)
  assert.equal(view.fees!.payablePaise, office.payablePaise)
})

test('the viewer scope is one child wide, not every child of that parent', async () => {
  await claimLink(admin(), { parentId: ids.p1, studentId: ids.s1, relation: 'father' })
  await claimLink(admin(), { parentId: ids.p1, studentId: ids.s2, relation: 'father' })
  await setModule('examinations', true)

  // Reading one child works; the module still refuses the other for that actor,
  // because the portal hands down exactly the student being read.
  const viewer = { ...parent(ids.p1), viewerOf: [ids.s1] }
  assert.ok(await transcript(viewer, ids.s1))
  await assert.rejects(() => transcript(viewer, ids.s2), (e: unknown) => (e as { status?: number }).status === 403)
})

test('a module refuses a parent who was handed no scope at all', async () => {
  await claimLink(admin(), { parentId: ids.p1, studentId: ids.s1, relation: 'father' })
  await setModule('examinations', true)
  await assert.rejects(
    () => transcript(parent(ids.p1), ids.s1),
    (e: unknown) => (e as { status?: number }).status === 403,
  )
})

test('an administrator may look at any child without a link', async () => {
  const view = await childOverview(admin(), ids.s2)
  assert.equal(view.studentId, ids.s2)
})

// --- tenancy ---------------------------------------------------------------

test('another institution sees no links, and RLS not the query says so', async () => {
  await claimLink(admin(), { parentId: ids.p1, studentId: ids.s1, relation: 'father' })
  const seen = await withTenant(other, (tx) => tx.select().from(links))
  assert.equal(seen.length, 0)
})

test('a parent of another institution cannot reach a child here', async () => {
  await claimLink(admin(), { parentId: ids.p1, studentId: ids.s1, relation: 'father' })
  await assert.rejects(
    () => childOverview(A({ id: ids.p1, role: 'parent', institutionId: other }), ids.s1),
    (e: unknown) => code(e) === 'not_your_child',
  )
})

test('a session with no tenant set reads nothing rather than erroring', async () => {
  await claimLink(admin(), { parentId: ids.p1, studentId: ids.s1, relation: 'father' })
  assert.equal((await db.select().from(links)).length, 0)
})
