import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, sql } from 'drizzle-orm'
import { authDb, institutionModules, institutions, recordGuardianConsent, users, withTenant } from '@campusos/db'
import { enterSession, exitSession, type Actor as LibActor } from '@campusos/module-library/api'
import { notificationOptOuts, notifications } from '@campusos/module-notices/schema'
import {
  HostelError, addRooms, addScope, allocate, createBlock, curfewSweep, grantLeave, listCases, resolveCase, studentPresence,
  type Actor,
} from './api'
import {
  allocations, blocks, checkIns, curfewCases, eventCursors, lateStayWindows, latePasses, leaves, policy,
  presenceLog, rooms, visitors, wardenScopes,
} from './schema'

const SLUG = 'hcurfew-test'
let inst: string
const ids = { adm: '', lib: '', w1: '', w2: '', chief: '', s1: '', s2: '', s3: '', par: '' }
let blockA = ''
let blockW = ''
let roomA = ''
let roomW = ''

const A = (id: string, role: Actor['role']): Actor => ({ id, email: `${id}@hcurfew.test`, role, institutionId: inst })
const admin = () => A(ids.adm, 'institution_admin')
const warden = () => A(ids.w1, 'hostel_staff')
const student = (id: string) => A(id, 'student')
const librarian = (): LibActor => ({ id: ids.lib, email: 'lib@hcurfew.test', role: 'library_staff', institutionId: inst })
const code = (e: unknown) => (e as HostelError).code
const isZod = (e: unknown) => e instanceof Error && e.name === 'ZodError'

// India time. Night 2026-11-26 runs from 12:00 on the 26th to 12:00 on the 27th.
const at = (hhmm: string, day = '26') => new Date(`2026-11-${day}T${hhmm}:00+05:30`)
const sweep = (now: Date) => withTenant(inst, (tx) => curfewSweep(tx, inst, now))
const NIGHT = '2026-11-26'

const consent = (studentId: string, decision: 'given' | 'withdrawn' = 'given') =>
  withTenant(inst, (tx) =>
    recordGuardianConsent(tx, {
      institutionId: inst, studentId, purpose: 'hostel_presence', decision, basis: 'office_record',
      guardianId: null, recordedBy: ids.adm, note: 'office record for tests',
    }),
  )

const enable = (moduleId: string) =>
  authDb
    .insert(institutionModules)
    .values({ institutionId: inst, moduleId, enabled: true })
    .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled: true } })

const notes = (userId: string, title?: string) =>
  withTenant(inst, async (tx) => {
    const rows = await tx.select().from(notifications).where(eq(notifications.userId, userId))
    return title ? rows.filter((r) => r.title === title) : rows
  })
const cases = () => withTenant(inst, (tx) => tx.select().from(curfewCases).orderBy(curfewCases.openedAt))
const caseOf = async (studentId: string) => (await cases()).find((c) => c.studentId === studentId)!

const checkIn = (studentId: string, onNight: string, recordedAt: Date, blockId = blockA) =>
  withTenant(inst, (tx) =>
    tx.insert(checkIns).values({ institutionId: inst, blockId, studentId, onNight, status: 'present', method: 'manual', recordedAt, recordedBy: ids.w1 }),
  )

const pass = (studentId: string, untilAt: Date, status = 'approved') =>
  withTenant(inst, (tx) =>
    tx.insert(latePasses).values({ institutionId: inst, studentId, night: NIGHT, untilAt, reason: 'practical examination', status }),
  )

