import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import { notifications } from '@campusos/module-notices/schema'
import {
  HostelError, addRooms, addScope, allocate, cancelWindow, createBlock, createWindow, curfewSweep, decidePass,
  listPasses, listWindows, requestPass, type Actor,
} from './api'
import {
  allocations, blocks, checkIns, curfewCases, eventCursors, lateStayWindows, latePasses, leaves, policy,
  presenceLog, rooms, visitors, wardenScopes,
} from './schema'

const SLUG = 'hlate-test'
let inst: string
const ids = { adm: '', w1: '', w2: '', chief: '', s1: '', s2: '', s3: '' }
let blockA = ''
let roomA = ''

const A = (id: string, role: Actor['role']): Actor => ({ id, email: `${id}@hlate.test`, role, institutionId: inst })
const admin = () => A(ids.adm, 'institution_admin')
const warden = () => A(ids.w1, 'hostel_staff')
const student = (id: string) => A(id, 'student')
const code = (e: unknown) => (e as HostelError).code
const isZod = (e: unknown) => e instanceof Error && e.name === 'ZodError'

const at = (hhmm: string, day = '26') => new Date(`2026-11-${day}T${hhmm}:00+05:30`)
const NIGHT = '2026-11-26'
const sweep = (now: Date) => withTenant(inst, (tx) => curfewSweep(tx, inst, now))
const win = (over: Record<string, unknown> = {}) =>
  createWindow(admin(), { fromOn: NIGHT, toOn: NIGHT, untilTime: '23:30', reason: 'exam week extension', ...over })
const request = (who: string, over: Record<string, unknown> = {}, now = at('21:00')) =>
  requestPass(student(who), { untilTime: '23:30', nextDay: false, reason: 'practical examination', ...over }, now)
const notes = (userId: string) => withTenant(inst, (tx) => tx.select().from(notifications).where(eq(notifications.userId, userId)))

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([{ slug: SLUG, name: 'Late College', allowedEmailDomains: ['hlate.test'] }])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@hlate.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'w1@hlate.test', institutionId: inst, role: 'hostel_staff', name: 'Warden' },
      { email: 'w2@hlate.test', institutionId: inst, role: 'hostel_staff', name: 'Other Warden' },
      { email: 'chief@hlate.test', institutionId: inst, role: 'hostel_staff', name: 'Chief' },
      { email: 's1@hlate.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@hlate.test', institutionId: inst, role: 'student', name: 'Two Student' },
      { email: 's3@hlate.test', institutionId: inst, role: 'student', name: 'Not Housed' },
    ])
    .returning({ id: users.id })
  ;[ids.adm, ids.w1, ids.w2, ids.chief, ids.s1, ids.s2, ids.s3] = people.map((p) => p.id) as [string, string, string, string, string, string, string]
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(notifications)
    for (const t of [presenceLog, curfewCases, latePasses, lateStayWindows, wardenScopes, policy, eventCursors, checkIns, leaves, visitors, allocations, rooms, blocks]) {
      await tx.delete(t)
    }
  })
  await authDb
    .insert(institutionModules)
    .values({ institutionId: inst, moduleId: 'hostel', enabled: true })
    .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled: true } })
  blockA = (await createBlock(warden(), { code: 'a', name: 'A Block', kind: 'mens' })).id
  roomA = (await addRooms(warden(), { blockId: blockA, numbers: ['101'], floor: 2, capacity: 4 }))[0]!.id
  await allocate(warden(), { roomId: roomA, studentId: ids.s1, allocatedOn: '2026-11-01' })
  await allocate(warden(), { roomId: roomA, studentId: ids.s2, allocatedOn: '2026-11-01' })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('a window until 23:30 for all blocks moves the curfew', async () => {
  const w = await win()
  assert.ok(w.id)
  assert.equal((await sweep(at('21:45'))).opened, 0)
  assert.equal((await sweep(at('23:40'))).opened, 2)
  assert.equal((await listWindows(warden())).length, 1)
})

test('a window outside 21:00 to 23:59 is refused', async () => {
  await assert.rejects(() => win({ untilTime: '20:30' }), isZod)
  await assert.rejects(() => win({ untilTime: '24:00' }), isZod)
})

test('a window longer than 60 days is refused', async () => {
  await assert.rejects(() => win({ toOn: '2027-02-01' }), isZod)
  await assert.rejects(() => win({ fromOn: '2026-11-27', toOn: NIGHT }), isZod)
})

