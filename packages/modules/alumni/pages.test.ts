import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlugin, type PluginForm } from '@campusos/module-framework'
import { createEvent, register, saveProfile, transitionEvent } from './api'
import { pages } from './pages'
import plugin from './plugin'
import { specs } from './routes'
import { paths } from './api/openapi'
import { college } from './test-support.test'

test('alumni pages keep consent owner-only and wire event reservation and release', async () => {
  const actors = await college()
  const profile = await saveProfile(actors.admin, { userId: actors.student.id, graduationYear: 2024, qualification: 'BSc', contactEmail: 'graduate@example.test' })
  const event = await createEvent(actors.admin, { title: 'Graduate reunion', startsOn: '2099-12-31', registrationDeadline: '2099-12-30', capacity: 2, venue: 'Main hall' })
  await transitionEvent(actors.admin, { eventId: event.id, action: 'open' })
  await register(actors.student, { eventId: event.id })
  validatePlugin(plugin)
  assert.deepEqual(pages.map(page => page.path), ['/', '/events', '/registrations'])
  const forms = new Map<string, PluginForm>()
  for (const actor of [actors.admin, actors.student]) for (const page of pages) {
    const data = await page.load(actor, new Request('http://college.test/m/alumni' + page.path))
    for (const section of page.sections(data)) {
      if (section.kind === 'table') assert.ok(Array.isArray(data[section.rows]), section.rows)
      if (section.kind !== 'form') continue
      forms.set(section.path, section)
      assert.ok(section.roles?.includes(actor.role))
      assert.ok(specs.some(route => route.path === section.path && route.method === 'POST' && route.body))
      assert.ok(paths['/api/v1/modules/alumni' + section.path]?.post)
      for (const field of section.fields) if (typeof field.options === 'string') assert.ok(Array.isArray(data[field.options]))
    }
  }
  assert.deepEqual([...forms.keys()].sort(), specs.filter(route => route.method === 'POST').map(route => route.path).sort())
  const directory = pages[0]!
  const request = new Request('http://college.test/m/alumni')
  const admin = await directory.load(actors.admin, request)
  assert.ok(!directory.sections(admin).some(section => section.kind === 'form' && section.path === '/profiles/consent'))
  const publish = specs.find(route => route.path === '/profiles/consent')!
  await publish.handler(actors.student, new Request('http://college.test/api/v1/modules/alumni/profiles/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: profile.id, publishProfile: 'true', publishContact: 'false' }) }))
  const publicData = await directory.load(actors.other, request)
  assert.equal((publicData.profiles as { contactEmail: string | null }[])[0]!.contactEmail, null)
  const reservations = await pages[2]!.load(actors.other, request)
  assert.deepEqual(reservations.registrations, [])
})
