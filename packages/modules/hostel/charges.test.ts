import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import { addRooms, allocate, chargeTerm, createBlock, setRoomFee, vacate, type Actor } from './api'

/**
 * Hostel beds charged through the student's fee account (ACC-28): per term,
 * prorated from the day of allocation, re-raised for the nights used when a
 * student leaves before the term is invoiced, and priced by the office.
 */

let n = 0
const SLUG = 'hostel-charges-'

async function enable(id: string, ...modules: string[]) {
  for (const moduleId of modules) {
    await authDb
      .insert(institutionModules)
      .values({ institutionId: id, moduleId, enabled: true })
      .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled: true } })
  }
}

async function campus(fees = true) {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Hostel Fees College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `warden@${tag}.test`, institutionId: id, role: 'hostel_staff', name: 'Warden' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'One' },
      { email: `s2@${tag}.test`, institutionId: id, role: 'student', name: 'Two' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const warden: Actor = { id: people[1]!.id, email: `warden@${tag}.test`, role: 'hostel_staff', institutionId: id }
  if (fees) await enable(id, 'finance', 'fees')
  // 146 days, 5 January to 30 May inclusive.
  const [term] = (
    await withTenant(id, (tx) =>
      tx.execute(sql`insert into academic_terms (institution_id, code, name, starts_on, ends_on)
                     values (${id}, 'T1', 'Sem 1', '2026-01-05', '2026-05-30') returning id`),
    )
  ).rows as { id: string }[]
  const block = await createBlock(warden, { code: 'a', name: 'A Block' })
  const rooms = await addRooms(warden, { blockId: block.id, numbers: ['101', '102'], floor: 1, capacity: 2 })
  return { id, admin, warden, s1: people[2]!.id, s2: people[3]!.id, termId: term!.id, blockId: block.id, roomA: rooms[0]!.id }
}

const charges = async (id: string) =>
  (
    await withTenant(id, (tx) =>
      tx.execute(sql`select amount_paise::int as amount, label, cancelled_at, source_id from fee_student_charges
                      where source_module = 'hostel' order by created_at`),
    )
  ).rows as { amount: number; label: string; cancelled_at: string | null; source_id: string }[]

const live = async (id: string) => (await charges(id)).filter((c) => !c.cancelled_at)
const code = (e: unknown) => (e as { code?: string }).code
const status = (e: unknown) => (e as { status?: number }).status

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('a fee is set per bed by an administrator, not the warden', async () => {
  const c = await campus()
  await assert.rejects(setRoomFee(c.warden, { blockId: c.blockId, termFee: '14,600', reason: 'fees for 2026' }), (e) => status(e) === 403)
  const r = await setRoomFee(c.admin, { blockId: c.blockId, termFee: '14,600', reason: 'fees for 2026' })
  assert.equal(r.rooms, 2)
  const fees = (await withTenant(c.id, (tx) => tx.execute(sql`select term_fee_paise::int as f from hostel_rooms`))).rows as { f: number }[]
  assert.deepEqual(fees.map((x) => x.f), [1_460_000, 1_460_000])
  const trail = (await withTenant(c.id, (tx) => tx.execute(sql`select action, reason from audit_log where action = 'hostel.room_fee_set'`))).rows
  assert.equal(trail.length, 1)
})

test('allocating mid-term charges the rest of the term', async () => {
  const c = await campus()
  await setRoomFee(c.admin, { blockId: c.blockId, termFee: '14600', reason: 'fees for 2026' })
  await allocate(c.warden, { roomId: c.roomA, studentId: c.s1, allocatedOn: '2026-03-01' })
  const rows = await live(c.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.amount, 910_000)
  assert.equal(rows[0]!.label, 'Hostel a-101, T1 (91 of 146 days)')
})

test('vacating before invoicing charges only the nights used', async () => {
  const c = await campus()
  await setRoomFee(c.admin, { blockId: c.blockId, termFee: '14600', reason: 'fees for 2026' })
  const a = await allocate(c.warden, { roomId: c.roomA, studentId: c.s1, allocatedOn: '2026-01-05' })
  const out = await vacate(c.warden, { allocationId: a.id, vacatedOn: '2026-02-04', reason: 'left the hostel' })
  assert.equal(out.invoiced.length, 0)
  const rows = await live(c.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.amount, 300_000)
  assert.equal((await charges(c.id)).filter((x) => x.cancelled_at).length, 1)
})

test('a term run charges every resident once, and only an administrator runs it', async () => {
  const c = await campus()
  // Residents from before any fee was set: nothing was charged on allocation.
  await allocate(c.warden, { roomId: c.roomA, studentId: c.s1, allocatedOn: '2025-12-01' })
  await allocate(c.warden, { roomId: c.roomA, studentId: c.s2, allocatedOn: '2025-12-01' })
  assert.equal((await live(c.id)).length, 0)
  await setRoomFee(c.admin, { blockId: c.blockId, termFee: '14600', reason: 'fees for 2026' })
  await assert.rejects(chargeTerm(c.warden, { termId: c.termId }), (e) => status(e) === 403)
  const r = await chargeTerm(c.admin, { termId: c.termId })
  assert.equal(r.charged, 2)
  assert.equal(r.amountPaise, 2_920_000)
  const again = await chargeTerm(c.admin, { termId: c.termId })
  assert.equal(again.charged, 0)
  assert.equal(again.alreadyCharged, 2)
  assert.equal((await live(c.id)).length, 2)
})

test('without fees nothing is charged, and the term run says why', async () => {
  const c = await campus(false)
  await setRoomFee(c.admin, { blockId: c.blockId, termFee: '14600', reason: 'fees for 2026' })
  await allocate(c.warden, { roomId: c.roomA, studentId: c.s1, allocatedOn: '2026-03-01' })
  assert.equal((await charges(c.id)).length, 0)
  await assert.rejects(chargeTerm(c.admin, { termId: c.termId }), (e) => code(e) === 'fees_not_enabled')
})
