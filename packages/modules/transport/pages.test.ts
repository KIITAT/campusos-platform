import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pagesFor, validatePlugin, type PluginForm } from '@campusos/module-framework'
import { addRoute, addStop, addVehicle, assign } from './api'
import { pages } from './pages'
import plugin from './plugin'
import { specs } from './routes'
import { paths } from './api/openapi'
import { college } from './test-support.test'

test('transport pages expose inventory to the office and only own assignments to students', async () => {
  const actors = await college()
  const vehicle = await addVehicle(actors.admin, { registration: 'PAGE-BUS', capacity: 2 })
  const route = await addRoute(actors.admin, { name: 'Library shuttle', vehicleId: vehicle.id })
  const stop = await addStop(actors.admin, { routeId: route.id, name: 'Main gate', position: 1 })
  await assign(actors.admin, { routeId: route.id, stopId: stop.id, studentId: actors.student.id })
  validatePlugin(plugin)
  assert.deepEqual(pagesFor(pages, 'student').map(page => page.path), ['/'])
  assert.deepEqual(pages.map(page => page.path), ['/', '/routes', '/vehicles'])
  const forms: PluginForm[] = []
  for (const page of pages) {
    const data = await page.load(actors.admin, new Request('http://college.test/m/transport' + page.path))
    for (const section of page.sections(data)) {
      if (section.kind === 'table') assert.ok(Array.isArray(data[section.rows]), section.rows)
      if (section.kind !== 'form') continue
      forms.push(section)
      assert.deepEqual(section.roles, ['institution_admin', 'super_admin'])
      assert.ok(specs.some(route => route.path === section.path && route.method === 'POST' && route.body), section.path)
      assert.ok(paths['/api/v1/modules/transport' + section.path]?.post)
      for (const field of section.fields) if (typeof field.options === 'string') assert.ok(Array.isArray(data[field.options]), field.options)
    }
  }
  assert.deepEqual(forms.map(form => form.path).sort(), specs.filter(route => route.method === 'POST').map(route => route.path).sort())
  const request = new Request('http://college.test/m/transport')
  const own = await pages[0]!.load(actors.student, request)
  assert.equal((own.assignments as unknown[]).length, 1)
  assert.equal(pages[0]!.sections(own).filter(section => section.kind === 'form').length, 0)
  assert.deepEqual((await pages[0]!.load(actors.other, request)).assignments, [])
  await assert.rejects(() => pages[1]!.load(actors.student, request))
  const release = specs.find(route => route.path === '/assignments/release')!
  const data = await pages[0]!.load(actors.admin, request)
  const choice = (data.assignmentOptions as { value: string }[])[0]!
  await release.handler(actors.admin, new Request('http://college.test/api/v1/modules/transport/assignments/release', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assignmentId: choice.value, reason: 'No longer required' }) }))
  assert.deepEqual((await pages[0]!.load(actors.admin, request)).assignmentOptions, [])
})
