import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import { chargeStayWithin } from '@campusos/module-fees/api'
import { routes as specs } from './routes'
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

// --- review NOTEs: vacate lock, each term at its own fee, zero-night stays ------

/** Hold a term's charge lock, as a term run does, with the run's charge in place. */
async function termRunHolding(c: Awaited<ReturnType<typeof campus>>, allocationId: string) {
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  let ready!: () => void
  const locked = new Promise<void>((r) => (ready = r))
  const run = withTenant(c.id, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'hostel.charge:' + c.termId}, 0))`)
    // What the run read before the student left: an open stay with no charge.
    await chargeStayWithin(tx, c.id, c.admin.id, {
      sourceModule: 'hostel', stayId: allocationId, studentId: c.s1, label: 'Hostel a-101',
      termFeePaise: 1_460_000, from: '2026-01-05', until: null,
    }, c.termId)
    ready()
    await gate
  })
  await locked
  return { run, open }
}

test('a vacate waits for a term run on the same term, then shrinks the run\'s charge', async () => {
  const c = await campus()
  const a = await allocate(c.warden, { roomId: c.roomA, studentId: c.s1, allocatedOn: '2026-01-05' })
  await setRoomFee(c.admin, { blockId: c.blockId, termFee: '14600', reason: 'fees for 2026' })
  const held = await termRunHolding(c, a.id)
  let done = false
  const v = vacate(c.warden, { allocationId: a.id, vacatedOn: '2026-02-04', reason: 'left the hostel' }).then((r) => ((done = true), r))
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(done, false, 'vacate must wait for the term lock')
  held.open()
  await held.run
  await v
  const rows = await live(c.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.amount, 300_000)
})

test('vacating prices each earlier term at its own fee, even after the fee was cleared', async () => {
  const c = await campus()
  await withTenant(c.id, (tx) =>
    tx.execute(sql`insert into academic_terms (institution_id, code, name, starts_on, ends_on)
                   values (${c.id}, 'T0', 'Sem 0', '2025-07-01', '2025-12-31')`),
  )
  await setRoomFee(c.admin, { blockId: c.blockId, termFee: '14600', reason: 'fees for 2026' })
  const a = await allocate(c.warden, { roomId: c.roomA, studentId: c.s1, allocatedOn: '2025-07-01' })
  await chargeTerm(c.admin, { termId: c.termId })
  assert.equal((await live(c.id)).length, 2)
  // The price doubles, then is cleared; the stay ends in the second term.
  await setRoomFee(c.admin, { blockId: c.blockId, termFee: '29200', reason: 'doubled for 2027' })
  await setRoomFee(c.admin, { blockId: c.blockId, termFee: '', reason: 'cleared for review' })
  await vacate(c.warden, { allocationId: a.id, vacatedOn: '2026-02-04', reason: 'left the hostel' })
  const rows = await live(c.id)
  assert.deepEqual(rows.map((r) => r.amount).sort((x, y) => x - y), [300_000, 1_460_000])
})

test('a stay that ended the day it began is not reported as already charged', async () => {
  const c = await campus()
  await setRoomFee(c.admin, { blockId: c.blockId, termFee: '14600', reason: 'fees for 2026' })
  const a = await allocate(c.warden, { roomId: c.roomA, studentId: c.s1, allocatedOn: '2026-03-01' })
  await vacate(c.warden, { allocationId: a.id, vacatedOn: '2026-03-01', reason: 'left the hostel' })
  assert.equal((await live(c.id)).length, 0)
  const r = await chargeTerm(c.admin, { termId: c.termId })
  assert.equal(r.charged, 0)
  assert.equal(r.alreadyCharged, 0)
})

// --- review round 2: HIGH 5 (notice), 6 (clear a fee from a form), 8 (zone) -------

test('the departure notice does not send the office to a waiver Fees cannot grant (review HIGH 5)', async () => {
  const c = await campus()
  await setRoomFee(c.admin, { blockId: c.blockId, termFee: '14600', reason: 'fees for 2026' })
  const a = await allocate(c.warden, { roomId: c.roomA, studentId: c.s1, allocatedOn: '2026-01-05' })
  await withTenant(c.id, (tx) => tx.execute(sql`update fee_student_charges set invoiced_at = now() where source_module = 'hostel'`))
  const out = await vacate(c.warden, { allocationId: a.id, vacatedOn: '2026-02-04', reason: 'left the hostel' })
  assert.deepEqual(out.invoiced, ['T1'])
  assert.doesNotMatch(out.notice, /waiver/i)
  assert.match(out.notice, /T1/)
})

test('a fee left blank on the form clears the price, as the form adapter sends it (review HIGH 6)', async () => {
  const c = await campus()
  await setRoomFee(c.admin, { blockId: c.blockId, termFee: '14600', reason: 'fees for 2026' })
  // The web form drops blank fields: no termFee key at all.
  const spec = specs.find((s) => s.path === '/rooms/fee')!
  const req = new Request('http://college.test/api/v1/modules/hostel/rooms/fee', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blockId: c.blockId, reason: 'cleared for review' }),
  })
  await spec.handler(c.admin, req)
  const fees = (await withTenant(c.id, (tx) => tx.execute(sql`select term_fee_paise from hostel_rooms`))).rows as { term_fee_paise: number | null }[]
  assert.deepEqual(fees.map((x) => x.term_fee_paise), [null, null])
})

test('a blank allocation or vacate date is the institution\'s day, not the server\'s UTC day (review HIGH 8)', async () => {
  const c = await campus()
  // A zone whose date differs from UTC's right now: one of UTC+14 and UTC-11 always does.
  const dayIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
  const utc = dayIn('UTC')
  const zone = dayIn('Pacific/Kiritimati') !== utc ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago'
  assert.notEqual(dayIn(zone), utc)
  await withTenant(c.id, (tx) => tx.execute(sql`insert into finance_settings (institution_id, time_zone) values (${c.id}, ${zone})`))
  const a = await allocate(c.warden, { roomId: c.roomA, studentId: c.s1 })
  assert.equal(a.allocatedOn, dayIn(zone))
  const v = await vacate(c.warden, { allocationId: a.id, reason: 'left the hostel' })
  assert.equal(v.vacatedOn, dayIn(zone))
})