const window = (untilTime: string) =>
  withTenant(inst, (tx) =>
    tx.insert(lateStayWindows).values({ institutionId: inst, fromOn: NIGHT, toOn: NIGHT, untilTime, reason: 'exam week extension' }),
  )

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([{ slug: SLUG, name: 'Curfew College', allowedEmailDomains: ['hcurfew.test'] }])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@hcurfew.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'lib@hcurfew.test', institutionId: inst, role: 'library_staff', name: 'Lib' },
      { email: 'w1@hcurfew.test', institutionId: inst, role: 'hostel_staff', name: 'Floor Warden' },
      { email: 'w2@hcurfew.test', institutionId: inst, role: 'hostel_staff', name: 'Block Warden' },
      { email: 'chief@hcurfew.test', institutionId: inst, role: 'hostel_staff', name: 'Chief Warden' },
      { email: 's1@hcurfew.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@hcurfew.test', institutionId: inst, role: 'student', name: 'Two Student' },
      { email: 's3@hcurfew.test', institutionId: inst, role: 'student', name: 'Three Student' },
      { email: 'par@hcurfew.test', institutionId: inst, role: 'parent', name: 'Parent' },
    ])
    .returning({ id: users.id })
  ;[ids.adm, ids.lib, ids.w1, ids.w2, ids.chief, ids.s1, ids.s2, ids.s3, ids.par] = people.map((p) => p.id) as [string, string, string, string, string, string, string, string, string]
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(notifications)
    await tx.delete(notificationOptOuts)
    await tx.execute(sql`delete from library_events`)
    await tx.execute(sql`delete from library_sessions`)
    for (const t of [presenceLog, curfewCases, latePasses, lateStayWindows, wardenScopes, policy, eventCursors, checkIns, leaves, visitors, allocations, rooms, blocks]) {
      await tx.delete(t)
    }
  })
  await authDb.execute(sql`delete from parent_links where institution_id = ${inst}`)
  await enable('hostel')
  await enable('library')
  for (const s of [ids.s1, ids.s2, ids.s3]) await consent(s, 'withdrawn')
  blockA = (await createBlock(warden(), { code: 'a', name: 'A Block', kind: 'mens' })).id
  blockW = (await createBlock(warden(), { code: 'w', name: 'W Block', kind: 'womens' })).id
  roomA = (await addRooms(warden(), { blockId: blockA, numbers: ['101'], floor: 2, capacity: 4 }))[0]!.id
  roomW = (await addRooms(warden(), { blockId: blockW, numbers: ['201'], floor: 1, capacity: 4 }))[0]!.id
  await allocate(warden(), { roomId: roomA, studentId: ids.s1, allocatedOn: '2026-11-01' })
  await allocate(warden(), { roomId: roomA, studentId: ids.s2, allocatedOn: '2026-11-01' })
  await addScope(admin(), { userId: ids.w1, level: 'floor', blockId: blockA, floor: 2 })
  await addScope(admin(), { userId: ids.w2, level: 'block', blockId: blockA })
  await addScope(admin(), { userId: ids.chief, level: 'chief' })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

const linkParent = () =>
  authDb.execute(sql`insert into parent_links (institution_id, parent_id, student_id, relation, verified_at) values (${inst}, ${ids.par}, ${ids.s1}, 'mother', now())`)

test('no case before curfew + 10; the case opens at curfew + 10 with one nudge', async () => {
  assert.equal((await sweep(at('21:39'))).opened, 0)
  const r = await sweep(at('21:40'))
  assert.equal(r.opened, 2)
  const n = await notes(ids.s1)
  assert.equal(n.length, 1)
  assert.equal(n[0]!.title, 'Hostel check-in')
  assert.equal(n[0]!.body, 'You have not checked in at a yet. Check in now, or tell your warden where you are.')
  assert.equal(n[0]!.moduleId, 'hostel_safety')
  assert.equal((await sweep(at('21:41'))).opened, 0)
  assert.equal((await notes(ids.s1)).length, 1)
})

test('a resident with a check-in, on approved leave, or with a pass until 23:00 is not a case', async () => {
  await checkIn(ids.s1, NIGHT, at('20:00'))
  await grantLeave(warden(), { studentId: ids.s2, fromOn: NIGHT, toOn: '2026-11-27', reason: 'home visit for a wedding' })
  assert.equal((await sweep(at('21:45'))).opened, 0)

  await withTenant(inst, (tx) => tx.delete(checkIns))
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(leaves)
  })
  await pass(ids.s1, at('23:00'))
  await pass(ids.s2, at('23:00'))
  assert.equal((await sweep(at('21:45'))).opened, 0)
})

test('open library session: no case; a library exit 10 minutes ago: no case; 25 minutes ago: a case (consent given)', async () => {
  await consent(ids.s1)
  await consent(ids.s2)
  await enterSession(librarian(), { studentId: ids.s1 }, at('20:00'))
  await enterSession(librarian(), { studentId: ids.s2 }, at('20:00'))
  assert.equal((await sweep(at('21:40'))).opened, 0)
  await exitSession(librarian(), { studentId: ids.s1 }, at('21:30'))
  await exitSession(librarian(), { studentId: ids.s2 }, at('21:15'))
  const r = await sweep(at('21:40'))
  assert.equal(r.opened, 1)
  assert.equal((await cases())[0]!.studentId, ids.s2)
})

test('without consent the library session does not stop the case', async () => {
  await enterSession(librarian(), { studentId: ids.s1 }, at('20:00'))
  assert.equal((await sweep(at('21:40'))).opened, 2)
})

