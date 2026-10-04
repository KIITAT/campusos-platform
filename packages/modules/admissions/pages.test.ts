import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDepartment, createProgram, createTerm } from '@campusos/module-academic/api'
import { pagesFor, validatePlugin, type PluginForm } from '@campusos/module-framework'
import { pages } from './pages'
import plugin from './plugin'
import { specs } from './routes'
import { paths } from './api/openapi'
import { college } from './test-support.test'

test('admissions pages load real choices and every form is covered by a documented route', async () => {
  const actors = await college()
  const department = await createDepartment(actors.admin, { name: 'Science', code: 'SCI' })
  await createProgram(actors.admin, { departmentId: department.id, code: 'BSC', name: 'Science', level: 'undergraduate', durationTerms: 6 })
  await createTerm(actors.admin, { name: 'Intake', code: 'INTAKE', startsOn: '2026-07-01', endsOn: '2027-06-30' })
  validatePlugin(plugin)
  assert.deepEqual(pagesFor(pages, 'student'), [])
  assert.deepEqual(pages.map(page => page.path), ['/', '/applications'])
  const request = (path: string, body: unknown) => new Request('http://college.test/api/v1/modules/admissions' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const enquiryRoute = specs.find(route => route.path === '/enquiries' && route.method === 'POST')!
  const enquiry = await enquiryRoute.handler(actors.admin, request('/enquiries', { name: 'Applicant', email: 'applicant@example.test' })) as { id: string }
  const forms: PluginForm[] = []
  for (const page of pages) {
    const data = await page.load(actors.admin, new Request('http://college.test/m/admissions' + page.path))
    for (const section of page.sections(data)) {
      if (section.kind === 'table') assert.ok(Array.isArray(data[section.rows]), section.rows)
      if (section.kind !== 'form') continue
      forms.push(section)
      assert.deepEqual(section.roles, ['institution_admin', 'super_admin'])
      const route = specs.find(route => route.path === section.path && route.method === 'POST')
      assert.ok(route?.body, section.path)
      assert.ok(paths['/api/v1/modules/admissions' + section.path]?.post)
      for (const field of section.fields) if (typeof field.options === 'string') assert.ok(Array.isArray(data[field.options]), field.options)
    }
  }
  assert.deepEqual(forms.map(form => form.path).sort(), specs.filter(route => route.method === 'POST').map(route => route.path).sort())
  const data = await pages[1]!.load(actors.admin, new Request('http://college.test/m/admissions/applications'))
  const choices = data as Record<string, { value: string }[]>
  assert.equal(choices.enquiryOptions![0]!.value, enquiry.id)
  assert.equal(choices.studentOptions!.length, 2)
  const create = specs.find(route => route.path === '/applications' && route.method === 'POST')!
  const application = await create.handler(actors.admin, request('/applications', { enquiryId: enquiry.id, programId: choices.programOptions![0]!.value, termId: choices.termOptions![0]!.value })) as { id: string }
  const decision = specs.find(route => route.path === '/applications/decision')!
  await decision.handler(actors.admin, request(decision.path, { applicationId: application.id, decision: 'offer', reason: 'Entry requirements met' }))
  const offered = await pages[1]!.load(actors.admin, new Request('http://college.test/m/admissions/applications'))
  assert.equal((offered.offeredOptions as { value: string }[])[0]!.value, application.id)
  await assert.rejects(() => pages[1]!.load(actors.student, new Request('http://college.test/m/admissions/applications')))
})
