import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { PluginError } from './plugin'
import { STUDENT_PURPOSES, assertCanAccessStudent, canAccessStudent, type StudentPurpose } from './access'
import type { Role } from './types'

/**
 * SEC-07: may this person see this student, for this purpose (decision 193)?
 * Self, a verified guardian for the guardian purposes, the administrators, the
 * accounts office for the fee ledger, or a relation some module declares in
 * the student_relations schema. Nobody else, and never a pending account.
 */

let inst: string
const ids = new Map<Role, string>()
const actor = (role: Role, over: Record<string, unknown> = {}) => ({ id: ids.get(role)!, role, institutionId: inst, ...over })
const can = (a: ReturnType<typeof actor>, student: string, purpose: StudentPurpose) =>
  withTenant(inst, (tx) => canAccessStudent(tx, a, student, purpose))

before(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, 'mf-access'))
  const [row] = await authDb.insert(institutions).values({ slug: 'mf-access', name: 'Access', allowedEmailDomains: [] }).returning()
  inst = row!.id
  const roles: Role[] = ['institution_admin', 'super_admin', 'accounts_staff', 'hod', 'faculty', 'library_staff', 'student', 'parent', 'pending']
  const people = await authDb.insert(users).values(roles.map((role) => ({ institutionId: inst, email: `${role}@mf-access.test`, role }))).returning()
  for (const p of people) ids.set(p.role, p.id)
})
after(async () => {
  if (inst) await authDb.delete(institutions).where(eq(institutions.id, inst))
})

test('a student sees their own record, for every purpose', async () => {
  const s = ids.get('student')!
  for (const p of STUDENT_PURPOSES) assert.equal(await can(actor('student'), s, p), true, p)
})

test('administrators see every student; the accounts office only the fee ledger', async () => {
  const s = ids.get('student')!
  for (const p of STUDENT_PURPOSES) {
    assert.equal(await can(actor('institution_admin'), s, p), true, p)
    assert.equal(await can(actor('super_admin'), s, p), true, p)
    assert.equal(await can(actor('accounts_staff'), s, p), p === 'fee_ledger', p)
  }
})

test('with no relation, faculty, a HoD and the library desk see nothing', async () => {
  const s = ids.get('student')!
  for (const role of ['faculty', 'hod', 'library_staff'] as Role[]) {
    for (const p of STUDENT_PURPOSES) assert.equal(await can(actor(role), s, p), false, `${role} ${p}`)
  }
})

test('a verified guardian sees the guardian purposes, not mentoring or skills', async () => {
  const s = ids.get('student')!
  const parent = actor('parent', { viewerOf: [s] })
  for (const p of STUDENT_PURPOSES) assert.equal(await can(parent, s, p), p !== 'mentoring' && p !== 'skills', p)
  assert.equal(await can(actor('parent'), s, 'profile'), false, 'an unverified parent sees nothing')
  assert.equal(await can(parent, ids.get('faculty')!, 'profile'), false, 'only the child vouched for')
})

test('a pending account, or one without an institution, sees nobody, not even itself', async () => {
  const s = ids.get('student')!
  assert.equal(await can(actor('pending'), s, 'profile'), false)
  assert.equal(await can(actor('pending'), ids.get('pending')!, 'profile'), false)
  assert.equal(await withTenant(inst, (tx) => canAccessStudent(tx, { ...actor('institution_admin'), institutionId: null }, s, 'profile')), false)
})

test('a relation view grants exactly its purposes; a malformed one refuses rather than allows', async () => {
  const s = ids.get('student')!
  const f = ids.get('faculty')!
  // In a transaction that is rolled back: the view never outlives the test.
  await assert.rejects(authDb.transaction(async (tx) => {
    await tx.execute(sql.raw(`create view student_relations.zz_test with (security_invoker = true) as
      select '${f}'::text as viewer_id, '${s}'::text as student_id, 'test'::text as relation, array['attendance']::text[] as purposes`))
    const rel = (purpose: string) => tx.execute(sql`select public.campusos_student_relation(${f}, ${s}, ${purpose}) as r`)
    assert.equal((await rel('attendance')).rows[0]!.r, 'test')
    assert.equal((await rel('profile')).rows[0]!.r, null)
    await tx.execute(sql.raw(`create view student_relations.zz_bad as select 1 as nothing`))
    await assert.rejects(rel('attendance'))
    throw new Error('rollback')
  }), /rollback|aborted/)
})

test('a refusal throws 403 not_your_student and logs it; report-only logs and allows', async () => {
  const s = ids.get('student')!
  const lines: string[] = []
  const original = console.error
  console.error = (line: string) => { lines.push(line) }
  try {
    await assert.rejects(
      withTenant(inst, (tx) => assertCanAccessStudent(tx, actor('faculty'), s, 'profile')),
      (e: unknown) => e instanceof PluginError && e.status === 403 && e.code === 'not_your_student',
    )
    await withTenant(inst, (tx) => assertCanAccessStudent(tx, actor('faculty', { authzReportOnly: true }), s, 'profile'))
    await assert.rejects(withTenant(inst, (tx) => assertCanAccessStudent(tx, actor('pending', { authzReportOnly: true }), s, 'profile')))
  } finally {
    console.error = original
  }
  assert.deepEqual(lines.map((l) => JSON.parse(l).event), ['authz.refused', 'authz.would_refuse', 'authz.refused'])
  assert.deepEqual(JSON.parse(lines[0]!), { event: 'authz.refused', layer: 'student', actor: ids.get('faculty'), role: 'faculty', student: s, purpose: 'profile' })
})
