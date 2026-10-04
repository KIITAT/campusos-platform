import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { auditLog, authDb, users, withTenant } from '@campusos/db'
import { college } from './test-support.test'
import { cancelRegistration, createEvent, listProfiles, listRegistrations, register, saveProfile, setConsent, transitionEvent } from './api'
import { events, registrations } from './schema'

test('alumni RLS and tenant composites protect event references and audit reservations', async () => {
  const actors = await college()
  const other = await college()
  await saveProfile(actors.admin, { userId: actors.student.id, graduationYear: 2024, qualification: 'BSc' })
  const foreignProfile = await saveProfile(other.admin, { userId: other.student.id, graduationYear: 2024, qualification: 'BSc' })
  const event = await createEvent(actors.admin, { title: 'Private institution reunion', startsOn: '2099-12-31', registrationDeadline: '2099-12-30', capacity: 1, venue: 'Hall' })
  assert.deepEqual(await withTenant(other.id, transaction => transaction.select().from(events)), [])
  await assert.rejects(() => withTenant(other.id, transaction => transaction.insert(registrations).values({ institutionId: other.id, eventId: event.id, profileId: foreignProfile.id })))
  await assert.rejects(() => withTenant(other.id, transaction => transaction.insert(registrations).values({ institutionId: actors.id, eventId: event.id, profileId: foreignProfile.id })))
  await transitionEvent(actors.admin, { eventId: event.id, action: 'open' })
  const registration = await register(actors.student, { eventId: event.id })
  await cancelRegistration(actors.student, { registrationId: registration.id })
  const trail = await withTenant(actors.id, transaction => transaction.select().from(auditLog).where(eq(auditLog.moduleId, 'alumni')))
  assert.deepEqual(trail.map(row => row.action).sort(), ['profile.saved', 'event.created', 'event.open', 'event.registered', 'event.registration_cancelled'].sort())
})

test('registration deadlines are inclusive and expired drafts cannot open', async () => {
  const actors = await college()
  await saveProfile(actors.admin, { userId: actors.student.id, graduationYear: 2024, qualification: 'BSc' })
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const expired = await createEvent(actors.admin, { title: 'Expired reunion', startsOn: today, registrationDeadline: yesterday, capacity: 2, venue: 'Hall' })
  await assert.rejects(() => transitionEvent(actors.admin, { eventId: expired.id, action: 'open' }))
  const event = await createEvent(actors.admin, { title: 'Today reunion', startsOn: today, registrationDeadline: today, capacity: 2, venue: 'Hall' })
  await transitionEvent(actors.admin, { eventId: event.id, action: 'open' })
  assert.equal((await register(actors.student, { eventId: event.id })).status, 'active')
  await authDb.update(users).set({ erasedAt: new Date() }).where(eq(users.id, actors.other.id))
  await assert.rejects(() => saveProfile(actors.admin, { userId: actors.other.id, graduationYear: 2024, qualification: 'BSc' }))
})

test('alumni profile and contact publication require separate owner consent', async () => {
  const actors = await college()
  const profile = await saveProfile(actors.admin, { userId: actors.student.id, graduationYear: 2024, qualification: 'BSc', contactEmail: 'private@example.test' })
  assert.deepEqual(await listProfiles(actors.other), [])
  await assert.rejects(() => setConsent(actors.admin, { profileId: profile.id, publishProfile: true, publishContact: true }))
  await setConsent(actors.student, { profileId: profile.id, publishProfile: true, publishContact: false })
  assert.equal((await listProfiles(actors.other))[0]!.contactEmail, null)
  await setConsent(actors.student, { profileId: profile.id, publishProfile: true, publishContact: true })
  assert.equal((await listProfiles(actors.other))[0]!.contactEmail, 'private@example.test')
  await setConsent(actors.student, { profileId: profile.id, publishProfile: false, publishContact: false })
  assert.deepEqual(await listProfiles(actors.other), [])
})

test('event registration has a closed lifecycle and concurrent seats cannot exceed capacity', async () => {
  const actors = await college()
  await saveProfile(actors.admin, { userId: actors.student.id, graduationYear: 2024, qualification: 'BSc' })
  await saveProfile(actors.admin, { userId: actors.other.id, graduationYear: 2024, qualification: 'BSc' })
  const event = await createEvent(actors.admin, { title: 'Alumni reunion', startsOn: '2099-12-31', registrationDeadline: '2099-12-30', capacity: 1, venue: 'Main hall' })
  await assert.rejects(() => register(actors.student, { eventId: event.id }))
  await transitionEvent(actors.admin, { eventId: event.id, action: 'open' })
  const results = await Promise.allSettled([actors.student, actors.other].map(actor => register(actor, { eventId: event.id })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const existing = (await listRegistrations(actors.admin))[0]!
  await cancelRegistration(actors.admin, { registrationId: existing.id })
  await register(actors.other, { eventId: event.id })
  await transitionEvent(actors.admin, { eventId: event.id, action: 'cancel' })
  assert.ok((await listRegistrations(actors.admin)).every(row => row.status === 'cancelled'))
  await assert.rejects(() => register(actors.student, { eventId: event.id }))
})

test('profile and event references remain inside the institution', async () => {
  const actors = await college()
  const other = await college()
  await assert.rejects(() => saveProfile(actors.admin, { userId: other.student.id, graduationYear: 2024, qualification: 'BSc' }))
  const profile = await saveProfile(actors.admin, { userId: actors.student.id, graduationYear: 2024, qualification: 'BSc' })
  await assert.rejects(() => setConsent(other.student, { profileId: profile.id, publishProfile: true, publishContact: false }))
  assert.deepEqual(await listProfiles(other.admin), [])
  await assert.rejects(() => createEvent(actors.student, { title: 'Unauthorized', startsOn: '2099-12-31', registrationDeadline: '2099-12-30', capacity: 1, venue: 'Hall' }))
})