test('ladder timing: floor warden at +30, guardians at +60, the student is not re-notified', async () => {
  await consent(ids.s1)
  await linkParent()
  await sweep(at('21:40'))
  assert.equal((await sweep(at('21:59'))).warded, 0)
  assert.equal((await sweep(at('22:00'))).warded, 2)
  const w = await notes(ids.w1, 'Resident not checked in')
  assert.equal(w.length, 2)
  assert.ok(w.some((n) => n.body === 'One Student (a-101) has not checked in, 30 minutes after curfew.'))
  assert.equal((await notes(ids.w2, 'Resident not checked in')).length, 0, 'a block-only warden is not on the floor step')
  assert.equal((await notes(ids.par)).length, 0)

  const g = await sweep(at('22:30'))
  assert.equal(g.guardians, 2)
  const p = await notes(ids.par)
  assert.equal(p.length, 1)
  assert.equal(p[0]!.title, 'Hostel check-in missing')
  assert.equal(p[0]!.body, 'One Student has not checked in at the hostel as of 22:30. Please contact them or the hostel office.')
  assert.equal((await notes(ids.s1)).length, 1, 'the student heard once, at the nudge')
  // With consent, block and chief wardens get the ordinary warden text.
  assert.ok((await notes(ids.chief, 'Resident not checked in')).length >= 1)
  assert.ok((await notes(ids.w2, 'Resident not checked in')).length >= 1)
  const c = await caseOf(ids.s1)
  assert.ok(c.nudgeAt && c.wardenAt && c.guardianAt)
})

test("a women's block reaches the warden step at +15", async () => {
  await allocate(warden(), { roomId: roomW, studentId: ids.s3, allocatedOn: '2026-11-01' })
  await sweep(at('21:44'))
  assert.equal((await sweep(at('21:44'))).warded, 0)
  // Opened at 21:44 (curfew + 14 is not due for the women's step yet: it runs at curfew + 15 = 21:45).
  const r = await sweep(at('21:45'))
  assert.equal(r.warded, 1)
  const hits = await notes(ids.w1, 'Resident not checked in')
  assert.equal(hits.length, 1)
  assert.ok(hits[0]!.body.startsWith('Three Student (w-201)'))
})

test('no consent: at +60 the block and chief wardens get the call text and the guardian gets nothing', async () => {
  await linkParent()
  await sweep(at('21:40'))
  await sweep(at('22:00'))
  await sweep(at('22:30'))
  assert.equal((await notes(ids.par)).length, 0)
  for (const who of [ids.w2, ids.chief]) {
    const n = await notes(who, "Call a resident's guardian")
    assert.equal(n.length, 2, 'one for each unaccounted resident')
    assert.ok(n.some((x) => x.body === 'One Student (a-101) is still not checked in. Guardian alerts are off for this student. Open the case for the emergency contact.'))
  }
  const log = await withTenant(inst, (tx) => tx.select().from(presenceLog).where(and(eq(presenceLog.kind, 'guardian_alerted'), eq(presenceLog.studentId, ids.s1))))
  assert.deepEqual(log[0]!.detail, { caseId: (await caseOf(ids.s1)).id, sent: false, reason: 'no_consent' })
})

test('a late-stay window until 23:30 moves the first nudge to 23:40', async () => {
  await window('23:30')
  assert.equal((await sweep(at('21:45'))).opened, 0)
  assert.equal((await sweep(at('23:39'))).opened, 0)
  assert.equal((await sweep(at('23:40'))).opened, 2)
  assert.equal((await caseOf(ids.s1)).curfewAt.getTime(), at('23:30').getTime())
})

test('a later check-in resolves the case; a warden resolves by hand; closing twice is 409; closing without a note is 400', async () => {
  await sweep(at('21:40'))
  await checkIn(ids.s1, NIGHT, at('21:50'))
  const r = await sweep(at('21:51'))
  assert.equal(r.resolved, 1)
  const c1 = await caseOf(ids.s1)
  assert.equal(c1.resolution, 'checked_in')
  assert.ok(c1.resolvedAt)

  const c2 = await caseOf(ids.s2)
  await assert.rejects(() => resolveCase(warden(), { caseId: c2.id, resolution: 'warden_closed' }), isZod)
  await resolveCase(warden(), { caseId: c2.id, resolution: 'warden_closed', note: 'found him at the gate' })
  assert.equal((await caseOf(ids.s2)).resolution, 'warden_closed')
  await assert.rejects(
    () => resolveCase(warden(), { caseId: c2.id, resolution: 'warden_verified' }),
    (e: unknown) => code(e) === 'case_closed' && (e as HostelError).status === 409,
  )
  assert.equal((await listCases(warden(), { resolved: true })).rows.length, 2)
  assert.equal((await listCases(warden(), {})).rows.length, 0)
})

