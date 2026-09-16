import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { authDb, db, withTenant } from './client'
import {
  CONSENT_VERSION,
  consentCurrent,
  eraseSubject,
  exportSubject,
  recordConsent,
} from './dpdp'
import { auditLog } from './audit'
import { institutions, users } from './schema'

const SLUG = 'dpdp-test'
let inst: string
let subject: string
let admin: string

before(async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'DPDP College', allowedEmailDomains: ['dpdp.test'] })
    .returning({ id: institutions.id })
  inst = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'subject@dpdp.test', institutionId: inst, role: 'student', name: 'A Subject' },
      { email: 'adm@dpdp.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
    ])
    .returning({ id: users.id })
  subject = people[0]!.id
  admin = people[1]!.id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('consent records the version that was shown', async () => {
  assert.equal(await consentCurrent(inst, subject), false)
  await recordConsent(inst, subject)
  assert.equal(await consentCurrent(inst, subject), true)

  const [row] = await withTenant(inst, (tx) =>
    tx.select({ v: users.consentVersion }).from(users).where(eq(users.id, subject)),
  )
  assert.equal(row!.v, CONSENT_VERSION)
})

test('consent to an older notice does not count as consent to this one', async () => {
  await recordConsent(inst, subject, '2020-01-01')
  assert.equal(await consentCurrent(inst, subject), false)
  await recordConsent(inst, subject)
})

test('an export finds records by walking the foreign keys, not a hand-written list', async () => {
  // audit_log references users.id, so a row there must turn up without this
  // test -- or the export -- naming the table.
  await withTenant(inst, (tx) =>
    tx.insert(auditLog).values({
      institutionId: inst,
      actorId: subject,
      moduleId: 'core',
      action: 'test.event',
      entity: 'users',
      entityId: subject,
      reason: 'a record that names the subject',
    }),
  )

  const bundle = await exportSubject(inst, subject)
  assert.equal(bundle.subject.id, subject)
  assert.equal(bundle.subject.email, 'subject@dpdp.test')
  assert.ok(
    Object.keys(bundle.records).some((k) => k.startsWith('audit_log.')),
    `audit_log missing from ${Object.keys(bundle.records).join(', ')}`,
  )
})

test('an export refuses a subject from another institution', async () => {
  const [other] = await authDb
    .insert(institutions)
    .values({ slug: 'dpdp-other', name: 'Other', allowedEmailDomains: ['dpdpother.test'] })
    .returning({ id: institutions.id })
  try {
    await assert.rejects(() => exportSubject(other!.id, subject), /no such user/)
  } finally {
    await authDb.delete(institutions).where(eq(institutions.slug, 'dpdp-other'))
  }
})

test('erasure removes the person and keeps the institution’s records', async () => {
  const before = await exportSubject(inst, subject)
  const auditRows = Object.entries(before.records).find(([k]) => k.startsWith('audit_log.'))
  assert.ok(auditRows, 'precondition: the subject has records')

  const result = await eraseSubject(inst, subject, {
    actorId: admin,
    actorEmail: 'adm@dpdp.test',
    reason: 'erasure requested by the data principal',
  })

  const [row] = await withTenant(inst, (tx) =>
    tx.select().from(users).where(eq(users.id, subject)),
  )
  assert.equal(row!.name, null)
  assert.equal(row!.emailVerified, null)
  assert.match(row!.email!, /@invalid$/, 'the address is replaced, not nulled')
  assert.ok(row!.erasedAt, 'the erasure is dated')

  // The rows that referenced them are still there, now unattributable.
  assert.ok(Object.values(result.retained).some((n) => n > 0))
  const [kept] = await withTenant(inst, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.entityId, subject)).limit(1),
  )
  assert.ok(kept, 'the institution keeps its own record')
})

test('the erasure is itself on the audit trail, without re-storing the identity', async () => {
  const rows = await withTenant(inst, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, 'dpdp.erased')),
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.entityId, subject)
  assert.match(rows[0]!.reason!, /data principal/)
  assert.ok(
    !JSON.stringify(rows[0]!.detail).includes('subject@dpdp.test'),
    'the erased address must not survive in the audit detail',
  )
})

test('erasure without a reason is refused', async () => {
  await assert.rejects(
    () => eraseSubject(inst, admin, { actorId: admin, reason: 'x' }),
    /requires a reason/,
  )
})

test('erasing twice does not collide on the replacement address', async () => {
  const [second] = await authDb
    .insert(users)
    .values({ email: 'second@dpdp.test', institutionId: inst, role: 'student', name: 'Second' })
    .returning({ id: users.id })

  await eraseSubject(inst, second!.id, {
    actorId: admin,
    reason: 'a second erasure on the same day',
  })
  // Both replacements are derived from the id, so they differ by construction.
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.institutionId, inst))
  const erased = rows.filter((r) => r.email?.endsWith('@invalid'))
  assert.equal(new Set(erased.map((r) => r.email)).size, erased.length)
})
