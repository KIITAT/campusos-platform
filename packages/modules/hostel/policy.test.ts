import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import {
  HostelError,
  addRooms,
  addScope,
  allocate,
  createBlock,
  getPolicy,
  listScopes,
  recipientsFor,
  removeScope,
  setBlockCurfew,
  setPolicy,
  type Actor,
} from './api'
import {
  allocations, blocks, checkIns, curfewCases, eventCursors, lateStayWindows, latePasses, leaves,
  policy, presenceLog, rooms, visitors, wardenScopes,
} from './schema'

const SLUG = 'hpolicy-test'
const OTHER = 'hpolicy-other'
let inst: string
let other: string
const ids = { adm: '', w1: '', w2: '', w3: '', chief: '', fac: '', s1: '', s2: '' }
let blockId = ''
let roomId = ''
let since = new Date(0)

const A = (id: string, role: Actor['role']): Actor => ({ id, email: `${id}@hpolicy.test`, role, institutionId: inst })
const admin = () => A(ids.adm, 'institution_admin')
const warden = () => A(ids.w1, 'hostel_staff')
const code = (e: unknown) => (e as HostelError).code
const isZod = (e: unknown) => e instanceof Error && e.name === 'ZodError'
const reason = 'policy test change'

const policyInput = (over: Record<string, unknown> = {}) => ({
  curfewTime: '21:30', nudgeAfterMin: 10, wardenAfterMin: 30, womensWardenAfterMin: 15, guardianAfterMin: 60,
  walkBackMin: 20, caseWindowHours: 6, latePassLatestTime: '01:00', notifyWardenOnLibraryEntry: false,
  presenceRetentionDays: 90, reason, ...over,
})

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Policy College', allowedEmailDomains: ['hpolicy.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['hpolicyother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@hpolicy.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'w1@hpolicy.test', institutionId: inst, role: 'hostel_staff', name: 'Warden One' },
      { email: 'w2@hpolicy.test', institutionId: inst, role: 'hostel_staff', name: 'Warden Two' },
      { email: 'w3@hpolicy.test', institutionId: inst, role: 'hostel_staff', name: 'Warden Three' },
      { email: 'chief@hpolicy.test', institutionId: inst, role: 'hostel_staff', name: 'Chief' },
      { email: 'fac@hpolicy.test', institutionId: inst, role: 'faculty', name: 'Fac' },
      { email: 's1@hpolicy.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@hpolicy.test', institutionId: inst, role: 'student', name: 'Two Student' },
    ])
    .returning({ id: users.id })
  ids.adm = people[0]!.id
  ids.w1 = people[1]!.id
  ids.w2 = people[2]!.id
  ids.w3 = people[3]!.id
  ids.chief = people[4]!.id
  ids.fac = people[5]!.id
  ids.s1 = people[6]!.id
  ids.s2 = people[7]!.id
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    for (const t of [presenceLog, curfewCases, latePasses, lateStayWindows, wardenScopes, policy, eventCursors, checkIns, leaves, visitors, allocations, rooms, blocks]) {
      await tx.delete(t)
    }
    since = new Date(Math.floor(Number((await tx.execute<{ ms: string }>(sql`select extract(epoch from clock_timestamp()) * 1000 as ms`)).rows[0]!.ms)))
  })
  blockId = (await createBlock(warden(), { code: 'a', name: 'A Block', kind: 'mens' })).id
  roomId = (await addRooms(warden(), { blockId, numbers: ['101'], floor: 2, capacity: 2 }))[0]!.id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

test('policy defaults without a row', async () => {
  const p = await getPolicy(warden())
  assert.equal(p.curfewTime, '21:30:00')
  assert.equal(p.nudgeAfterMin, 10)
  assert.equal(p.wardenAfterMin, 30)
  assert.equal(p.womensWardenAfterMin, 15)
  assert.equal(p.guardianAfterMin, 60)
  assert.equal(p.notifyWardenOnLibraryEntry, false)
  assert.equal((await withTenant(inst, (tx) => tx.select().from(policy))).length, 0)
})

test('policy rejects warden_after_min not above nudge', async () => {
  await assert.rejects(() => setPolicy(admin(), policyInput({ wardenAfterMin: 10 })), isZod)
  await assert.rejects(() => setPolicy(admin(), policyInput({ guardianAfterMin: 15 })), isZod)
})

test('set policy by admin is audited; by a warden it is 403', async () => {
  const p = await setPolicy(admin(), policyInput({ curfewTime: '22:00', nudgeAfterMin: 5, notifyWardenOnLibraryEntry: 'true' }))
  assert.equal(p.curfewTime, '22:00:00')
  assert.equal(p.notifyWardenOnLibraryEntry, true)
  assert.equal((await getPolicy(warden())).nudgeAfterMin, 5)
  const trail = await withTenant(inst, (tx) => tx.select({ action: auditLog.action }).from(auditLog).where(gte(auditLog.at, since)))
  assert.ok(trail.some((t) => t.action === 'hostel.policy_set'))
  await assert.rejects(() => setPolicy(warden(), policyInput()), (e: unknown) => code(e) === 'forbidden')
})

