import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { and, eq, gt, sql } from 'drizzle-orm'
import { authDb, withTenant } from './client'
import { auditLog } from './audit'
import { consentCurrent, recordConsent } from './dpdp'
import { institutions, users } from './schema'
import {
  ageStatus,
  consentGiven,
  currentConsent,
  GuardianConsentRequiredError,
  recordGuardianConsent,
} from './minors'

const SLUG = 'minors-test'
const OTHER = 'minors-test-other'
let inst: string
let other: string
let admin: string
let parent: string

before(async () => {
  const [i, o] = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Minors College', allowedEmailDomains: ['minors.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['minors-other.test'] },
    ])
    .returning({ id: institutions.id })
  inst = i!.id
  other = o!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@minors.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'parent@minors.test', institutionId: inst, role: 'parent', name: 'Parent' },
    ])
    .returning({ id: users.id })
  admin = people[0]!.id
  parent = people[1]!.id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

async function owner<T>(run: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
  await c.connect()
  try {
    return await run(c)
  } finally {
    await c.end()
  }
}

/** drizzle wraps a database error: the database's own message is its cause. */
const rejectsWith = (run: () => Promise<unknown>, pattern: RegExp) =>
  assert.rejects(run, (e: Error) => pattern.test(`${e.message} ${(e.cause as Error | undefined)?.message ?? ''}`))

/** A fresh student; `yearsOld` sets a date of birth that many years before today in India. */
async function student(yearsOld: number | null): Promise<string> {
  const [u] = await authDb
    .insert(users)
    .values({ email: `s-${randomUUID()}@minors.test`, institutionId: inst, role: 'student', name: 'Fresh' })
    .returning({ id: users.id })
  if (yearsOld !== null) await setDob(u!.id, `((now() at time zone 'Asia/Kolkata')::date - interval '${yearsOld} years')::date`)
  return u!.id
}

const setDob = (id: string, expr: string) =>
  owner((c) => c.query(`update users set date_of_birth = ${expr} where id = $1`, [id]))

const status = (id: string) => withTenant(inst, (tx) => ageStatus(tx, id))

test('a date of birth decides the age status', async () => {
  const young = await student(17)
  const grown = await student(18)
  const blank = await student(null)
  assert.equal(await status(young), 'minor')
  assert.equal(await status(grown), 'adult')
  assert.equal(await status(blank), 'unknown')
  assert.equal(await status(randomUUID()), 'unknown')
})

test('a date of birth in the future is refused', async () => {
  const s = await student(null)
  await rejectsWith(() => setDob(s, 'current_date + 1'), /users_date_of_birth_range|a date of birth is in the past/)
})

const record = (studentId: string, decision: 'given' | 'refused' | 'withdrawn') =>
  withTenant(inst, (tx) =>
    recordGuardianConsent(tx, {
      institutionId: inst, studentId, purpose: 'care_self_checks', decision,
      basis: 'guardian', guardianId: parent, recordedBy: admin, note: null,
    }),
  )

test('the latest consent decides', async () => {
  const s = await student(15)
  const given = () => withTenant(inst, (tx) => consentGiven(tx, s, 'care_self_checks'))
  assert.equal(await given(), false)
  await record(s, 'given')
  assert.equal(await given(), true)
  await record(s, 'withdrawn')
  assert.equal(await given(), false)
  assert.equal((await withTenant(inst, (tx) => currentConsent(tx, s, 'care_self_checks')))?.decision, 'withdrawn')
  await record(s, 'given')
  assert.equal(await given(), true)
})

test('a consent row cannot be changed or removed by the app role', async () => {
  const s = await student(15)
  await record(s, 'given')
  await rejectsWith(
    () => withTenant(inst, (tx) => tx.execute(sql`update guardian_consents set decision = 'refused' where student_id = ${s}`)),
    /permission denied/,
  )
  await rejectsWith(
    () => withTenant(inst, (tx) => tx.execute(sql`delete from guardian_consents where student_id = ${s}`)),
    /permission denied/,
  )
})

test('recording a consent writes one audit row', async () => {
  const s = await student(15)
  const mark = (await owner((c) => c.query(`select clock_timestamp() as mark`))).rows[0].mark as Date
  const { id } = await record(s, 'given')
  const rows = await withTenant(inst, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'dpdp.guardian_consent'), eq(auditLog.entityId, id), gt(auditLog.at, mark))),
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.actorId, admin)
  assert.deepEqual(rows[0]!.detail, { studentId: s, purpose: 'care_self_checks', decision: 'given', basis: 'guardian' })
})

test('a minor cannot consent to the notice themselves', async () => {
  const s = await student(15)
  await assert.rejects(() => recordConsent(inst, s), GuardianConsentRequiredError)
  assert.equal(await consentCurrent(inst, s), false)
  await withTenant(inst, (tx) =>
    recordGuardianConsent(tx, {
      institutionId: inst, studentId: s, purpose: 'privacy_notice', decision: 'given',
      basis: 'guardian', guardianId: parent, recordedBy: parent, note: null,
    }),
  )
  assert.equal(await consentCurrent(inst, s), true)
})

test('another institution sees none of these consents', async () => {
  const s = await student(15)
  await record(s, 'given')
  const seen = await withTenant(other, (tx) => tx.execute(sql`select 1 from guardian_consents where student_id = ${s}`))
  assert.equal(seen.rows.length, 0)
})