test('a hostel_staff user without chief scope cannot create a window (403); with chief scope they can', async () => {
  await assert.rejects(() => createWindow(warden(), { fromOn: NIGHT, toOn: NIGHT, untilTime: '23:30', reason: 'exam week extension' }), (e: unknown) => code(e) === 'forbidden')
  await addScope(admin(), { userId: ids.chief, level: 'chief' })
  const w = await createWindow(A(ids.chief, 'hostel_staff'), { fromOn: NIGHT, toOn: NIGHT, untilTime: '23:30', reason: 'exam week extension' })
  assert.ok(w.id)
})

test('a student requests a pass until 23:30; a second request is 409 late_pass_exists', async () => {
  const p = await request(ids.s1)
  assert.equal(p.status, 'requested')
  await assert.rejects(() => request(ids.s1), (e: unknown) => code(e) === 'late_pass_exists' && (e as HostelError).status === 409)
  assert.equal((await listPasses(student(ids.s1))).length, 1)
})

test('a time beyond next-day 01:00 is refused late_pass_too_late; a pass not after curfew is refused', async () => {
  await assert.rejects(() => request(ids.s1, { untilTime: '01:30', nextDay: true }), (e: unknown) => code(e) === 'late_pass_too_late')
  assert.equal((await request(ids.s1, { untilTime: '00:45', nextDay: true })).status, 'requested')
  await assert.rejects(() => request(ids.s2, { untilTime: '21:00' }), (e: unknown) => code(e) === 'pass_not_later')
})

test('a warden approves and the student is told; a second decision is refused', async () => {
  const p = await request(ids.s1)
  await decidePass(warden(), { passId: p.id, decision: 'approved' })
  const n = await notes(ids.s1)
  assert.equal(n.length, 1)
  assert.equal(n[0]!.title, 'Late-stay pass approved')
  assert.equal(n[0]!.body, 'Your pass for tonight until 23:30 was approved.')
  await assert.rejects(() => decidePass(warden(), { passId: p.id, decision: 'refused' }), (e: unknown) => code(e) === 'pass_decided')
  // The pass now holds the ladder back until it ends.
  assert.equal((await sweep(at('21:45'))).opened, 1)
  assert.equal((await sweep(at('23:40'))).opened, 1)
})

test('a warden scoped to another block cannot decide; the block warden and an administrator can', async () => {
  const other = (await createBlock(warden(), { code: 'b', name: 'B Block', kind: 'mens' })).id
  const p = await request(ids.s1)
  await addScope(admin(), { userId: ids.w1, level: 'block', blockId: blockA })
  await addScope(admin(), { userId: ids.w2, level: 'block', blockId: other })
  await assert.rejects(() => decidePass(A(ids.w2, 'hostel_staff'), { passId: p.id, decision: 'refused' }), (e: unknown) => code(e) === 'forbidden')
  assert.equal((await decidePass(warden(), { passId: p.id, decision: 'approved' })).status, 'approved')
  const q = await request(ids.s2)
  assert.equal((await decidePass(admin(), { passId: q.id, decision: 'refused' })).status, 'refused')
})

test('a refused pass does not extend the curfew', async () => {
  const p = await request(ids.s1)
  await decidePass(warden(), { passId: p.id, decision: 'refused' })
  assert.equal((await notes(ids.s1))[0]!.title, 'Late-stay pass refused')
  assert.equal((await sweep(at('21:45'))).opened, 2)
})

test('a pass for a student without a bed is 400 not_housed', async () => {
  await assert.rejects(() => request(ids.s3), (e: unknown) => code(e) === 'not_housed')
})

test('a cancelled window no longer extends', async () => {
  const w = await win()
  await cancelWindow(admin(), { windowId: w.id })
  assert.equal((await sweep(at('21:45'))).opened, 2)
  await assert.rejects(() => cancelWindow(admin(), { windowId: w.id }), (e: unknown) => code(e) === 'no_such_window')
})

test('a request before noon is for the coming night, and a pass that ends in the past is refused (P2-22a review HIGH 1)', async () => {
  const r = await request(ids.s1, { untilTime: '23:00' }, at('10:00', '27'))
  assert.equal(r.night, '2026-11-27')
  assert.equal(new Date(r.untilAt).getTime(), at('23:00', '27').getTime())
  assert.equal(r.status, 'requested')
  // At 00:30 the night that began yesterday is still running: its pass belongs to it, but not one already over.
  await assert.rejects(
    () => request(ids.s2, { untilTime: '00:10', nextDay: true }, at('00:30', '27')),
    (e: unknown) => code(e) === 'pass_not_later',
  )
  const late = await request(ids.s2, { untilTime: '00:50', nextDay: true }, at('00:30', '27'))
  assert.equal(late.night, '2026-11-26')
})