test('two sweeps at the same instant make one case and one nudge', async () => {
  await Promise.all([sweep(at('21:40')), sweep(at('21:40'))])
  assert.equal((await cases()).length, 2)
  assert.equal((await notes(ids.s1)).length, 1)
  assert.equal((await withTenant(inst, (tx) => tx.select().from(presenceLog).where(eq(presenceLog.kind, 'case_opened')))).length, 2)
})

test('after case_window_hours no new case opens', async () => {
  assert.equal((await sweep(at('03:31', '27'))).opened, 0)
  assert.equal((await sweep(at('03:29', '27'))).opened, 2)
})

test('studentPresence writes a sensitive read of kind hostel.presence', async () => {
  const r = await studentPresence(warden(), ids.s1, at('21:00'))
  assert.equal(r.studentId, ids.s1)
  const rows = await withTenant(inst, async (tx) =>
    (await tx.execute(sql`select kind, purpose, reader_id from sensitive_reads where subject_id = ${ids.s1} and kind = 'hostel.presence'`)).rows as { kind: string; purpose: string; reader_id: string }[],
  )
  assert.ok(rows.length >= 1)
  assert.equal(rows[0]!.purpose, 'warden follow-up')
  assert.equal(rows[0]!.reader_id, ids.w1)
})

test('a student cannot call the case routes', async () => {
  await assert.rejects(() => listCases(student(ids.s1), {}), (e: unknown) => code(e) === 'forbidden')
  await assert.rejects(() => resolveCase(student(ids.s1), { caseId: ids.s1, resolution: 'warden_verified' }), (e: unknown) => code(e) === 'forbidden')
  await assert.rejects(() => studentPresence(student(ids.s1), ids.s1), (e: unknown) => code(e) === 'forbidden')
})

test('midnight crossing: the guardian step after midnight stamps the case of the night it belongs to', async () => {
  await window('23:30')
  await sweep(at('23:40'))
  await sweep(at('00:40', '27'))
  const all = await cases()
  assert.equal(all.length, 2, 'no case for the night that began at noon on the 27th')
  assert.ok(all.every((c) => c.night === NIGHT && c.guardianAt !== null))
})

test("a pass holder's ladder starts at the end of the pass", async () => {
  await pass(ids.s1, at('23:00'))
  await sweep(at('21:45'))
  assert.equal((await caseOf(ids.s2)).curfewAt.getTime(), at('21:30').getTime())
  assert.equal((await cases()).filter((c) => c.studentId === ids.s1).length, 0)
  assert.equal((await sweep(at('23:09'))).opened, 0)
  assert.equal((await sweep(at('23:10'))).opened, 1)
  const c = await caseOf(ids.s1)
  assert.equal(c.curfewAt.getTime(), at('23:00').getTime())
  assert.equal((await notes(ids.w1, 'Resident not checked in')).filter((n) => n.body.startsWith('One Student')).length, 0)
  assert.equal((await sweep(at('23:29'))).warded, 0)
  assert.ok((await sweep(at('23:30'))).warded >= 1)
  assert.ok((await notes(ids.w1, 'Resident not checked in')).some((n) => n.body === 'One Student (a-101) has not checked in, 30 minutes after curfew.'))
})

test('a check-in at 00:20 (stamped on the next night) resolves the case of the night before, and is no evidence for the next night', async () => {
  await sweep(at('21:40'))
  await checkIn(ids.s1, '2026-11-27', at('00:20', '27'))
  const r = await sweep(at('00:21', '27'))
  assert.equal(r.resolved, 1)
  assert.equal((await caseOf(ids.s1)).resolution, 'checked_in')
  // The next evening the same row does not account for the new night.
  const next = await sweep(at('21:40', '27'))
  assert.equal(next.opened, 2)
  assert.ok((await cases()).some((c) => c.studentId === ids.s1 && c.night === '2026-11-27'))
})

test('hostel_safety cannot be muted: a floor warden with an opt-out row still gets the alert', async () => {
  await withTenant(inst, (tx) => tx.insert(notificationOptOuts).values({ institutionId: inst, userId: ids.w1, moduleId: 'hostel_safety' }))
  await sweep(at('21:40'))
  await sweep(at('22:00'))
  assert.equal((await notes(ids.w1, 'Resident not checked in')).length, 2)
})
