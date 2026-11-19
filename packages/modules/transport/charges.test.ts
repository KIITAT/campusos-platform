import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import { addRoute, addStop, addVehicle, assign, chargeTerm, release, setRouteFee, type Actor } from './api'

/**
 * Bus seats charged through the student's fee account (ACC-28): per term,
 * prorated from the day of assignment, re-raised for the days used when the
 * seat is released before the term is invoiced, and priced by the office.
 */

let n = 0
const SLUG = 'transport-charges-'

async function campus(fees = true) {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Bus College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'One' },
    ])
    .returning({ id: users.id })
  const admin = { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id } as Actor
  const clerk = { id: people[1]!.id, email: `clerk@${tag}.test`, role: 'accounts_staff', institutionId: id } as Actor
  if (fees) {
    for (const moduleId of ['finance', 'fees']) {
      await authDb
        .insert(institutionModules)
        .values({ institutionId: id, moduleId, enabled: true })
        .onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled: true } })
    }
  }
  // 100 days: from ten days ago to 89 days on, in India; today is day 11.
  const [term] = (
    await withTenant(id, (tx) =>
      tx.execute(sql`insert into academic_terms (institution_id, code, name, starts_on, ends_on)
                     select ${id}, 'T1', 'Sem 1', d - 10, d + 89 from (select (now() at time zone 'Asia/Kolkata')::date as d) x
                     returning id`),
    )
  ).rows as { id: string }[]
  const vehicle = await addVehicle(admin, { registration: 'OD02AB1234', capacity: 40 })
  const route = await addRoute(admin, { name: 'Patia loop', vehicleId: vehicle.id })
  const stop = await addStop(admin, { routeId: route.id, name: 'KIIT Square', position: 1 })
  return { id, admin, clerk, studentId: people[2]!.id, termId: term!.id, routeId: route.id, stopId: stop.id }
}

const charges = async (id: string) =>
  (
    await withTenant(id, (tx) =>
      tx.execute(sql`select amount_paise::int as amount, label, cancelled_at from fee_student_charges
                      where source_module = 'transport' order by created_at`),
    )
  ).rows as { amount: number; label: string; cancelled_at: string | null }[]
const live = async (id: string) => (await charges(id)).filter((c) => !c.cancelled_at)
const code = (e: unknown) => (e as { code?: string }).code

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('a route fee is set by an administrator, with a reason', async () => {
  const c = await campus()
  await assert.rejects(setRouteFee(c.clerk, { routeId: c.routeId, termFee: '10000', reason: 'bus fees for 2026' }), (e) => code(e) === 'forbidden')
  const r = await setRouteFee(c.admin, { routeId: c.routeId, termFee: '10,000', reason: 'bus fees for 2026' })
  assert.equal(r.termFeePaise, 1_000_000)
})

test('assigning a seat charges the rest of the term, and releasing it the same day leaves nothing', async () => {
  const c = await campus()
  await setRouteFee(c.admin, { routeId: c.routeId, termFee: '10000', reason: 'bus fees for 2026' })
  const a = await assign(c.admin, { routeId: c.routeId, stopId: c.stopId, studentId: c.studentId })
  const rows = await live(c.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.amount, 900_000)
  assert.equal(rows[0]!.label, 'Transport Patia loop, T1 (90 of 100 days)')
  await release(c.admin, { assignmentId: a.id, reason: 'moved closer to campus' })
  assert.equal((await live(c.id)).length, 0)
  assert.equal((await charges(c.id)).length, 1)
})

test('a term run charges every rider once', async () => {
  const c = await campus()
  await assign(c.admin, { routeId: c.routeId, stopId: c.stopId, studentId: c.studentId })
  assert.equal((await live(c.id)).length, 0, 'no fee yet, no charge')
  await setRouteFee(c.admin, { routeId: c.routeId, termFee: '10000', reason: 'bus fees for 2026' })
  const r = await chargeTerm(c.admin, { termId: c.termId })
  assert.equal(r.charged, 1)
  assert.equal((await chargeTerm(c.admin, { termId: c.termId })).alreadyCharged, 1)
  assert.equal((await live(c.id)).length, 1)
})

test('without fees nothing is charged, and the term run says why', async () => {
  const c = await campus(false)
  await setRouteFee(c.admin, { routeId: c.routeId, termFee: '10000', reason: 'bus fees for 2026' })
  await assign(c.admin, { routeId: c.routeId, stopId: c.stopId, studentId: c.studentId })
  assert.equal((await charges(c.id)).length, 0)
  await assert.rejects(chargeTerm(c.admin, { termId: c.termId }), (e) => code(e) === 'fees_not_enabled')
})