test('block curfew override', async () => {
  const b = await setBlockCurfew(admin(), { blockId, curfewTime: '22:15' })
  assert.equal(b.curfewTime, '22:15:00')
  assert.equal((await setBlockCurfew(admin(), { blockId, curfewTime: null })).curfewTime, null)
  await assert.rejects(() => setBlockCurfew(admin(), { blockId, curfewTime: '10:00' }), isZod)
  await assert.rejects(() => setBlockCurfew(warden(), { blockId, curfewTime: '22:00' }), (e: unknown) => code(e) === 'forbidden')
})

test('scope shape: a floor scope needs a block and a floor (and the database says so)', async () => {
  await assert.rejects(() => addScope(admin(), { userId: ids.w1, level: 'floor', blockId }), isZod)
  await assert.rejects(() => addScope(admin(), { userId: ids.w1, level: 'chief', blockId }), isZod)
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.insert(wardenScopes).values({ institutionId: inst, userId: ids.w1, level: 'floor', blockId: null, floor: null }),
      ),
    (e: unknown) => /hostel_scopes_shape/.test(String((e as { cause?: Error }).cause?.message ?? e)),
  )
})

test('a scope for a user who is not hostel_staff is refused', async () => {
  await assert.rejects(() => addScope(admin(), { userId: ids.fac, level: 'chief' }), (e: unknown) => code(e) === 'not_hostel_staff')
})

test('a duplicate scope is refused by the unique index; removal is audited', async () => {
  const s = await addScope(admin(), { userId: ids.w1, level: 'floor', blockId, floor: 2 })
  await assert.rejects(() => addScope(admin(), { userId: ids.w1, level: 'floor', blockId, floor: 2 }))
  assert.equal((await listScopes(admin())).length, 1)
  await removeScope(admin(), { scopeId: s.id })
  assert.equal((await listScopes(admin())).length, 0)
  const trail = await withTenant(inst, (tx) => tx.select({ action: auditLog.action }).from(auditLog).where(gte(auditLog.at, since)))
  assert.ok(trail.some((t) => t.action === 'hostel.scope_added') && trail.some((t) => t.action === 'hostel.scope_removed'))
  await assert.rejects(() => listScopes(warden()), (e: unknown) => code(e) === 'forbidden')
})

test('recipientsFor falls back floor, block, blocks.warden_user_id, any hostel_staff, admin', async () => {
  await allocate(warden(), { roomId, studentId: ids.s1 })
  const who = (level: 'floor' | 'block' | 'chief') => withTenant(inst, async (tx) => (await recipientsFor(tx, inst, ids.s1, level)).userIds.sort())

  // 5. nobody scoped, no block warden, but hostel_staff exist: every hostel_staff user.
  const staff = [ids.w1, ids.w2, ids.w3, ids.chief].sort()
  // (4) is the case below; first the administrators, with hostel_staff out of the picture.
  await authDb.update(users).set({ role: 'faculty' }).where(and(eq(users.institutionId, inst), eq(users.role, 'hostel_staff')))
  assert.deepEqual(await who('floor'), [ids.adm])
  await authDb.update(users).set({ role: 'hostel_staff' }).where(inArray(users.id, [ids.w1, ids.w2, ids.w3, ids.chief]))
  assert.deepEqual(await who('floor'), staff)

  // blocks.warden_user_id
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test', true)`)
    await tx.update(blocks).set({ wardenUserId: ids.w3 }).where(eq(blocks.id, blockId))
  })
  assert.deepEqual(await who('floor'), [ids.w3])

  // block-level scope beats the block's warden
  await addScope(admin(), { userId: ids.w2, level: 'block', blockId })
  assert.deepEqual(await who('floor'), [ids.w2])
  assert.deepEqual(await who('block'), [ids.w2])

  // floor-level scope beats block-level; another floor does not match
  await addScope(admin(), { userId: ids.w1, level: 'floor', blockId, floor: 2 })
  assert.deepEqual(await who('floor'), [ids.w1])
  assert.deepEqual(await who('block'), [ids.w2])

  // chief: scope rows, else the administrators
  assert.deepEqual(await who('chief'), [ids.adm])
  await addScope(admin(), { userId: ids.chief, level: 'chief' })
  assert.deepEqual(await who('chief'), [ids.chief])
})

test('tenant isolation for each new hostel table', async () => {
  await addScope(admin(), { userId: ids.w1, level: 'chief' })
  await setPolicy(admin(), policyInput())
  const tables = [
    'hostel_policy', 'hostel_warden_scopes', 'hostel_late_stay_windows', 'hostel_late_passes',
    'hostel_curfew_cases', 'hostel_presence_log', 'hostel_event_cursors',
  ]
  for (const t of tables) {
    const seen = await withTenant(other, async (tx) => (await tx.execute(sql.raw(`select count(*)::int as n from ${t}`))).rows[0] as { n: number })
    assert.equal(seen.n, 0, t)
  }
})
